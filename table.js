(function () {
  'use strict';

  var code = qs('r') || LS.get('lastRoom', '');
  var uid = null, ST = null, host = null, mySeat = -1;
  var roomRef = db.collection('rooms').doc(code);
  var raiseOpen = false, awardPick = {};

  document.getElementById('roomCode').textContent = code || '----';
  if (!code) { location.href = 'index.html'; return; }

  signIn().then(function (u) {
    uid = u;
    listenErrors();
    listenRoom();
    setInterval(ping, 20000);
  }).catch(function (e) {
    toast('登入失敗：Firebase 匿名登入沒開？', 'bad');
  });

  /* ================= 資料同步 ================= */
  function listenRoom() {
    roomRef.onSnapshot(function (snap) {
      if (!snap.exists) { toast('這桌不存在了', 'bad'); return; }
      var d = snap.data();
      ST = {
        status: d.status, settings: d.settings, seats: d.seats || [],
        hand: d.hand, pots: d.pots || [], pendingAward: d.pendingAward || null,
        log: d.log || [], lastResults: d.lastResults || null,
        hostUid: d.hostUid
      };
      mySeat = Engine.seatOf(ST, uid);

      var isHost = d.hostUid === uid;
      if (isHost && !host) {
        host = new Host(code, uid, function () {});
        host.start(JSON.parse(JSON.stringify(ST)));
        toast('你是這桌的房主，籌碼由你的裝置結算');
      } else if (!isHost && host) {
        host.stop(); host = null;
      }
      // 已經在跑的房主迴圈不吃回音，牠自己才是權威

      checkHeartbeat(d);
      render();
    }, function (e) {
      toast('連線問題：' + e.code, 'bad');
    });
  }

  function checkHeartbeat(d) {
    var btn = document.getElementById('takeoverBtn');
    var banner = document.getElementById('banner');
    if (d.hostUid === uid) { btn.style.display = 'none'; banner.style.display = 'none'; return; }
    var hb = d.hostHeartbeat && d.hostHeartbeat.toMillis ? d.hostHeartbeat.toMillis() : 0;
    var stale = Date.now() - hb > 15000;
    btn.style.display = stale ? '' : 'none';
    banner.style.display = stale ? '' : 'none';
    if (stale) banner.textContent = '房主斷線了，有人接管才能繼續';
  }

  document.getElementById('takeoverBtn').addEventListener('click', function () {
    roomRef.update({ hostUid: uid, hostHeartbeat: FV.serverTimestamp() })
      .then(function () { toast('你接管了牌桌'); })
      .catch(function () { toast('接管失敗，房主可能剛回來', 'bad'); });
  });

  function listenErrors() {
    roomRef.collection('errors').doc(uid).onSnapshot(function (s) {
      if (s.exists && s.data().msg) {
        toast(s.data().msg, 'bad');
        s.ref.delete().catch(function () {});
      }
    }, function () {});
  }

  function send(type, extra) {
    var a = { uid: uid, type: type, ts: FV.serverTimestamp() };
    if (extra) for (var k in extra) a[k] = extra[k];
    return roomRef.collection('actions').add(a).catch(function (e) {
      toast('送不出去：' + e.code, 'bad');
    });
  }
  function ping() { if (mySeat >= 0) send('ping'); }

  /* ================= 畫面 ================= */
  function render() {
    if (!ST) return;
    renderSeats();
    renderCenter();
    renderActions();
    if (document.getElementById('drawer').classList.contains('on')) renderDrawer();
  }

  function renderCenter() {
    document.getElementById('pot').textContent = fmt(Engine.potTotal(ST));
    var ph = ST.hand.phase === 'idle' ? '等待開牌' : Engine.phaseName(ST.hand.phase);
    document.getElementById('phase').textContent = ST.hand.no ? '第 ' + ST.hand.no + ' 手 · ' + ph : ph;
    var sp = '';
    if (ST.pots && ST.pots.length > 1) {
      sp = ST.pots.map(function (p, i) {
        return (i === 0 ? '主池' : '邊池' + i) + ' ' + fmt(p.amount);
      }).join('　');
    }
    document.getElementById('sidepots').textContent = sp;
  }

  function renderSeats() {
    var felt = document.getElementById('felt');
    Array.prototype.slice.call(felt.querySelectorAll('.seat')).forEach(function (n) { n.remove(); });

    var n = ST.seats.length;
    var base = mySeat >= 0 ? mySeat : 0;
    for (var i = 0; i < n; i++) {
      var d = ((i - base) % n + n) % n;
      var th = (90 + d * 360 / n) * Math.PI / 180;
      var x = 50 + 41 * Math.cos(th);
      var y = 50 + 37 * Math.sin(th);
      felt.appendChild(seatNode(i, x, y));
    }
  }

  function seatNode(i, x, y) {
    var p = ST.seats[i];
    var el = document.createElement('div');
    el.className = 'seat' + (p ? '' : ' empty') +
      (p && p.folded ? ' folded' : '') +
      (ST.hand.turnSeat === i ? ' turn' : '') +
      (i === mySeat ? ' me' : '');
    el.style.left = x + '%';
    el.style.top = y + '%';

    var tag = Engine.positionLabel(ST, i);
    var inner = '<div class="card">';
    if (!p) {
      inner += '<div class="nm" style="color:var(--ash)">空位</div><div class="st">' + (i + 1) + ' 號</div>';
    } else {
      inner += '<div class="nm">' + esc(p.name) + '</div>';
      inner += '<div class="ch">' + fmt(p.chips) + '</div>';
      if (p.allIn) inner += '<div class="allin">ALL IN</div>';
      else if (p.state === 'sitout') inner += '<div class="st">暫離</div>';
      else if (p.state === 'waiting') inner += '<div class="st">下一手</div>';
      else if (p.folded) inner += '<div class="st">已蓋牌</div>';
    }
    inner += '</div>';
    if (p && p.bet > 0) inner += '<div class="bet">' + fmt(p.bet) + '</div>';
    if (tag) inner += '<div class="tag">' + tag + '</div>';
    el.innerHTML = inner;

    if (!p && mySeat < 0) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () {
        var name = LS.get('nick', '') || prompt('你的名字？');
        if (!name) return;
        LS.set('nick', name);
        send('sit', { seat: i, name: String(name).slice(0, 12) });
      });
    }
    return el;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ================= 動作列 ================= */
  function renderActions() {
    var row = document.getElementById('actRow');
    var box = document.getElementById('raiseBox');

    if (mySeat < 0) {
      box.classList.remove('on');
      row.innerHTML = '<div class="waiting">點一個空位坐下</div>';
      return;
    }
    var me = ST.seats[mySeat];

    if (ST.hand.phase === 'showdown') {
      box.classList.remove('on');
      row.innerHTML = '<div class="waiting">攤牌中，等房主判定贏家</div>';
      return;
    }
    if (ST.hand.turnSeat !== mySeat) {
      box.classList.remove('on');
      raiseOpen = false;
      var msg = ST.hand.phase === 'idle' ? '等房主開下一手' : '等別人動作';
      if (me.state === 'waiting') msg = '下一手才輪到你';
      if (me.state === 'sitout') msg = '你目前暫離中';
      row.innerHTML = '<div class="waiting">' + msg + '</div>';
      return;
    }

    var L = Engine.legalMoves(ST, mySeat);
    var html = '<div class="act-row">';
    html += '<button class="btn danger" data-a="fold">蓋牌</button>';
    if (L.check) html += '<button class="btn ghost" data-a="check">過牌</button>';
    else html += '<button class="btn ghost" data-a="call">跟 ' + fmt(L.call) + '</button>';
    if (L.maxRaise > 0) {
      var label = ST.hand.currentBet === 0 ? '下注' : '加注';
      html += '<button class="btn" data-a="raiseOpen">' + label + '</button>';
    }
    html += '</div>';
    row.innerHTML = html;

    Array.prototype.slice.call(row.querySelectorAll('[data-a]')).forEach(function (b) {
      b.addEventListener('click', function () { onAct(b.getAttribute('data-a'), L); });
    });

    if (raiseOpen) setupRaise(L); else box.classList.remove('on');
  }

  function onAct(a, L) {
    if (a === 'raiseOpen') { raiseOpen = true; setupRaise(L); return; }
    raiseOpen = false;
    send(a);
  }

  function setupRaise(L) {
    var box = document.getElementById('raiseBox');
    var val = document.getElementById('raiseVal');
    var sl = document.getElementById('raiseSlider');
    box.classList.add('on');

    sl.min = L.minRaise; sl.max = L.maxRaise; sl.step = 1;
    if (!val.value || +val.value < L.minRaise || +val.value > L.maxRaise) val.value = L.minRaise;
    sl.value = val.value;

    sl.oninput = function () { val.value = sl.value; };
    val.oninput = function () { sl.value = val.value; };

    Array.prototype.slice.call(box.querySelectorAll('[data-q]')).forEach(function (b) {
      b.onclick = function () {
        var pot = Engine.potTotal(ST);
        var q = b.getAttribute('data-q'), v;
        if (q === 'min') v = L.minRaise;
        else if (q === 'half') v = ST.hand.currentBet + Math.round(pot / 2);
        else if (q === 'pot') v = ST.hand.currentBet + pot;
        else v = L.maxRaise;
        v = Math.max(L.minRaise, Math.min(L.maxRaise, Math.round(v)));
        val.value = v; sl.value = v;
      };
    });

    document.getElementById('raiseCancel').onclick = function () {
      raiseOpen = false; box.classList.remove('on');
    };

    var row = document.getElementById('actRow');
    if (!row.querySelector('[data-a="confirmRaise"]')) {
      var b = document.createElement('button');
      b.className = 'btn';
      b.style.marginTop = '8px';
      b.setAttribute('data-a', 'confirmRaise');
      b.textContent = '確認';
      b.onclick = function () {
        var v = Math.round(+val.value);
        raiseOpen = false;
        send(v >= L.maxRaise ? 'allin' : 'raise', { amount: v });
      };
      row.appendChild(b);
    }
  }

  /* ================= 房主抽屜 ================= */
  var drawer = document.getElementById('drawer');
  document.getElementById('drawerBtn').addEventListener('click', function () {
    drawer.classList.add('on'); renderDrawer();
  });
  drawer.addEventListener('click', function (e) {
    if (e.target === drawer) drawer.classList.remove('on');
  });

  function renderDrawer() {
    var isHost = ST && ST.hostUid === uid;
    var el = document.getElementById('drawerInner');
    var h = '<h3>' + (isHost ? '房主控制台' : '牌桌') + '</h3>';
    h += '<p class="hint">房號 ' + code + '</p>';

    if (isHost && ST.pendingAward) {
      h += '<div class="sec">選出贏家</div>';
      ST.pendingAward.pots.forEach(function (p, i) {
        var done = ST.pendingAward.resolved[i];
        h += '<div class="pot-award"><div class="h">' +
          (i === 0 ? '主池' : '邊池 ' + i) + ' · ' + fmt(p.amount) + '</div>';
        if (done) {
          h += '<div class="hint">已分給 ' + done.map(function (s) {
            return esc(ST.seats[s] ? ST.seats[s].name : '?');
          }).join('、') + '</div>';
        } else {
          h += '<div class="winner-pick">';
          p.eligible.forEach(function (s) {
            var on = (awardPick[i] || []).indexOf(s) >= 0;
            h += '<button class="' + (on ? 'on' : '') + '" data-pot="' + i + '" data-seat="' + s + '">' +
              esc(ST.seats[s] ? ST.seats[s].name : '?') + '</button>';
          });
          h += '</div><button class="btn" style="margin-top:10px" data-award="' + i + '">確認分池</button>';
        }
        h += '</div>';
      });
    }

    if (isHost) {
      h += '<div class="sec">牌局</div>';
      if (ST.hand.phase === 'idle') {
        h += '<button class="btn" id="startHand">開始下一手</button>';
        h += '<div class="field" style="margin-top:10px"><label>指定莊家位（第一手用）</label><select id="forceDealer"><option value="-1">自動輪莊</option>';
        ST.seats.forEach(function (s, i) {
          if (s && s.state === 'playing') h += '<option value="' + i + '">' + (i + 1) + ' 號 · ' + esc(s.name) + '</option>';
        });
        h += '</select></div>';
      } else {
        h += '<p class="hint">牌局進行中。位置調整會排到下一手。</p>';
      }

      h += '<div class="sec">規則</div>';
      h += '<div class="row"><div class="field"><label>小盲</label><input id="setSb" type="number" value="' + ST.settings.sb + '"></div>' +
        '<div class="field"><label>大盲</label><input id="setBb" type="number" value="' + ST.settings.bb + '"></div></div>';
      h += '<div class="field"><label>中途加入</label><select id="setLate">' +
        '<option value="postBB"' + (ST.settings.lateEntry === 'postBB' ? ' selected' : '') + '>補大盲，立刻可以玩</option>' +
        '<option value="waitBB"' + (ST.settings.lateEntry === 'waitBB' ? ' selected' : '') + '>等 button 繞過你</option></select></div>';
      h += '<div class="field"><label>入座方式</label><select id="setJoin">' +
        '<option value="anyone"' + (ST.settings.joinMode === 'anyone' ? ' selected' : '') + '>誰都能自己選位</option>' +
        '<option value="hostOnly"' + (ST.settings.joinMode === 'hostOnly' ? ' selected' : '') + '>鎖住，只有房主能安排</option></select></div>';
      h += '<button class="btn ghost" id="saveSettings">儲存規則</button>';

      h += '<div class="sec">座位</div>';
      ST.seats.forEach(function (s, i) {
        if (!s) return;
        h += '<div class="seat-admin"><span class="nm">' + (i + 1) + '　' + esc(s.name) + '　<span style="color:var(--gold)">' + fmt(s.chips) + '</span></span>' +
          '<button data-add="' + i + '">補碼</button>' +
          '<button data-mv="' + i + '">搬位</button>' +
          '<button data-kick="' + i + '">踢出</button></div>';
      });
    }

    h += '<div class="sec">紀錄</div><div class="logbox">' +
      (ST.log || []).slice().reverse().map(function (l) { return esc(l.text); }).join('<br>') +
      '</div>';

    h += '<div class="sec">你</div>';
    if (mySeat >= 0) {
      var me = ST.seats[mySeat];
      h += '<button class="btn ghost" id="toggleSitout">' + (me.state === 'sitout' ? '回到牌桌' : '暫離一下') + '</button>';
      h += '<button class="btn danger" style="margin-top:8px" id="leaveTable">離開牌桌</button>';
    }
    h += '<button class="btn ghost" style="margin-top:8px" id="backLobby">回大廳</button>';

    el.innerHTML = h;
    bindDrawer(isHost);
  }

  function bindDrawer(isHost) {
    var el = document.getElementById('drawerInner');
    var $ = function (id) { return document.getElementById(id); };

    if ($('backLobby')) $('backLobby').onclick = function () { location.href = 'index.html'; };
    if ($('toggleSitout')) $('toggleSitout').onclick = function () {
      send('sitout', { value: ST.seats[mySeat].state !== 'sitout' });
      drawer.classList.remove('on');
    };
    if ($('leaveTable')) $('leaveTable').onclick = function () {
      if (confirm('確定離開？籌碼會留在桌上紀錄。')) { send('leave'); drawer.classList.remove('on'); }
    };
    if (!isHost || !host) return;

    if ($('startHand')) $('startHand').onclick = function () {
      var fd = +($('forceDealer') ? $('forceDealer').value : -1);
      host.hostOp(function (st, E) { E.startHand(st, fd >= 0 ? fd : undefined); })
        .then(function () { drawer.classList.remove('on'); })
        .catch(function (e) { toast(e.message, 'bad'); });
    };

    if ($('saveSettings')) $('saveSettings').onclick = function () {
      var sb = Math.max(1, +$('setSb').value), bb = Math.max(sb + 1, +$('setBb').value);
      var late = $('setLate').value, join = $('setJoin').value;
      host.hostOp(function (st) {
        st.settings.sb = sb; st.settings.bb = bb;
        st.settings.lateEntry = late; st.settings.joinMode = join;
      }).then(function () { toast('規則已更新，下一手生效'); });
    };

    Array.prototype.slice.call(el.querySelectorAll('[data-pot]')).forEach(function (b) {
      b.onclick = function () {
        var pi = +b.getAttribute('data-pot'), s = +b.getAttribute('data-seat');
        awardPick[pi] = awardPick[pi] || [];
        var k = awardPick[pi].indexOf(s);
        if (k >= 0) awardPick[pi].splice(k, 1); else awardPick[pi].push(s);
        renderDrawer();
      };
    });

    Array.prototype.slice.call(el.querySelectorAll('[data-award]')).forEach(function (b) {
      b.onclick = function () {
        var pi = +b.getAttribute('data-award');
        var w = awardPick[pi] || [];
        if (!w.length) return toast('先點贏家', 'bad');
        host.hostOp(function (st, E) { E.award(st, pi, w); })
          .then(function () { awardPick = {}; renderDrawer(); })
          .catch(function (e) { toast(e.message, 'bad'); });
      };
    });

    Array.prototype.slice.call(el.querySelectorAll('[data-add]')).forEach(function (b) {
      b.onclick = function () {
        var i = +b.getAttribute('data-add');
        var v = prompt('補多少籌碼給 ' + ST.seats[i].name + '？', ST.settings.startingChips);
        if (!v) return;
        host.hostOp(function (st, E) { E.addChips(st, i, Math.round(+v)); })
          .then(renderDrawer).catch(function (e) { toast(e.message, 'bad'); });
      };
    });

    Array.prototype.slice.call(el.querySelectorAll('[data-mv]')).forEach(function (b) {
      b.onclick = function () {
        var i = +b.getAttribute('data-mv');
        var v = prompt('搬到幾號位？（1-' + ST.seats.length + '）');
        if (!v) return;
        var to = Math.round(+v) - 1;
        host.hostOp(function (st, E) { E.move(st, i, to); })
          .then(renderDrawer).catch(function (e) { toast(e.message, 'bad'); });
      };
    });

    Array.prototype.slice.call(el.querySelectorAll('[data-kick]')).forEach(function (b) {
      b.onclick = function () {
        var i = +b.getAttribute('data-kick');
        if (!confirm('把 ' + ST.seats[i].name + ' 踢出去？')) return;
        host.hostOp(function (st, E) { E.leave(st, i); })
          .then(renderDrawer).catch(function (e) { toast(e.message, 'bad'); });
      };
    });
  }

  window.addEventListener('resize', function () { if (ST) renderSeats(); });
})();
