/* host.js — 房主端權威迴圈。
   玩家只能往 actions 子集合寫「意圖」，這裡負責算籌碼、寫回牌桌。 */
(function (g) {
  'use strict';

  function clean(o) { return JSON.parse(JSON.stringify(o)); }

  function Host(code, uid, onState) {
    this.code = code;
    this.uid = uid;
    this.onState = onState || function () {};
    this.state = null;
    this.queue = Promise.resolve();
    this.unsubs = [];
    this.running = false;
  }

  Host.prototype.roomRef = function () { return db.collection('rooms').doc(this.code); };

  Host.prototype.start = function (initialState) {
    var self = this;
    this.state = initialState;
    this.running = true;
    window.__isHost = true;
    keepAwake();

    // 心跳
    this.beat();
    this.beatTimer = setInterval(function () { self.beat(); }, 5000);

    // 監聽玩家送來的動作
    this.seen = {};
    var un = this.roomRef().collection('actions').orderBy('ts', 'asc')
      .onSnapshot(function (snap) {
        snap.docChanges().forEach(function (ch) {
          if (ch.type === 'removed') return;
          var doc = ch.doc;
          // serverTimestamp 還沒回來的先跳過，等它落地再處理，順序才不會亂
          if (!doc.data().ts) return;
          if (self.seen[doc.id]) return;
          self.seen[doc.id] = true;
          self.enqueue(doc);
        });
      }, function (e) { console.warn('actions listener', e); });
    this.unsubs.push(un);
    return this;
  };

  Host.prototype.stop = function () {
    this.running = false;
    window.__isHost = false;
    clearInterval(this.beatTimer);
    this.unsubs.forEach(function (u) { try { u(); } catch (e) {} });
    this.unsubs = [];
  };

  Host.prototype.beat = function () {
    this.roomRef().update({ hostHeartbeat: FV.serverTimestamp() }).catch(function () {});
  };

  /* 序列化處理，避免兩個動作同時改狀態 */
  Host.prototype.enqueue = function (doc) {
    var self = this;
    this.queue = this.queue.then(function () {
      return self.process(doc);
    }).catch(function (e) { console.warn('process fail', e); });
    return this.queue;
  };

  Host.prototype.process = function (doc) {
    var self = this, a = doc.data();
    var err = null;
    try {
      self.applyAction(a);
    } catch (e) {
      err = e.message || String(e);
    }
    var writes = [];
    if (err) {
      writes.push(self.roomRef().collection('errors').doc(a.uid).set({
        msg: err, at: FV.serverTimestamp(), action: a.type
      }));
    } else {
      writes.push(self.flush());
    }
    writes.push(doc.ref.delete().catch(function () {}));
    return Promise.all(writes);
  };

  Host.prototype.applyAction = function (a) {
    var st = this.state, E = Engine;
    var seat = E.seatOf(st, a.uid);

    switch (a.type) {
      case 'sit':
        if (st.settings.joinMode === 'hostOnly' && a.uid !== st.hostUid) throw new Error('房主鎖住了自由入座');
        E.sit(st, a.uid, (a.name || '玩家').slice(0, 12), a.seat);
        break;
      case 'leave':
        if (seat < 0) throw new Error('你不在桌上');
        E.leave(st, seat);
        break;
      case 'sitout':
        if (seat < 0) throw new Error('你不在桌上');
        E.setSitout(st, seat, !!a.value);
        break;
      case 'fold': case 'check': case 'call': case 'raise': case 'allin':
        if (seat < 0) throw new Error('你不在桌上');
        E.act(st, seat, a.type, a.amount);
        break;
      case 'ping':
        if (seat >= 0) st.seats[seat].lastSeen = Date.now();
        break;
      default:
        throw new Error('未知動作 ' + a.type);
    }
  };

  /* 房主自己的操作直接走這裡 */
  Host.prototype.hostOp = function (fn) {
    var self = this;
    this.queue = this.queue.then(function () {
      fn(self.state, Engine);
      return self.flush();
    });
    return this.queue;
  };

  Host.prototype.flush = function () {
    var st = clean(this.state);
    this.onState(st);
    return this.roomRef().set({
      status: st.status,
      settings: st.settings,
      seats: st.seats,
      hand: st.hand,
      pots: st.pots || [],
      pendingAward: st.pendingAward || null,
      log: st.log || [],
      lastResults: st.lastResults || null,
      hostUid: this.uid,
      hostHeartbeat: FV.serverTimestamp()
    }, { merge: true });
  };

  g.Host = Host;
})(window);
