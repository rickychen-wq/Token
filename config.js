/* Firebase 設定 — 已填入 token-77aaf 專案 */
var FB_CONFIG = {
  apiKey: "AIzaSyC1ypnHgPuhjoe6u7D-opVzQSZEgv9q34k",
  authDomain: "token-77aaf.firebaseapp.com",
  projectId: "token-77aaf",
  storageBucket: "token-77aaf.firebasestorage.app",
  messagingSenderId: "1055537384689",
  appId: "1:1055537384689:web:84544d089ab33f7e12ad50",
  measurementId: "G-BEE6LSR74B"
};

firebase.initializeApp(FB_CONFIG);
var db = firebase.firestore();
var auth = firebase.auth();
var FV = firebase.firestore.FieldValue;

/* ---- 小工具 ---- */
var LS = {
  get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
};

function qs(name) {
  var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
  return m ? decodeURIComponent(m[1]) : null;
}

function fmt(n) {
  n = Math.round(n || 0);
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function toast(msg, kind) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.className = 'toast'; }, 2600);
}

/* 匿名登入，回傳 uid */
function signIn() {
  return new Promise(function (resolve, reject) {
    var done = false;
    auth.onAuthStateChanged(function (u) {
      if (u && !done) { done = true; resolve(u.uid); }
    });
    auth.signInAnonymously().catch(function (e) {
      if (!done) { done = true; reject(e); }
    });
  });
}

/* 螢幕防鎖（房主用） */
var wakeLock = null;
function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  navigator.wakeLock.request('screen').then(function (l) {
    wakeLock = l;
    l.addEventListener('release', function () { wakeLock = null; });
  }).catch(function () {});
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && wakeLock === null && window.__isHost) keepAwake();
});
