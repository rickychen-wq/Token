(function () {
  'use strict';
  var uid = null;

  var nick = document.getElementById('nick');
  nick.value = LS.get('nick', '');
  nick.addEventListener('input', function () { LS.set('nick', nick.value.trim()); });

  signIn().then(function (u) { uid = u; }).catch(function (e) {
    toast('登入失敗，Firebase 的「匿名」登入可能沒開', 'bad');
    console.error(e);
  });

  function need(v, msg) { if (!v) { toast(msg, 'bad'); throw new Error(msg); } return v; }

  function rand(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
    return s;
  }

  /* ---- 建立牌桌 ---- */
  document.getElementById('createBtn').addEventListener('click', function () {
    var name = nick.value.trim();
    if (!name) return toast('先填名字', 'bad');
    if (!uid) return toast('還在連線，等一下', 'bad');

    var settings = Engine.defaultSettings();
    settings.sb = Math.max(1, +document.getElementById('sb').value || 25);
    settings.bb = Math.max(settings.sb + 1, +document.getElementById('bb').value || 50);
    settings.startingChips = Math.max(settings.bb, +document.getElementById('stack').value || 5000);
    settings.seatCount = +document.getElementById('seats').value || 9;

    var btn = this; btn.disabled = true;
    createRoom(settings, 0).then(function (r) {
      LS.set('host:' + r.code, true);
      LS.set('lastRoom', r.code);
      alert('房號 ' + r.code + '\n房主碼 ' + r.key + '\n\n房主碼要記住，換手機時用它拿回控制權。');
      location.href = 'table.html?r=' + r.code;
    }).catch(function (e) {
      btn.disabled = false;
      toast(e.message || '建立失敗', 'bad');
      console.error(e);
    });
  });

  function createRoom(settings, tries) {
    if (tries > 8) return Promise.reject(new Error('房號一直撞號，再試一次'));
    var code = rand(4), key = rand(6);
    var ref = db.collection('rooms').doc(code);
    return ref.get().then(function (snap) {
      if (snap.exists) {
        var age = Date.now() - (snap.data().createdAtMs || 0);
        if (age < 12 * 3600 * 1000) return createRoom(settings, tries + 1);
      }
      var st = Engine.newRoom(settings);
      return ref.set({
        status: st.status, settings: st.settings, seats: st.seats,
        hand: st.hand, pots: [], pendingAward: null, log: [], lastResults: null,
        hostUid: uid, hostHeartbeat: FV.serverTimestamp(),
        createdAtMs: Date.now()
      }).then(function () {
        return ref.collection('private').doc('host').set({ key: key });
      }).then(function () {
        return { code: code, key: key };
      });
    });
  }

  /* ---- 加入 ---- */
  document.getElementById('joinBtn').addEventListener('click', function () {
    var name = nick.value.trim();
    var code = document.getElementById('joincode').value.trim();
    if (!name) return toast('先填名字', 'bad');
    if (!/^\d{4}$/.test(code)) return toast('房號是 4 位數字', 'bad');
    db.collection('rooms').doc(code).get().then(function (s) {
      if (!s.exists) return toast('找不到這桌', 'bad');
      LS.set('lastRoom', code);
      location.href = 'table.html?r=' + code;
    }).catch(function (e) { toast('連不上：' + e.code, 'bad'); });
  });

  document.getElementById('joincode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('joinBtn').click();
  });

  /* ---- 房主救援 ---- */
  document.getElementById('toggleRecover').addEventListener('click', function () {
    var p = document.getElementById('recoverPanel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('recoverBtn').addEventListener('click', function () {
    var code = document.getElementById('rcode').value.trim();
    var key = document.getElementById('rkey').value.trim();
    if (!/^\d{4}$/.test(code) || !key) return toast('房號跟房主碼都要填', 'bad');
    // 規則會比對 key，錯的直接被擋下來
    db.collection('rooms').doc(code).collection('claims').doc(uid)
      .set({ key: key, at: FV.serverTimestamp() })
      .then(function () {
        return db.collection('rooms').doc(code).update({ hostUid: uid, hostHeartbeat: FV.serverTimestamp() });
      })
      .then(function () {
        LS.set('host:' + code, true);
        location.href = 'table.html?r=' + code;
      })
      .catch(function () { toast('房主碼不對', 'bad'); });
  });
})();
