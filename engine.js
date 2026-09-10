/* engine.js — 純籌碼引擎，不碰 Firebase。
   輸入 state + action，輸出新的 state。可以單獨測試。 */
(function (g) {
  'use strict';
  var E = {};

  var PHASES = ['preflop', 'flop', 'turn', 'river'];

  E.defaultSettings = function () {
    return {
      seatCount: 9,
      sb: 25,
      bb: 50,
      startingChips: 5000,
      joinMode: 'anyone',      // anyone | hostOnly
      lateEntry: 'postBB',     // postBB | waitBB
      disconnectSec: 30
    };
  };

  E.newRoom = function (settings) {
    return {
      status: 'lobby',
      settings: settings,
      seats: Array.from({ length: settings.seatCount }, function () { return null; }),
      hand: {
        no: 0, dealerSeat: -1, sbSeat: -1, bbSeat: -1,
        phase: 'idle', turnSeat: -1, currentBet: 0, minRaise: settings.bb
      },
      pots: [],
      pendingAward: null,
      log: []
    };
  };

  E.newPlayer = function (uid, name, chips, seat) {
    return {
      uid: uid, name: name, chips: chips, seat: seat,
      bet: 0, committed: 0,
      folded: false, allIn: false, acted: false,
      state: 'waiting',        // playing | waiting | sitout
      waitFromDealer: -1,
      lastSeen: Date.now()
    };
  };

  /* ---------- 查詢 ---------- */
  function inHand(s) { return s && s.state === 'playing' && !s.folded; }
  function canAct(s) { return inHand(s) && !s.allIn && s.chips > 0; }
  function seatedPlaying(s) { return s && s.state === 'playing'; }

  function countWhere(seats, fn) {
    var c = 0;
    for (var i = 0; i < seats.length; i++) if (fn(seats[i])) c++;
    return c;
  }

  function nextIdx(seats, from, pred) {
    var n = seats.length;
    for (var k = 1; k <= n; k++) {
      var i = ((from % n) + n + k) % n;
      if (pred(seats[i], i)) return i;
    }
    return -1;
  }

  /* 從 a 出發往前走，是否會在到達 b 之前（含 b）經過 x */
  function arcContains(n, a, b, x) {
    for (var k = 1; k <= n; k++) {
      var i = (a + k) % n;
      if (i === x) return true;
      if (i === b) return false;
    }
    return false;
  }

  E.seatOf = function (st, uid) {
    for (var i = 0; i < st.seats.length; i++) if (st.seats[i] && st.seats[i].uid === uid) return i;
    return -1;
  };

  function log(st, text) {
    st.log = (st.log || []).concat([{ t: Date.now(), text: text }]).slice(-25);
  }

  /* ---------- 入座 / 離座 ---------- */
  E.sit = function (st, uid, name, seat) {
    if (seat < 0 || seat >= st.seats.length) throw new Error('座位不存在');
    if (st.seats[seat]) throw new Error('這個位子有人了');
    if (E.seatOf(st, uid) >= 0) throw new Error('你已經在桌上了');
    var p = E.newPlayer(uid, name, st.settings.startingChips, seat);
    if (st.hand.phase === 'idle') {
      p.state = 'playing';
    } else {
      p.state = 'waiting';
      p.waitFromDealer = st.hand.dealerSeat;
    }
    st.seats[seat] = p;
    log(st, name + ' 坐上 ' + (seat + 1) + ' 號位');
    return st;
  };

  E.leave = function (st, seat) {
    var p = st.seats[seat];
    if (!p) return st;
    if (st.hand.phase !== 'idle' && inHand(p)) {
      p.folded = true; p.acted = true;
      p.state = 'sitout';
      log(st, p.name + ' 離桌（視同蓋牌）');
      if (st.hand.turnSeat === seat) advanceTurnOrStreet(st);
      return st;
    }
    log(st, p.name + ' 離桌');
    st.seats[seat] = null;
    return st;
  };

  E.move = function (st, from, to) {
    if (st.hand.phase !== 'idle') throw new Error('牌局進行中不能換位，下一手才生效');
    if (!st.seats[from]) throw new Error('那個位子沒人');
    if (st.seats[to]) throw new Error('目標位子有人');
    st.seats[to] = st.seats[from];
    st.seats[to].seat = to;
    st.seats[from] = null;
    log(st, st.seats[to].name + ' 換到 ' + (to + 1) + ' 號位');
    return st;
  };

  E.setSitout = function (st, seat, out) {
    var p = st.seats[seat];
    if (!p) return st;
    if (out) {
      if (inHand(p) && st.hand.phase !== 'idle') { p.folded = true; p.acted = true; }
      p.state = 'sitout';
      log(st, p.name + ' 暫離');
      if (st.hand.turnSeat === seat) advanceTurnOrStreet(st);
    } else {
      p.state = st.hand.phase === 'idle' ? 'playing' : 'waiting';
      p.waitFromDealer = st.hand.dealerSeat;
      log(st, p.name + ' 回桌');
    }
    return st;
  };

  E.addChips = function (st, seat, amount) {
    var p = st.seats[seat];
    if (!p) throw new Error('那個位子沒人');
    p.chips += amount;
    if (p.state === 'sitout' && p.chips > 0) {
      p.state = st.hand.phase === 'idle' ? 'playing' : 'waiting';
      p.waitFromDealer = st.hand.dealerSeat;
    }
    log(st, p.name + ' 補碼 ' + amount);
    return st;
  };

  /* ---------- 開新一手 ---------- */
  E.startHand = function (st, forcedDealer) {
    if (st.hand.phase !== 'idle') throw new Error('上一手還沒結束');
    var n = st.seats.length, i;

    // 沒籌碼的自動暫離
    for (i = 0; i < n; i++) {
      var s = st.seats[i];
      if (s && s.chips <= 0 && s.state !== 'sitout') { s.state = 'sitout'; }
    }

    var prevDealer = st.hand.dealerSeat;
    var dealerSeat;
    if (typeof forcedDealer === 'number' && forcedDealer >= 0) {
      if (!seatedPlaying(st.seats[forcedDealer])) throw new Error('指定的莊家位沒有在玩的人');
      dealerSeat = forcedDealer;
    } else {
      dealerSeat = nextIdx(st.seats, prevDealer < 0 ? n - 1 : prevDealer, seatedPlaying);
    }
    if (dealerSeat < 0) throw new Error('桌上人不夠');

    // 補位者入場判定
    for (i = 0; i < n; i++) {
      var w = st.seats[i];
      if (!w || w.state !== 'waiting' || w.chips <= 0) continue;
      if (st.settings.lateEntry === 'postBB') {
        w.state = 'playing';
        w.pendingDead = st.settings.bb;   // 補一個大盲當死錢
      } else {
        var from = w.waitFromDealer < 0 ? prevDealer : w.waitFromDealer;
        if (from < 0 || arcContains(n, from, dealerSeat, i) || from === dealerSeat) {
          w.state = 'playing';
        }
      }
    }

    var playing = [];
    for (i = 0; i < n; i++) if (seatedPlaying(st.seats[i]) && st.seats[i].chips > 0) playing.push(i);
    if (playing.length < 2) throw new Error('至少要兩個有籌碼的人才能開牌');
    if (!seatedPlaying(st.seats[dealerSeat]) || st.seats[dealerSeat].chips <= 0) {
      dealerSeat = nextIdx(st.seats, dealerSeat, function (s) { return seatedPlaying(s) && s.chips > 0; });
    }

    var headsUp = playing.length === 2;
    var sbSeat, bbSeat;
    if (headsUp) {
      sbSeat = dealerSeat;
      bbSeat = nextIdx(st.seats, dealerSeat, function (s) { return seatedPlaying(s) && s.chips > 0; });
    } else {
      sbSeat = nextIdx(st.seats, dealerSeat, function (s) { return seatedPlaying(s) && s.chips > 0; });
      bbSeat = nextIdx(st.seats, sbSeat, function (s) { return seatedPlaying(s) && s.chips > 0; });
    }

    // 重置
    for (i = 0; i < n; i++) {
      var p = st.seats[i];
      if (!p) continue;
      p.bet = 0; p.committed = 0; p.folded = false; p.allIn = false; p.acted = false;
      if (p.state === 'playing' && p.chips <= 0) p.state = 'sitout';
    }

    st.hand = {
      no: st.hand.no + 1,
      dealerSeat: dealerSeat, sbSeat: sbSeat, bbSeat: bbSeat,
      phase: 'preflop', turnSeat: -1,
      currentBet: 0, minRaise: st.settings.bb
    };
    st.pots = [];
    st.pendingAward = null;
    st.status = 'playing';

    // 死錢（補大盲入場）
    for (i = 0; i < n; i++) {
      var d = st.seats[i];
      if (d && d.pendingDead && i !== sbSeat && i !== bbSeat) {
        var amt = Math.min(d.pendingDead, d.chips);
        d.chips -= amt; d.committed += amt;
        if (d.chips === 0) d.allIn = true;
        log(st, d.name + ' 補大盲入場 ' + amt);
      }
      if (d) delete d.pendingDead;
    }

    postBlind(st, sbSeat, st.settings.sb, '小盲');
    postBlind(st, bbSeat, st.settings.bb, '大盲');
    st.hand.currentBet = st.settings.bb;
    st.hand.minRaise = st.settings.bb;

    st.hand.turnSeat = headsUp
      ? sbSeat
      : nextIdx(st.seats, bbSeat, canAct);

    if (st.hand.turnSeat < 0) settleStreet(st);
    log(st, '— 第 ' + st.hand.no + ' 手開始，莊家 ' + (dealerSeat + 1) + ' 號位 —');
    return st;
  };

  function postBlind(st, seat, amount, label) {
    var p = st.seats[seat];
    if (!p) return;
    var pay = Math.min(amount, p.chips);
    p.chips -= pay; p.bet += pay;
    if (p.chips === 0) p.allIn = true;
    log(st, p.name + ' ' + label + ' ' + pay);
  }

  /* ---------- 玩家動作 ---------- */
  E.act = function (st, seat, type, amount) {
    var p = st.seats[seat];
    if (!p) throw new Error('那個位子沒人');
    if (st.hand.phase === 'idle' || st.hand.phase === 'showdown') throw new Error('現在不能動作');
    if (st.hand.turnSeat !== seat) throw new Error('還沒輪到你');
    if (!canAct(p)) throw new Error('你現在不能動作');

    var need = st.hand.currentBet - p.bet;

    if (type === 'fold') {
      p.folded = true; p.acted = true;
      log(st, p.name + ' 蓋牌');

    } else if (type === 'check') {
      if (need > 0) throw new Error('有人下注了，不能過牌');
      p.acted = true;
      log(st, p.name + ' 過牌');

    } else if (type === 'call') {
      var pay = Math.min(need, p.chips);
      p.chips -= pay; p.bet += pay; p.acted = true;
      if (p.chips === 0) p.allIn = true;
      log(st, p.name + (pay === 0 ? ' 過牌' : (p.allIn ? ' 全下跟注 ' : ' 跟注 ') + fmtn(pay)));

    } else if (type === 'raise' || type === 'bet' || type === 'allin') {
      var target;
      if (type === 'allin') {
        target = p.bet + p.chips;
      } else {
        target = Math.round(amount);
        if (!(target > 0)) throw new Error('金額不對');
        if (target > p.bet + p.chips) throw new Error('籌碼不夠');
      }
      var isAllIn = target === p.bet + p.chips;

      // 全下但蓋不過目前注額 → 等同全下跟注，不是加注
      if (target <= st.hand.currentBet) {
        if (!isAllIn) throw new Error('加注要大於目前注額');
        var short = p.chips;
        p.chips = 0; p.bet += short; p.allIn = true; p.acted = true;
        log(st, p.name + ' 全下跟注 ' + fmtn(short));
        advanceTurnOrStreet(st);
        return st;
      }

      var inc = target - st.hand.currentBet;
      if (inc < st.hand.minRaise && !isAllIn) {
        throw new Error('最少要加到 ' + fmtn(st.hand.currentBet + st.hand.minRaise));
      }
      var delta = target - p.bet;
      p.chips -= delta; p.bet = target;
      if (p.chips === 0) p.allIn = true;

      if (inc >= st.hand.minRaise) {
        st.hand.minRaise = inc;
        // 完整加注 → 其他人重新取得行動權
        for (var i = 0; i < st.seats.length; i++) {
          var o = st.seats[i];
          if (o && i !== seat && canAct(o)) o.acted = false;
        }
      }
      st.hand.currentBet = target;
      p.acted = true;
      log(st, p.name + (p.allIn ? ' 全下 ' : ' 加注到 ') + fmtn(target));

    } else {
      throw new Error('未知的動作');
    }

    advanceTurnOrStreet(st);
    return st;
  };

  function fmtn(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* ---------- 流程推進 ---------- */
  function roundDone(st) {
    var live = [];
    for (var i = 0; i < st.seats.length; i++) if (canAct(st.seats[i])) live.push(st.seats[i]);
    if (countWhere(st.seats, inHand) <= 1) return true;
    if (live.length === 0) return true;
    for (var j = 0; j < live.length; j++) {
      if (!live[j].acted || live[j].bet !== st.hand.currentBet) return false;
    }
    return true;
  }

  function advanceTurnOrStreet(st) {
    if (countWhere(st.seats, inHand) <= 1) { settleStreet(st); return; }
    if (roundDone(st)) { settleStreet(st); return; }
    var nxt = nextIdx(st.seats, st.hand.turnSeat, canAct);
    st.hand.turnSeat = nxt;
    if (nxt < 0) settleStreet(st);
  }

  function collectBets(st) {
    for (var i = 0; i < st.seats.length; i++) {
      var p = st.seats[i];
      if (!p) continue;
      p.committed += p.bet;
      p.bet = 0;
      p.acted = false;
    }
    st.hand.currentBet = 0;
    st.hand.minRaise = st.settings.bb;
  }

  function settleStreet(st) {
    collectBets(st);

    // 只剩一個人沒蓋牌 → 直接結算
    if (countWhere(st.seats, inHand) <= 1) {
      var winner = -1;
      for (var i = 0; i < st.seats.length; i++) if (inHand(st.seats[i])) winner = i;
      st.pots = E.buildPots(st.seats);
      st.hand.phase = 'showdown';
      st.hand.turnSeat = -1;
      if (winner >= 0) {
        st.pendingAward = { pots: st.pots, resolved: st.pots.map(function () { return null; }) };
        for (var k = 0; k < st.pots.length; k++) E.award(st, k, [winner]);
      }
      return;
    }

    var canActCount = countWhere(st.seats, canAct);
    var idx = PHASES.indexOf(st.hand.phase);

    // 大家都 all-in → 直接跳到攤牌
    if (canActCount <= 1) {
      var stillNeeds = false;
      for (var m = 0; m < st.seats.length; m++) {
        var q = st.seats[m];
        if (canAct(q) && q.committed < maxCommitted(st)) stillNeeds = true;
      }
      if (!stillNeeds) { toShowdown(st); return; }
    }

    if (idx >= PHASES.length - 1) { toShowdown(st); return; }

    st.hand.phase = PHASES[idx + 1];
    var first = nextIdx(st.seats, st.hand.dealerSeat, canAct);
    st.hand.turnSeat = countWhere(st.seats, canAct) >= 2 ? first : -1;
    log(st, '— ' + phaseName(st.hand.phase) + ' —');
    if (st.hand.turnSeat < 0) settleStreet(st);
  }

  function maxCommitted(st) {
    var mx = 0;
    for (var i = 0; i < st.seats.length; i++) {
      var p = st.seats[i];
      if (p && inHand(p)) mx = Math.max(mx, p.committed);
    }
    return mx;
  }

  function phaseName(p) {
    return { preflop: '翻牌前', flop: '翻牌', turn: '轉牌', river: '河牌', showdown: '攤牌' }[p] || p;
  }
  E.phaseName = phaseName;

  function toShowdown(st) {
    st.hand.phase = 'showdown';
    st.hand.turnSeat = -1;
    st.pots = E.buildPots(st.seats);
    st.pendingAward = { pots: st.pots, resolved: st.pots.map(function () { return null; }) };
    log(st, '— 攤牌，請房主選出贏家 —');
  }

  /* ---------- 邊池 ---------- */
  E.buildPots = function (seats) {
    var contrib = seats.map(function (s) { return s ? s.committed + s.bet : 0; });
    var alive = seats.map(function (s) { return !!(s && s.state === 'playing' && !s.folded); });

    var levels = [];
    contrib.forEach(function (c) { if (c > 0 && levels.indexOf(c) < 0) levels.push(c); });
    levels.sort(function (a, b) { return a - b; });

    var pots = [], prev = 0;
    levels.forEach(function (lv) {
      var amount = 0, elig = [];
      contrib.forEach(function (c, i) {
        amount += Math.min(c, lv) - Math.min(c, prev);
        if (c >= lv && alive[i]) elig.push(i);
      });
      if (amount > 0) pots.push({ amount: amount, eligible: elig });
      prev = lv;
    });

    // 合併資格相同的相鄰池
    var merged = [];
    pots.forEach(function (p) {
      var last = merged[merged.length - 1];
      if (last && last.eligible.join(',') === p.eligible.join(',')) last.amount += p.amount;
      else merged.push({ amount: p.amount, eligible: p.eligible.slice() });
    });
    return merged;
  };

  /* ---------- 分池 ---------- */
  E.award = function (st, potIndex, winnerSeats) {
    if (!st.pendingAward) throw new Error('現在沒有要分的池');
    var pot = st.pendingAward.pots[potIndex];
    if (!pot) throw new Error('池不存在');
    if (st.pendingAward.resolved[potIndex]) throw new Error('這個池已經分過了');
    if (!winnerSeats.length) throw new Error('要選至少一個贏家');
    for (var i = 0; i < winnerSeats.length; i++) {
      if (pot.eligible.indexOf(winnerSeats[i]) < 0) throw new Error('有人沒有這個池的資格');
    }

    var each = Math.floor(pot.amount / winnerSeats.length);
    var rem = pot.amount - each * winnerSeats.length;
    var ordered = orderFromDealer(st, winnerSeats);
    ordered.forEach(function (seat, k) {
      st.seats[seat].chips += each + (k < rem ? 1 : 0);
    });
    st.pendingAward.resolved[potIndex] = ordered.slice();
    log(st, (potIndex === 0 ? '主池 ' : '邊池' + potIndex + ' ') + fmtn(pot.amount) + ' → ' +
      ordered.map(function (s) { return st.seats[s].name; }).join('、'));

    var allDone = st.pendingAward.resolved.every(function (r) { return !!r; });
    if (allDone) endHand(st);
    return st;
  };

  function orderFromDealer(st, seats) {
    var n = st.seats.length, d = st.hand.dealerSeat;
    return seats.slice().sort(function (a, b) {
      return ((a - d + n) % n) - ((b - d + n) % n);
    });
  }

  function endHand(st) {
    var results = [];
    for (var i = 0; i < st.seats.length; i++) {
      var p = st.seats[i];
      if (!p) continue;
      results.push({ uid: p.uid, name: p.name, spent: p.committed + p.bet, chips: p.chips });
      p.bet = 0; p.committed = 0; p.folded = false; p.allIn = false; p.acted = false;
      if (p.chips <= 0) p.state = 'sitout';
      else if (p.state === 'playing') p.state = 'playing';
    }
    st.hand.phase = 'idle';
    st.hand.turnSeat = -1;
    st.pots = [];
    st.pendingAward = null;
    st.lastResults = results;
  }

  /* ---------- 給 UI 用的輔助 ---------- */
  E.potTotal = function (st) {
    var t = 0;
    for (var i = 0; i < st.seats.length; i++) {
      var p = st.seats[i];
      if (p) t += p.committed + p.bet;
    }
    return t;
  };

  E.legalMoves = function (st, seat) {
    var p = st.seats[seat];
    var out = { fold: false, check: false, call: 0, minRaise: 0, maxRaise: 0 };
    if (!p || st.hand.turnSeat !== seat || !canAct(p)) return out;
    var need = st.hand.currentBet - p.bet;
    out.fold = true;
    out.check = need === 0;
    out.call = Math.min(need, p.chips);
    out.maxRaise = p.bet + p.chips;
    var min = st.hand.currentBet + st.hand.minRaise;
    out.minRaise = Math.min(min, out.maxRaise);
    if (out.maxRaise <= st.hand.currentBet) { out.minRaise = 0; out.maxRaise = 0; }
    return out;
  };

  E.positionLabel = function (st, seat) {
    if (st.hand.phase === 'idle') return '';
    if (seat === st.hand.dealerSeat) return 'D';
    if (seat === st.hand.sbSeat) return 'SB';
    if (seat === st.hand.bbSeat) return 'BB';
    return '';
  };

  g.Engine = E;
})(window);
