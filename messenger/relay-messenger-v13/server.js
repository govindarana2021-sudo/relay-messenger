const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");
const webpush = require("web-push");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, "data.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;
const STORY_TTL_MS = (Number(process.env.STORY_TTL_HOURS) || 24) * 3600 * 1000;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- the one admin account ----------
// There is exactly one admin, fixed by the server operator via an env var (not by
// any action a user can take in the app). Whoever signs in as this exact account
// (with its password) gets admin powers; nobody can grant themselves or anyone else admin.
let ADMIN_NAME = String(process.env.ADMIN_USERNAME || "").trim();
const isAdmin = n => !!ADMIN_NAME && n === ADMIN_NAME;

// ---------- tiny JSON "database" ----------
let loaded = {};
try { loaded = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
const db = { users: loaded.users || [], messages: loaded.messages || [], friends: loaded.friends || null,
             requests: loaded.requests || [], files: loaded.files || {}, stories: loaded.stories || [], push: loaded.push || {},
             bans: loaded.bans || [], reports: loaded.reports || [], adminGrants: loaded.adminGrants || {},
             profiles: Object.assign(Object.create(null), loaded.profiles || {}) };
const NAME_RE = /^[A-Za-z0-9]{1,20}$/; // new usernames: letters and numbers only
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
db.messages.forEach(m => { if (!m.id) m.id = rid(); });
const isFriend = (a, b) => (db.friends || []).some(([x, y]) => (x === a && y === b) || (x === b && y === a));
if (!db.friends) { // older data: people who already chatted become friends
  db.friends = [];
  db.messages.forEach(m => { if (m.from !== m.to && !isFriend(m.from, m.to)) db.friends.push([m.from, m.to]); });
}
// accounts made before passwords existed get an empty profile (no password yet: claimed on first login)
db.users.forEach(n => { if (!db.profiles[n]) db.profiles[n] = { display: n, bio: "", av: 0, pass: null, tokens: [], lastSeen: 0 }; });
if (ADMIN_NAME) { const hit = db.users.find(u => u.toLowerCase() === ADMIN_NAME.toLowerCase()); if (hit) ADMIN_NAME = hit; }
const friendsOf = n => db.friends.filter(p => p.includes(n)).map(p => (p[0] === n ? p[1] : p[0]));
const hasReq = (a, b) => db.requests.some(r => r.from === a && r.to === b);
const dropReq = (a, b) => { db.requests = db.requests.filter(r => !(r.from === a && r.to === b)); };
const findUser = raw => { // exact match first, then case-insensitive
  const n = String(raw || "").trim(); if (!n) return null;
  if (db.profiles[n]) return n;
  const l = n.toLowerCase();
  return db.users.find(u => u.toLowerCase() === l) || null;
};
let timer;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => {}), 200); };

// ---------- passwords, sessions, rate limits ----------
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
async function makePass(pw) { const salt = crypto.randomBytes(16); return { salt: salt.toString("hex"), hash: (await scrypt(pw, salt)).toString("hex") }; }
async function checkPass(p, pw) {
  if (!p) return false;
  const k = await scrypt(pw, Buffer.from(p.salt, "hex")), h = Buffer.from(p.hash, "hex");
  return h.length === k.length && crypto.timingSafeEqual(h, k);
}
function newToken(n) {
  const t = crypto.randomBytes(32).toString("hex"), p = db.profiles[n];
  p.tokens = [sha(t), ...(p.tokens || [])].slice(0, 8); save(); return t;
}
const fails = new Map(), signups = new Map();
const locked = k => { const f = fails.get(k); return f && f.until > Date.now(); };
const noteFail = k => { const f = fails.get(k) || { n: 0, until: 0 }; if (++f.n >= 6) { f.n = 0; f.until = Date.now() + 60000; } fails.set(k, f); };
setInterval(() => { const now = Date.now(); fails.forEach((f, k) => { if (f.until < now && !f.n) fails.delete(k); }); signups.forEach((v, k) => { if (v.t < now) signups.delete(k); }); }, 600000).unref();

// ---------- web push (call notifications when the app is closed) ----------
let vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
if (!vapid.publicKey || !vapid.privateKey) {
  const vf = path.join(DATA_DIR, "vapid.json");
  try { vapid = JSON.parse(fs.readFileSync(vf, "utf8")); }
  catch { vapid = webpush.generateVAPIDKeys(); try { fs.writeFileSync(vf, JSON.stringify(vapid)); } catch {} }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", vapid.publicKey, vapid.privateKey);
const pendingCalls = new Map(); // callee -> { from, offer, ice[], at }  (calls waiting for an offline friend)
const RING_MS = 60000;
function sendPush(user, payload) {
  (db.push[user] || []).slice().forEach(sub => {
    if (process.env.PUSH_DRY_RUN) return console.log("PUSH_DRY " + JSON.stringify({ user, endpoint: sub.endpoint, payload }));
    webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60, urgency: "high" }).catch(err => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) { db.push[user] = (db.push[user] || []).filter(x => x.endpoint !== sub.endpoint); save(); }
    });
  });
}

// ---------- uploaded files, avatars & stories ----------
const tokens = new Map(); // live session token -> username (used to authorize uploads/downloads)
const kindOf = mime => /^image\/(png|jpe?g|gif|webp)$/.test(mime) ? "image" : /^video\/(mp4|webm|ogg|quicktime)$/.test(mime) ? "video" : "file";
const rm = f => fs.unlink(f, () => {});
const removeFile = id => { delete db.files[id]; rm(path.join(UPLOAD_DIR, id)); };
function activeStories() { // also lazily deletes expired stories and their files
  const cut = Date.now() - STORY_TTL_MS, dead = db.stories.filter(s => s.at < cut);
  if (dead.length) { dead.forEach(s => s.file && removeFile(s.file.id)); db.stories = db.stories.filter(s => s.at >= cut); save(); }
  return db.stories;
}
function canAccess(user, id) {
  const f = db.files[id]; if (!f) return false;
  return f.owner === user
    || db.messages.some(m => m.file && m.file.id === id && (m.from === user || m.to === user))
    || activeStories().some(s => s.file && s.file.id === id && (s.user === user || isFriend(s.user, user)));
}
const MAGIC = b => (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF ? "image/jpeg"
  : b.length > 4 && b.readUInt32BE(0) === 0x89504E47 ? "image/png"
  : b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" ? "image/webp" : null);
function parseImage(s, max) {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(s || ""));
  if (!m || m[1].length > max * 1.4) return null;
  const buf = Buffer.from(m[1], "base64");
  return buf.length && buf.length <= max && MAGIC(buf) ? buf : null;
}
const avFile = n => path.join(UPLOAD_DIR, "av-" + crypto.createHash("sha1").update(n).digest("hex"));

// ---------- ICE servers for video calls (optional TURN via env vars) ----------
function iceConfig() {
  const list = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URLS) {
    list.push({ urls: process.env.TURN_URLS.split(",").map(u => u.trim()).filter(Boolean),
                username: process.env.TURN_USERNAME || "", credential: process.env.TURN_CREDENTIAL || "" });
  }
  return list;
}

// ---------- HTTP: static files, avatars, uploads, protected downloads ----------
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
function sendImage(res, file, cache) {
  fs.readFile(file, (err, data) => {
    const type = !err && MAGIC(data);
    if (!type) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, "X-Content-Type-Options": "nosniff" });
    res.end(data);
  });
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), q = u.searchParams;
  let url; try { url = decodeURIComponent(u.pathname); } catch { return res.writeHead(400).end(); }
  if (url === "/ice-config") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end(JSON.stringify(iceConfig())); }
  if (url === "/health") return res.writeHead(200).end("ok");
  if (url === "/admin-status") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end(JSON.stringify({ enabled: !!ADMIN_NAME })); }
  if (url === "/admin" || url === "/admin/") {
    return fs.readFile(path.join(PUBLIC, "admin.html"), (err, data) => {
      if (err) return res.writeHead(404).end("Not found");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" });
      res.end(data);
    });
  }
  if (url === "/push-key") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ key: vapid.publicKey })); }
  if (url.startsWith("/avatar/")) { const n = findUser(url.slice(8)); return n && db.profiles[n].av ? sendImage(res, avFile(n), "public, max-age=31536000, immutable") : res.writeHead(404).end(); }

  if (req.method === "POST" && url === "/upload") {
    const user = tokens.get(q.get("token"));
    if (!user) return res.writeHead(401).end("Not signed in");
    if (Number(req.headers["content-length"] || 0) > MAX_BYTES) return res.writeHead(413).end("Too large");
    const id = rid() + rid(), fp = path.join(UPLOAD_DIR, id), out = fs.createWriteStream(fp);
    let size = 0, aborted = false;
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BYTES && !aborted) { aborted = true; out.destroy(); fs.unlink(fp, () => {}); res.writeHead(413).end("Too large"); req.destroy(); }
    });
    req.pipe(out);
    out.on("finish", () => {
      if (aborted) return;
      if (!size) { fs.unlink(fp, () => {}); return res.writeHead(400).end("Empty file"); }
      const name = String(q.get("name") || "file").replace(/[\\/\r\n"<>]/g, "_").slice(0, 100) || "file";
      const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase(), kind = kindOf(mime);
      db.files[id] = { owner: user, name, kind, size, mime: kind === "file" ? "application/octet-stream" : mime, at: Date.now(), used: false };
      save(); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id, name, kind, size }));
    });
    return;
  }

  const fm = url.match(/^\/files\/([a-z0-9]+)$/);
  if (fm) {
    const user = tokens.get(q.get("token")), f = db.files[fm[1]];
    if (!user || !f || !canAccess(user, fm[1])) return res.writeHead(404).end("Not found");
    const fp = path.join(UPLOAD_DIR, fm[1]);
    return fs.stat(fp, (err, st) => {
      if (err) return res.writeHead(404).end("Not found");
      const h = { "Content-Type": f.mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
                  "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes" };
      if (f.kind === "file") h["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`;
      const r = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!r) { res.writeHead(200, { ...h, "Content-Length": st.size }); return fs.createReadStream(fp).pipe(res); }
      let s = r[1] ? +r[1] : 0, e = r[2] ? +r[2] : st.size - 1;
      if (!r[1] && r[2]) { s = Math.max(0, st.size - +r[2]); e = st.size - 1; }
      e = Math.min(e, st.size - 1);
      if (s > e || s >= st.size) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...h, "Content-Range": `bytes ${s}-${e}/${st.size}`, "Content-Length": e - s + 1 });
      fs.createReadStream(fp, { start: s, end: e }).pipe(res);
    });
  }

  const file = path.join(PUBLIC, path.normalize(url === "/" ? "/index.html" : url));
  if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    res.end(data);
  });
});

// ---------- realtime ----------
const wss = new WebSocketServer({ server, maxPayload: 3 * 1024 * 1024 });
const online = new Map(); // username -> socket
const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const notify = (n, text) => { const s = online.get(n); if (s) send(s, { t: "notice", text }); };
const mine = n => { const p = db.profiles[n]; return { name: n, display: p.display || n, bio: p.bio || "", av: p.av || 0 }; };
const card = n => { const p = db.profiles[n]; return Object.assign(mine(n), { online: online.has(n), lastSeen: p.lastSeen || 0 }); };
const brief = n => { const p = db.profiles[n]; return { name: n, display: p.display || n, av: p.av || 0 }; };
const dname = n => (db.profiles[n] && db.profiles[n].display) || n;
const pushSocial = n => {
  const s = online.get(n); if (!s || !db.profiles[n]) return;
  send(s, { t: "social",
    friends: friendsOf(n).filter(f => db.profiles[f]).map(card),
    incoming: db.requests.filter(r => r.to === n && db.profiles[r.from]).map(r => brief(r.from)),
    outgoing: db.requests.filter(r => r.from === n && db.profiles[r.to]).map(r => brief(r.to)),
    stories: activeStories().filter(x => x.user === n || isFriend(x.user, n)).map(({ id, user, kind, text, at, file }) => ({ id, user, kind, text, at, file })) });
};
const related = n => new Set([...friendsOf(n), ...db.requests.filter(r => r.from === n || r.to === n).flatMap(r => [r.from, r.to])].filter(x => x !== n));
const touch = n => { pushSocial(n); related(n).forEach(pushSocial); };
function acceptFriend(from, to) {
  dropReq(from, to);
  if (!isFriend(from, to)) db.friends.push([from, to]);
  save();
  notify(from, `${dname(to)} accepted your friend request.`);
  notify(to, `You and ${dname(from)} are now friends.`);
  pushSocial(from); pushSocial(to);
}
const claimFile = (name, id) => { // attach an uploaded file you own (once)
  const f = db.files[id];
  if (!f || f.owner !== name || f.used) return null;
  f.used = true; return { id, name: f.name, kind: f.kind, size: f.size };
};
const cleanLine = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

// ---------- admin: presence/moderation dashboard, call activity, broadcasts ----------
// Everything here is read-only about video (the server only ever relays WebRTC
// signaling, never media) except the opt-in admin-call bypass and user-started
// broadcasts, both described below.
const activeCalls = new Map(); // "a|b" -> { a, b, state: "ringing"|"connected", since }
const liveBroadcasts = new Map(); // broadcaster username -> since (viewer is always the admin)
const callKey = (a, b) => [a, b].sort().join("|");
function trackCallStart(a, b) { activeCalls.set(callKey(a, b), { a, b, state: "ringing", since: Date.now() }); sendAdminState(); }
function trackCallConnected(a, b) { const c = activeCalls.get(callKey(a, b)); if (c && c.state !== "connected") { c.state = "connected"; c.since = Date.now(); sendAdminState(); } }
function trackCallEnd(a, b) { if (activeCalls.delete(callKey(a, b))) sendAdminState(); }
function endCallsInvolving(n) {
  let changed = false;
  for (const [k, c] of activeCalls) if (c.a === n || c.b === n) { activeCalls.delete(k); changed = true; }
  if (liveBroadcasts.delete(n)) changed = true;
  if (changed) sendAdminState();
}
function sendAdminState() {
  if (!ADMIN_NAME) return;
  const s = online.get(ADMIN_NAME); if (!s) return;
  send(s, { t: "adminState",
    users: db.users.map(u => ({ name: u, display: dname(u), online: online.has(u), granted: !!db.adminGrants[u], banned: db.bans.includes(u) })),
    reports: db.reports.slice(-200).reverse(),
    calls: [...activeCalls.values()],
    broadcasts: [...liveBroadcasts.entries()].map(([user, since]) => ({ user, since })) });
}

setInterval(() => { // expire stories, drop abandoned uploads
  activeStories();
  Object.entries(db.files).forEach(([id, f]) => { if (!f.used && f.at < Date.now() - 3600e3) removeFile(id); });
  save(); online.forEach((_, n) => pushSocial(n));
}, 10 * 60 * 1000).unref();

// A successful sign-up / log-in / resume ends here: bind the socket to the account.
function enter(ws, n, token) {
  if (db.bans.includes(n)) { send(ws, { t: "authError", text: "This account has been banned." }); return; }
  const old = online.get(n);
  if (old && old !== ws) { // one live session per account: the newest sign-in wins
    old.user = null; tokens.delete(old.token);
    pendingCalls.forEach((c, k) => { if (c.from === n) pendingCalls.delete(k); });
    endCallsInvolving(n);
    send(old, { t: "kicked" }); old.close();
  }
  ws.user = n; ws.token = token; online.set(n, ws); tokens.set(token, n);
  send(ws, { t: "joined", me: mine(n), token, admin: isAdmin(n), adminName: ADMIN_NAME || null,
             granted: !!db.adminGrants[n], history: db.messages.filter(m => m.from === n || m.to === n).slice(-500) });
  pushSocial(n); friendsOf(n).forEach(pushSocial);
  sendAdminState();
  const call = pendingCalls.get(n);                 // someone rang while you were away
  if (call) {
    pendingCalls.delete(n);
    if ((isFriend(call.from, n) || (isAdmin(call.from) && db.adminGrants[n])) && online.has(call.from)) {
      send(ws, { t: "signal", from: call.from, kind: "offer", data: call.offer, admin: isAdmin(call.from) || undefined });
      call.ice.forEach(c => send(ws, { t: "signal", from: call.from, kind: "ice", data: c, admin: isAdmin(call.from) || undefined }));
    }
  }
}

wss.on("connection", (ws, req) => {
  ws.user = null; ws.token = null; ws.busy = false;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const authErr = (text, extra) => send(ws, Object.assign({ t: "authError", text }, extra));

  ws.on("message", async raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d.t !== "string") return;

    // ----- sign up / log in / resume -----
    if (!ws.user && ["signup", "login", "resume"].includes(d.t)) {
      if (ws.busy) return;
      ws.busy = true;
      try {
        const pw = String(d.password || "");
        if (d.t === "signup") {
          let n = String(d.name || "").trim();
          if (ADMIN_NAME && n.toLowerCase() === ADMIN_NAME.toLowerCase()) n = ADMIN_NAME;
          if (!NAME_RE.test(n)) return authErr("Username can only contain letters and numbers (no spaces or symbols), up to 20 characters.");
          if (pw.length < 6 || pw.length > 100) return authErr("Password must be 6-100 characters.");
          if (findUser(n)) return authErr("That username is taken.");
          const s = signups.get(ip) || { n: 0, t: Date.now() + 3600000 };
          if (s.n >= 10) return authErr("Too many new accounts from this network. Try again later.");
          s.n++; signups.set(ip, s);
          const pass = await makePass(pw);
          if (findUser(n)) return authErr("That username is taken.");
          db.users.push(n);
          db.profiles[n] = { display: cleanLine(d.display, 30) || n, bio: "", av: 0, pass, tokens: [], lastSeen: Date.now() };
          return enter(ws, n, newToken(n));
        }
        if (d.t === "login") {
          const n = findUser(d.name), key = ip + "|" + String(d.name || "").toLowerCase();
          if (locked(key)) return authErr("Too many attempts. Wait a minute and try again.");
          const p = n && db.profiles[n];
          if (d.adminOnly && !(p && isAdmin(n))) { noteFail(key); return authErr("Wrong username or password, or this is not the admin account."); }
          if (!p) { noteFail(key); return authErr("Wrong username or password."); }
          if (!p.pass) { // account from before passwords existed: the first password chosen claims it
            if (pw.length < 6 || pw.length > 100) return authErr("This account has no password yet. Enter a new password (6+ characters) to secure it.");
            const pass = await makePass(pw);
            if (p.pass) return authErr("Wrong username or password.");
            p.pass = pass; save();
          } else if (!(await checkPass(p.pass, pw))) { noteFail(key); return authErr("Wrong username or password."); }
          return enter(ws, n, newToken(n));
        }
        // resume with a saved session token
        const n = findUser(d.name), p = n && db.profiles[n];
        if (!p || !d.token || (d.adminOnly && !isAdmin(n)) || !(p.tokens || []).includes(sha(String(d.token)))) return authErr("Your session expired. Please log in again.", { expired: true });
        return enter(ws, n, String(d.token));
      } finally { ws.busy = false; }
    }
    const name = ws.user;
    if (!name || !db.profiles[name]) return;
    const p = db.profiles[name];

    // ----- profile -----
    if (d.t === "profile") {
      p.display = cleanLine(d.display, 30) || name;
      p.bio = String(d.bio || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 140);
      save(); send(ws, { t: "me", me: mine(name) }); touch(name);
    }
    if (d.t === "avatar") {
      if (d.data === null) { p.av = 0; rm(avFile(name)); }
      else {
        const buf = parseImage(d.data, 400 * 1024);
        if (!buf) return notify(name, "That picture could not be used. Try a JPG or PNG.");
        fs.writeFileSync(avFile(name), buf); p.av = Date.now();
      }
      save(); send(ws, { t: "me", me: mine(name) }); touch(name);
    }
    if (d.t === "password") {
      const next = String(d.next || "");
      if (next.length < 6 || next.length > 100) return notify(name, "New password must be 6-100 characters.");
      if (ws.busy) return; ws.busy = true;
      try {
        if (!(await checkPass(p.pass, String(d.old || "")))) return notify(name, "Current password is wrong.");
        p.pass = await makePass(next); p.tokens = [];
        tokens.delete(ws.token); ws.token = newToken(name); tokens.set(ws.token, name);
        send(ws, { t: "passwordChanged", token: ws.token });
      } finally { ws.busy = false; }
    }
    if (d.t === "logout") { p.tokens = (p.tokens || []).filter(h => h !== sha(String(d.token || ""))); save(); }

    // ----- push subscriptions (this device wants call notifications) -----
    if (d.t === "pushSub") {
      const sb = d.sub;
      if (sb && typeof sb.endpoint === "string" && /^https:\/\//.test(sb.endpoint) && sb.keys && sb.keys.p256dh && sb.keys.auth) {
        Object.keys(db.push).forEach(u => { db.push[u] = db.push[u].filter(x => x.endpoint !== sb.endpoint); });
        db.push[name] = [...(db.push[name] || []), { endpoint: sb.endpoint, keys: { p256dh: String(sb.keys.p256dh), auth: String(sb.keys.auth) } }].slice(-5);
        save();
      }
    }
    if (d.t === "pushUnsub") { db.push[name] = (db.push[name] || []).filter(x => x.endpoint !== String(d.endpoint)); save(); }

    // ----- friends -----
    if (d.t === "request") {
      const to = findUser(d.to);
      if (!to) return notify(name, `No user named "${cleanLine(d.to, 20)}".`);
      if (to === name) return notify(name, "That's you.");
      if (isFriend(name, to)) return notify(name, `You are already friends with ${dname(to)}.`);
      if (hasReq(name, to)) return notify(name, `You already sent ${dname(to)} a request.`);
      if (hasReq(to, name)) return acceptFriend(to, name); // they asked first: become friends
      db.requests.push({ from: name, to }); save();
      notify(name, `Request sent to ${dname(to)}.`); notify(to, `${p.display} sent you a friend request.`);
      pushSocial(name); pushSocial(to);
    }
    if (d.t === "accept" && hasReq(String(d.from), name)) acceptFriend(String(d.from), name);
    if (d.t === "decline" && hasReq(String(d.from), name)) { dropReq(String(d.from), name); save(); pushSocial(name); pushSocial(String(d.from)); }
    if (d.t === "cancel" && hasReq(name, String(d.to))) { dropReq(name, String(d.to)); save(); pushSocial(name); pushSocial(String(d.to)); }
    if (d.t === "unfriend" && isFriend(name, String(d.user))) {
      const u = String(d.user);
      db.friends = db.friends.filter(q => !(q.includes(name) && q.includes(u))); save();
      notify(u, `${p.display} removed you from their friends.`);
      pushSocial(name); pushSocial(u);
    }

    // ----- stories (photo / video / text, visible to friends for 24h) -----
    if (d.t === "story") {
      const text = String(d.text || "").trim().slice(0, 300);
      let file = null;
      if (d.fileId) {
        const f = db.files[d.fileId];
        if (!f || f.kind === "file") return notify(name, "Stories can only be photos or videos.");
        file = claimFile(name, d.fileId);
        if (!file) return notify(name, "Upload not found.");
      }
      if (!file && !text) return;
      db.stories.push({ id: rid(), user: name, kind: file ? file.kind : "text", text, file, at: Date.now() }); save();
      notify(name, "Story posted. Your friends can see it for 24 hours.");
      pushSocial(name); friendsOf(name).forEach(pushSocial);
    }
    if (d.t === "deleteStory") {
      const i = db.stories.findIndex(s => s.id === d.id && s.user === name);
      if (i !== -1) { const [s] = db.stories.splice(i, 1); if (s.file) removeFile(s.file.id); save(); pushSocial(name); friendsOf(name).forEach(pushSocial); }
    }

    // ----- reports (anyone can flag a user for the admin) -----
    if (d.t === "report") {
      const target = String(d.target || "").trim();
      if (!target || !db.users.includes(target) || target === name) return;
      const reason = String(d.reason || "").trim().slice(0, 500);
      const messageId = d.messageId ? String(d.messageId) : null;
      db.reports.push({ id: rid(), from: name, target, messageId, reason, at: Date.now(), status: "open" });
      save(); notify(name, "Report sent. Thanks for flagging this.");
      sendAdminState();
    }

    // ----- opt-in: let the single admin call me anytime, no ring prompt -----
    // Entirely the user's own choice, set from their own profile, revocable at any
    // moment; the client shows an on-screen indicator for as long as a call with
    // the admin is active.
    if (d.t === "grantAdmin" && ADMIN_NAME && name !== ADMIN_NAME) {
      const on = !!d.on;
      db.adminGrants[name] = on; save();
      notify(name, on ? "The admin may now call you anytime without you having to accept." : "Admin calling access revoked.");
      if (!on) { const s = online.get(ADMIN_NAME); if (s) send(s, { t: "signal", from: name, kind: "hangup" }); send(ws, { t: "signal", from: ADMIN_NAME, kind: "hangup" }); trackCallEnd(ADMIN_NAME, name); } // drop any live admin call immediately
      sendAdminState();
    }

    // ----- broadcasting (user starts it; only the admin can join and watch) -----
    if (d.t === "broadcastStart") { liveBroadcasts.set(name, Date.now()); sendAdminState(); }
    if (d.t === "broadcastStop") {
      if (liveBroadcasts.delete(name)) {
        sendAdminState();
        const as = online.get(ADMIN_NAME); if (as) send(as, { t: "signal", from: name, kind: "hangup", broadcast: true });
      }
    }
    if (d.t === "broadcastJoin" && isAdmin(name)) {
      const from = String(d.from || ""), s = online.get(from);
      if (s && liveBroadcasts.has(from)) send(s, { t: "broadcastRequest", from: ADMIN_NAME });
      else notify(name, `${from} is not currently broadcasting.`);
    }

    // ----- call setup relay (friends, admin-granted users, and broadcast pairs only) -----
    if (d.t === "signal") {
      const to = String(d.to || ""), peer = online.get(to);
      const grantedLink = (isAdmin(name) && db.adminGrants[to]) || (isAdmin(to) && db.adminGrants[name]);
      const broadcastLink = (liveBroadcasts.has(name) && isAdmin(to)) || (liveBroadcasts.has(to) && isAdmin(name));
      const allowed = isFriend(name, to) || grantedLink || broadcastLink;
      if (!allowed) { if (d.kind === "offer") send(ws, { t: "signal", from: to, kind: "unavailable" }); }
      else if (peer) {
        send(peer, { t: "signal", from: name, kind: d.kind, data: d.data,
                      ...(isAdmin(name) ? { admin: true } : {}), ...(broadcastLink ? { broadcast: true } : {}) });
        if (!broadcastLink) {
          if (d.kind === "offer") trackCallStart(name, to);
          else if (d.kind === "answer") trackCallConnected(name, to);
          else if (d.kind === "hangup" || d.kind === "reject" || d.kind === "busy") trackCallEnd(name, to);
        }
      }
      else if (d.kind === "offer" && !broadcastLink) {                    // friend/granted user is offline: ring their phone/browser via push
        if ((db.push[to] || []).length) {
          const entry = { from: name, offer: d.data, ice: [], at: Date.now() };
          pendingCalls.set(to, entry);
          setTimeout(() => { if (pendingCalls.get(to) === entry) pendingCalls.delete(to); }, RING_MS);
          sendPush(to, { type: "call", from: name });
          send(ws, { t: "signal", from: to, kind: "ringing" });
        } else send(ws, { t: "signal", from: to, kind: "unavailable" });
      } else {
        const c = pendingCalls.get(to);
        if (c && c.from === name) { if (d.kind === "ice") c.ice.push(d.data); else if (d.kind === "hangup") pendingCalls.delete(to); }
      }
    }

    // ----- typing + read receipts -----
    if (d.t === "typing") { const peer = online.get(String(d.to)); if (peer && isFriend(name, String(d.to))) send(peer, { t: "typing", from: name }); }
    if (d.t === "read") {
      const from = String(d.from); let upTo = 0;
      db.messages.forEach(m => { if (m.from === from && m.to === name && !m.seen) { m.seen = Date.now(); upTo = Math.max(upTo, m.at); } });
      if (upTo) { save(); const s = online.get(from); if (s) send(s, { t: "seen", by: name, upTo }); }
    }

    // ----- messages (text, photo, video, file) -----
    if (d.t === "delete") {
      const i = db.messages.findIndex(x => x.id === d.id && (x.from === name || isAdmin(name)));
      if (i !== -1) {
        const [m] = db.messages.splice(i, 1); if (m.file) removeFile(m.file.id); save();
        new Set([m.from, m.to]).forEach(n => { const s = online.get(n); if (s) send(s, { t: "deleted", id: m.id }); });
      }
    }
    if (d.t === "msg") {
      const text = String(d.text || "").trim().slice(0, 2000);
      if ((!text && !d.fileId) || !db.users.includes(d.to)) return;
      if (!isFriend(name, d.to)) return notify(name, "You can only message friends.");
      let file = null;
      if (d.fileId) { file = claimFile(name, d.fileId); if (!file) return notify(name, "Upload not found."); }
      const m = { id: rid(), from: name, to: d.to, text, at: Date.now() };
      if (file) m.file = file;
      db.messages.push(m);
      if (db.messages.length > 20000) { const old = db.messages.shift(); if (old.file) removeFile(old.file.id); }
      save();
      send(ws, { t: "msg", m });
      const peer = online.get(d.to);
      if (peer && peer !== ws) send(peer, { t: "msg", m });
    }

    // ----- admin-only: moderation and dashboard -----
    if (isAdmin(name)) {
      if (d.t === "adminState") sendAdminState();
      if (d.t === "adminKick") {
        const u = String(d.user || ""), s = online.get(u);
        if (s && u !== ADMIN_NAME) { notify(u, "You were disconnected by an admin."); s.close(); }
      }
      if (d.t === "adminBan") {
        const u = String(d.user || "");
        if (u && u !== ADMIN_NAME && db.users.includes(u) && !db.bans.includes(u)) { db.bans.push(u); save(); }
        const s = online.get(u); if (s && u !== ADMIN_NAME) { send(s, { t: "banned" }); s.close(); }
        sendAdminState();
      }
      if (d.t === "adminUnban") { db.bans = db.bans.filter(x => x !== String(d.user || "")); save(); sendAdminState(); }
      if (d.t === "adminStopBroadcast") {
        const u = String(d.user || "");
        if (liveBroadcasts.delete(u)) {
          sendAdminState();
          const s = online.get(u);
          // Tell the broadcaster's own device to actually turn its camera off and
          // show them why — this never happens silently, and it only ever stops
          // a share the person themselves started.
          if (s) { send(s, { t: "stopShareRequest" }); notify(u, "The admin stopped your broadcast."); }
          send(ws, { t: "signal", from: u, kind: "hangup", broadcast: true }); // also close the admin's own viewer connection, if open
        }
      }
      if (d.t === "adminResolveReport") { const r = db.reports.find(r => r.id === d.id); if (r) { r.status = "resolved"; save(); sendAdminState(); } }
      if (d.t === "adminDismissReport") { const r = db.reports.find(r => r.id === d.id); if (r) { r.status = "dismissed"; save(); sendAdminState(); } }
    }

    // ----- delete my account (asks for the password) -----
    if (d.t === "deleteAccount") {
      if (ws.busy) return; ws.busy = true;
      try {
        if (p.pass && !(await checkPass(p.pass, String(d.password || "")))) return notify(name, "Wrong password. Account not deleted.");
        const gone = name, ex = friendsOf(gone), affected = related(gone);
        db.messages.filter(m => m.from === gone || m.to === gone).forEach(m => m.file && removeFile(m.file.id));
        db.stories.filter(s => s.user === gone).forEach(s => s.file && removeFile(s.file.id));
        Object.entries(db.files).forEach(([id, f]) => { if (f.owner === gone) removeFile(id); });
        rm(avFile(gone));
        db.stories = db.stories.filter(s => s.user !== gone);
        db.users = db.users.filter(u => u !== gone);
        delete db.profiles[gone];
        db.messages = db.messages.filter(m => m.from !== gone && m.to !== gone);
        db.friends = db.friends.filter(q => !q.includes(gone));
        db.requests = db.requests.filter(r => r.from !== gone && r.to !== gone);
        delete db.push[gone]; delete db.adminGrants[gone];
        pendingCalls.delete(gone); pendingCalls.forEach((c, k) => { if (c.from === gone) pendingCalls.delete(k); });
        save(); online.delete(gone); tokens.delete(ws.token); ws.user = null;
        endCallsInvolving(gone);
        send(ws, { t: "accountDeleted" });
        ex.forEach(f => { const s = online.get(f); if (s) send(s, { t: "userDeleted", name: gone }); });
        affected.forEach(pushSocial);
        sendAdminState();
        ws.close();
      } finally { ws.busy = false; }
    }
  });
  ws.on("close", () => {
    const n = ws.user;
    if (!n) return; // never signed in, was replaced by a newer session, or account deleted
    tokens.delete(ws.token);
    pendingCalls.forEach((c, k) => { if (c.from === n) pendingCalls.delete(k); });
    endCallsInvolving(n);
    if (online.get(n) === ws) {
      online.delete(n);
      if (db.profiles[n]) { db.profiles[n].lastSeen = Date.now(); save(); }
      friendsOf(n).forEach(pushSocial);
    }
    sendAdminState();
  });
});

server.listen(PORT, () => {
  console.log(`Relay running at http://localhost:${PORT}`);
  if (!ADMIN_NAME) console.log("Admin dashboard is OFF. To turn it on, set ADMIN_USERNAME (see README: Admin), restart, then sign up with that username.");
  else if (db.profiles[ADMIN_NAME]) console.log(`Admin account: ${ADMIN_NAME} (exists - log in as it to see the Admin button)`);
  else console.log(`Admin account: ${ADMIN_NAME} (NOT created yet - click "Create account" and sign up with exactly this username)`);
});
