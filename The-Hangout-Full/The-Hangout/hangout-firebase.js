// The Hangout on Firebase.
// The Hangout was first built on claude.ai, where it used claude.use("db"), claude.use("user") and so on.
// This file gives it those same tools, but powered by YOUR Firebase project, plus email sign-in.
import { firebaseConfig } from "./config.js";

const OWNER_HASH = "0e28358a7bf3c7eea7d365ff623f521758c8cef487022624075689f8ddf93e99"; // the owner's email, scrambled
const PFX = "hg_";          // every Hangout collection in Firestore starts with this
const MAX_LIMIT = 200;      // keeps reads low so the free Firebase plan lasts
const BLOB_MAX = 700000;    // biggest upload (bytes) a free Firestore document can hold
const $ = s => document.querySelector(s);
const gate = $("#hgGate");

function gateMsg(t, bad) { const m = $("#hgMsg"); m.textContent = t || ""; m.className = "hgmsg" + (bad ? " bad" : ""); }
function gateView(v) { // "loading" | "auth" | "off"
  gate.hidden = v === "off"; $("#hgLoading").hidden = v !== "loading"; $("#hgAuth").hidden = v !== "auth";
}

if (!firebaseConfig || !firebaseConfig.apiKey || String(firebaseConfig.apiKey).startsWith("PASTE")) {
  gateView("loading"); $("#hgLoading").textContent = "Almost ready! Paste your Firebase settings into config.js.";
  throw new Error("config.js is not filled in");
}

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const fs = firebase.firestore();
fs.settings({ ignoreUndefinedProperties: true, merge: true });
try { await fs.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* private window or old browser: fine */ }

/* ---------- turning data into a shape Firestore accepts (it can't store lists inside lists) ---------- */
const plain = v => v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
function enc(v) {
  if (Array.isArray(v)) return v.some(Array.isArray) ? { __hgj: JSON.stringify(v) } : v.map(enc);
  if (plain(v)) { const o = {}; for (const k in v) { if (v[k] !== undefined) o[k] = enc(v[k]); } return o; }
  return v;
}
function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === "object") {
    if (typeof v.toMillis === "function") return v.toMillis();
    if (typeof v.__hgj === "string" && Object.keys(v).length === 1) { try { return JSON.parse(v.__hgj); } catch (e) { return []; } }
    const o = {}; for (const k in v) o[k] = dec(v[k]); return o;
  }
  return v;
}

/* ---------- the "db" the Hangout code talks to ---------- */
const wd = s => ({ id: s.id, exists: s.exists, data: () => (s.exists ? dec(s.data()) : undefined), metadata: s.metadata, ref: new Doc(s.ref) });
const wq = s => { const docs = s.docs.map(wd); return { docs, size: docs.length, empty: !docs.length, metadata: s.metadata,
  forEach: f => docs.forEach(f), docChanges: () => s.docChanges().map(c => ({ type: c.type, doc: wd(c.doc), oldIndex: c.oldIndex, newIndex: c.newIndex })) }; };
const quiet = e => e && e.code === "permission-denied";
class Query {
  constructor(q) { this._q = q; }
  where(f, op, v) { return new Query(this._q.where(f, op, enc(v))); }
  orderBy(f, d) { return new Query(this._q.orderBy(f, d)); }
  limit(n) { return new Query(this._q.limit(Math.min(n, MAX_LIMIT))); }
  get() { return this._q.get().then(wq); }
  onSnapshot(next, err) { return this._q.onSnapshot(s => { next && next(wq(s)); }, e => { if (!quiet(e)) console.warn("Hangout:", e); err && err(e); }); }
}
class Col extends Query {
  constructor(ref) { super(ref); this._ref = ref; this.id = ref.id; }
  doc(id) { return new Doc(id ? this._ref.doc(String(id)) : this._ref.doc()); }
  add(o) { return this._ref.add(enc(o)).then(r => new Doc(r)); }
}
class Doc {
  constructor(r) { this._r = r; this.id = r.id; }
  set(o, opt) { return this._r.set(enc(o), opt || {}); }
  // The claude.ai database MERGED nested objects on update (e.g. adding yourself to a game's seats kept everyone else),
  // so we do the same with set(..., {merge:true}) instead of Firestore's update(), which would replace them.
  async update(a, ...rest) {
    if (typeof a === "string") { const o = {}; o[a] = rest[0]; for (let i = 1; i + 1 < rest.length; i += 2) o[rest[i]] = rest[i + 1]; a = o; }
    const nested = {};
    for (const k in a) { const parts = k.split("."); let t = nested; for (const p of parts.slice(0, -1)) { if (!plain(t[p])) t[p] = {}; t = t[p]; } const last = parts[parts.length - 1]; t[last] = plain(a[k]) && plain(t[last]) ? { ...t[last], ...a[k] } : a[k]; }
    return this._r.set(enc(nested), { merge: true });
  }
  delete() { return this._r.delete(); }
  get() { return this._r.get().then(wd); }
  onSnapshot(next, err) { return this._r.onSnapshot(s => { next && next(wd(s)); }, e => { err && err(e); }); }
  collection(n) { return new Col(this._r.collection(n)); }
  // A short "lock" the claude.ai database had. Here the security rules stop two people taking the same username.
  async acquire() { return { acquired: true, release: async () => {} }; }
  async release() {}
}
const db = {
  collection: n => new Col(fs.collection(PFX + n)),
  doc: p => new Doc(fs.doc(PFX + String(p).replace(/^\/+/, ""))),
};

/* ---------- photos and files (stored inside Firestore, since Firebase Storage isn't free) ---------- */
async function shrink(blob, max, q) {
  try {
    const bmp = await createImageBitmap(blob); const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || blob), "image/jpeg", q));
  } catch (e) { return blob; }
}
const toDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const assets = {
  async upload(blob) {
    let b = blob;
    if (b.type && b.type.startsWith("image/") && b.type !== "image/gif") { b = await shrink(b, 1280, 0.8); if (b.size > BLOB_MAX) b = await shrink(blob, 900, 0.6); }
    if (b.size > BLOB_MAX) { const e = new Error("That file is too big. Files can be up to about 650 KB."); e.code = "too-big"; hgToast(e.message); throw e; }
    const ref = fs.collection(PFX + "blobs").doc();
    await ref.set({ by: auth.currentUser.uid, type: b.type || "application/octet-stream", name: blob.name || "", data: await toDataURL(b), at: Date.now() });
    return { id: ref.id };
  },
  delete(id) { return fs.collection(PFX + "blobs").doc(String(id)).delete(); },
};
// Pictures in the page point at "#hgblob=<id>": swap those for the real picture.
const blobCache = new Map();
function loadBlob(id) {
  if (!blobCache.has(id)) blobCache.set(id, fs.collection(PFX + "blobs").doc(id).get().then(async s => {
    if (!s.exists) return null; const r = await fetch(s.data().data); return URL.createObjectURL(await r.blob()); }).catch(() => null));
  return blobCache.get(id);
}
function fixBlobs(root) {
  const els = root.querySelectorAll ? root.querySelectorAll('img[src*="#hgblob="],a[href*="#hgblob="]') : [];
  const list = root.matches && root.matches('img[src*="#hgblob="],a[href*="#hgblob="]') ? [root, ...els] : els;
  for (const e of list) {
    const attr = e.tagName === "IMG" ? "src" : "href"; const v = e.getAttribute(attr) || ""; const id = decodeURIComponent(v.split("#hgblob=")[1] || "");
    if (!id) continue; if (attr === "src") e.style.opacity = ".001";
    loadBlob(id).then(u => { if ((e.getAttribute(attr) || "") !== v) return; if (u) e.setAttribute(attr, u); e.style.opacity = ""; });
  }
}
new MutationObserver(ms => { for (const m of ms) { if (m.type === "attributes") fixBlobs(m.target); else m.addedNodes.forEach(n => n.nodeType === 1 && fixBlobs(n)); } })
  .observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href"] });

/* ---------- who's online (uses a "lastSeen" time on your profile) ---------- */
let membersCache = {};
function makeRoom(uid) {
  let beat = null;
  const touch = () => { const m = membersCache[uid]; if (m && m.username && !document.hidden) fs.collection(PFX + "members").doc(uid).set({ lastSeen: Date.now() }, { merge: true }).catch(() => {}); };
  return {
    async presence() { clearInterval(beat); beat = setInterval(touch, 4 * 60e3); setTimeout(touch, 3000); document.addEventListener("visibilitychange", touch); },
    onPeers(cb) {
      const emit = () => { const now = Date.now(); const peers = Object.entries(membersCache).filter(([k, m]) => m.lastSeen && now - m.lastSeen < 6 * 60e3).map(([k]) => ({ by: k, presence: { key: k } })); cb({ peers }); };
      const un = fs.collection(PFX + "members").onSnapshot(s => { membersCache = {}; s.docs.forEach(d => membersCache[d.id] = d.data()); emit(); }, () => {});
      const t = setInterval(emit, 60e3); return () => { un(); clearInterval(t); };
    },
  };
}

/* ---------- alerts: sound + pop-up for group messages and friend requests ---------- */
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
let audio = null; document.addEventListener("pointerdown", () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) {} }, { once: true });
function ping() { if (store("hg-sound") === "off" || !audio) return; try { const o = audio.createOscillator(), g = audio.createGain(); o.type = "sine"; o.frequency.setValueAtTime(880, audio.currentTime); o.frequency.setValueAtTime(1320, audio.currentTime + .09);
  g.gain.setValueAtTime(.0001, audio.currentTime); g.gain.exponentialRampToValueAtTime(.18, audio.currentTime + .02); g.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + .35); o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + .4); } catch (e) {} }
let unseen = 0; const baseTitle = document.title;
function bumpTitle() { unseen++; document.title = "(" + unseen + ") " + baseTitle; try { navigator.setAppBadge && navigator.setAppBadge(unseen); } catch (e) {} }
document.addEventListener("visibilitychange", () => { if (!document.hidden) { unseen = 0; document.title = baseTitle; try { navigator.clearAppBadge && navigator.clearAppBadge(); } catch (e) {} } });
async function alertUser(title, body, tag) {
  const away = document.hidden || !document.hasFocus(); if (!away) return; ping(); bumpTitle();
  if (!("Notification" in window) || Notification.permission !== "granted" || store("hg-notify") === "off") return;
  try { const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration(); const opt = { body, tag, icon: "icon-192.png", badge: "icon-192.png", renotify: true };
    if (reg) await reg.showNotification(title, opt); else new Notification(title, opt); } catch (e) {}
}
function startAlerts(uid) {
  const groups = new Map(); let first = { g: true, r: true };
  fs.collection(PFX + "groups").where("members", "array-contains", uid).onSnapshot(s => { groups.clear(); s.docs.forEach(d => groups.set(d.id, d.data())); }, () => {});
  fs.collection(PFX + "groupmsgs").orderBy("createdAt", "desc").limit(MAX_LIMIT).onSnapshot(s => {
    if (first.g) { first.g = false; return; }
    for (const c of s.docChanges()) { if (c.type !== "added") continue; const m = c.doc.data(); const g = groups.get(m.groupId);
      if (!g || m.authorKey === uid || Date.now() - (m.createdAt || 0) > 120e3) continue;
      alertUser((m.name || "Someone") + " in " + (g.name || "your group"), String(m.text || "📷 Sent something").slice(0, 120), "g-" + m.groupId); }
  }, () => {});
  fs.collection(PFX + "friendreqs").onSnapshot(s => {
    if (first.r) { first.r = false; return; }
    for (const c of s.docChanges()) { if (c.type !== "added") continue; const r = c.doc.data(); if (r.to !== uid || (r.status && r.status !== "pending")) continue;
      const n = (membersCache[r.from] && membersCache[r.from].name) || "Someone"; alertUser("👋 New friend request", n + " wants to be your friend!", "fr"); }
  }, () => {});
}
function notifyPrompt() {
  if (!("Notification" in window) || Notification.permission !== "default" || store("hg-notify-asked")) return;
  const b = document.createElement("div"); b.className = "hgbar"; b.innerHTML = '<span>🔔 Get alerts for new messages and friend requests?</span><button class="hgbtn sm" type="button">Turn on</button><button class="hglink" type="button">No thanks</button>';
  b.querySelector(".hgbtn").onclick = async () => { store("hg-notify-asked", "1"); b.remove(); const p = await Notification.requestPermission(); if (p === "granted") { store("hg-notify", "on"); hgToast("Alerts are on! 🔔"); } };
  b.querySelector(".hglink").onclick = () => { store("hg-notify-asked", "1"); b.remove(); };
  document.body.append(b);
}
function hgToast(t) { const x = document.createElement("div"); x.className = "hgtoast"; x.textContent = t; document.body.append(x); setTimeout(() => x.remove(), 3500); }

/* ---------- log out button on your own profile ---------- */
function addLogout() {
  const body = $("#profileBody"); if (!body) return;
  new MutationObserver(() => {
    let mine = false; try { mine = typeof X !== "undefined" && typeof S !== "undefined" && X.profileKey === S.key; } catch (e) {}
    if (!mine || body.querySelector(".hglogout")) return;
    const r = document.createElement("div"); r.className = "hglogout";
    const em = document.createElement("div"); em.className = "hgsmall"; em.textContent = "Signed in as " + (auth.currentUser && auth.currentUser.email || "");
    const lo = document.createElement("button"); lo.type = "button"; lo.className = "hglink"; lo.textContent = "🚪 Log out";
    lo.onclick = async () => { await auth.signOut(); location.reload(); };
    const pw = document.createElement("button"); pw.type = "button"; pw.className = "hglink"; pw.textContent = "🔑 Reset password";
    pw.onclick = async () => { try { await auth.sendPasswordResetEmail(auth.currentUser.email); hgToast("Check your email for a reset link 📧"); } catch (e) { hgToast(errText(e)); } };
    r.append(em, pw, lo); body.append(r);
  }).observe(body, { childList: true });
}

/* ---------- email sign-in screen ---------- */
function errText(e) {
  const c = (e && e.code) || "";
  return ({
    "auth/invalid-email": "That email doesn't look right.",
    "auth/missing-password": "Type your password.",
    "auth/weak-password": "Pick a password with at least 6 characters.",
    "auth/email-already-in-use": "There's already an account with that email. Try Log in.",
    "auth/invalid-credential": "Wrong email or password.", "auth/wrong-password": "Wrong email or password.", "auth/user-not-found": "No account with that email. Try Sign up.",
    "auth/invalid-login-credentials": "Wrong email or password.",
    "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.",
    "auth/network-request-failed": "No internet connection. Check it and try again.",
    "auth/operation-not-allowed": "Email sign-in isn't turned on in Firebase yet (Authentication → Sign-in method → Email/Password).",
    "auth/configuration-not-found": "Email sign-in isn't turned on in Firebase yet (Authentication → Sign-in method → Email/Password).",
    "auth/unauthorized-domain": "This website isn't allowed yet. In Firebase: Authentication → Settings → Authorized domains → add it.",
  })[c] || ("Something went wrong. Try again." + (c ? " (code: " + c + ")" : ""));
}
let mode = "login";
function setMode(m) { mode = m; $("#hgTabLogin").classList.toggle("on", m === "login"); $("#hgTabSignup").classList.toggle("on", m === "signup");
  $("#hgPw2Wrap").hidden = m !== "signup"; $("#hgGo").textContent = m === "signup" ? "Create account" : "Log in"; $("#hgForgot").hidden = m !== "login";
  $("#hgPw").autocomplete = m === "signup" ? "new-password" : "current-password"; gateMsg(""); }
$("#hgTabLogin").onclick = () => setMode("login"); $("#hgTabSignup").onclick = () => setMode("signup");
$("#hgForm").onsubmit = async e => {
  e.preventDefault(); const email = $("#hgEmail").value.trim(), pw = $("#hgPw").value; const btn = $("#hgGo");
  if (mode === "signup" && pw !== $("#hgPw2").value) { gateMsg("The two passwords don't match.", true); return; }
  btn.disabled = true; gateMsg(mode === "signup" ? "Making your account…" : "Logging in…");
  try {
    if (mode === "signup") { const cr = await auth.createUserWithEmailAndPassword(email, pw); try { await cr.user.sendEmailVerification(); } catch (x) {} }
    else await auth.signInWithEmailAndPassword(email, pw);
  } catch (err) { gateMsg(errText(err), true); } finally { btn.disabled = false; }
};
$("#hgForgot").onclick = async () => { const email = $("#hgEmail").value.trim(); if (!email) { gateMsg("Type your email first, then tap Forgot password.", true); return; }
  try { await auth.sendPasswordResetEmail(email); gateMsg("Check your email for a link to reset your password. 📧"); } catch (err) { gateMsg(errText(err), true); } };
setMode("login");

async function sha(t) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }

let started = false;
gateView("loading");
auth.onAuthStateChanged(async u => {
  if (!u) { if (started) { location.reload(); return; } gateView("auth"); return; }
  if (started) return; started = true;
  const isOwner = (await sha(String(u.email || "").trim().toLowerCase())) === OWNER_HASH;
  const user = { me: async () => ({ id: u.uid, isOwner, name: null, color: null, email: u.email }), can: async () => true };
  window.__hgResolve({ db, user, assets, room: makeRoom(u.uid), sample: null });
  gateView("off"); startAlerts(u.uid); addLogout(); setTimeout(notifyPrompt, 4000);
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
