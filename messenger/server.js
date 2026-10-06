const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, "data.json");
const UPLOADS = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- tiny JSON "database" ----------
let loaded = {};
try { loaded = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
const db = {
  users: loaded.users || [],
  messages: loaded.messages || [],
  friends: loaded.friends || null,
  requests: loaded.requests || [],
  profiles: Object.assign(Object.create(null), loaded.profiles || {}),
};
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
db.messages.forEach(m => { if (!m.id) m.id = rid(); });
const isFriend = (a, b) => (db.friends || []).some(([x, y]) => (x === a && y === b) || (x === b && y === a));
if (!db.friends) { // very old data: people who already chatted become friends
  db.friends = [];
  db.messages.forEach(m => { if (m.from !== m.to && !isFriend(m.from, m.to)) db.friends.push([m.from, m.to]); });
}
// accounts made before profiles existed get an empty profile (no password yet: claimed on first login)
db.users.forEach(n => { if (!db.profiles[n]) db.profiles[n] = { display: n, bio: "", av: 0, pass: null, tokens: [], lastSeen: 0 }; });

const friendsOf = n => db.friends.filter(p => p.includes(n)).map(p => (p[0] === n ? p[1] : p[0]));
const hasReq = (a, b) => db.requests.some(r => r.from === a && r.to === b);
const dropReq = (a, b) => { db.requests = db.requests.filter(r => !(r.from === a && r.to === b)); };
const findUser = raw => {
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

// ---------- image uploads (avatars + photo messages) ----------
const MAGIC = b => (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF ? "image/jpeg"
  : b.length > 4 && b.readUInt32BE(0) === 0x89504E47 ? "image/png"
  : b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" ? "image/webp" : null);
function parseImage(s, max) {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(s || ""));
  if (!m || m[1].length > max * 1.4) return null;
  const buf = Buffer.from(m[1], "base64");
  return buf.length && buf.length <= max && MAGIC(buf) ? buf : null;
}
const avFile = n => path.join(UPLOADS, "av-" + crypto.createHash("sha1").update(n).digest("hex"));
const imFile = id => path.join(UPLOADS, "im-" + id);
const rm = f => fs.unlink(f, () => {});

// ---------- ICE servers for video calls (optional TURN via env vars) ----------
function iceConfig() {
  const list = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URLS) {
    list.push({ urls: process.env.TURN_URLS.split(",").map(u => u.trim()).filter(Boolean),
                username: process.env.TURN_USERNAME || "", credential: process.env.TURN_CREDENTIAL || "" });
  }
  return list;
}

// ---------- HTTP: static files, avatars, photos ----------
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
function sendImage(res, file, cache) {
  fs.readFile(file, (err, data) => {
    const type = !err && MAGIC(data);
    if (!type) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, "X-Content-Type-Options": "nosniff" });
    res.end(data);
  });
}
const server = http.createServer((req, res) => {
  let url; try { url = decodeURIComponent(req.url.split("?")[0]); } catch { return res.writeHead(400).end(); }
  if (url === "/ice-config") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end(JSON.stringify(iceConfig())); }
  if (url === "/health") return res.writeHead(200).end("ok");
  if (url.startsWith("/avatar/")) { const n = findUser(url.slice(8)); return n && db.profiles[n].av ? sendImage(res, avFile(n), "public, max-age=31536000, immutable") : res.writeHead(404).end(); }
  if (url.startsWith("/img/")) { const id = url.slice(5); return /^[a-f0-9]{24}$/.test(id) ? sendImage(res, imFile(id), "private, max-age=86400") : res.writeHead(404).end(); }
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
const pushSocial = n => {
  const s = online.get(n); if (!s || !db.profiles[n]) return;
  send(s, { t: "social",
    friends: friendsOf(n).filter(f => db.profiles[f]).map(card),
    incoming: db.requests.filter(r => r.to === n && db.profiles[r.from]).map(r => brief(r.from)),
    outgoing: db.requests.filter(r => r.from === n && db.profiles[r.to]).map(r => brief(r.to)) });
};
const related = n => new Set([...friendsOf(n), ...db.requests.filter(r => r.from === n || r.to === n).flatMap(r => [r.from, r.to])].filter(x => x !== n));
const touch = n => { pushSocial(n); related(n).forEach(pushSocial); };
function acceptFriend(from, to) {
  dropReq(from, to);
  if (!isFriend(from, to)) db.friends.push([from, to]);
  save();
  notify(from, `${db.profiles[to].display || to} accepted your friend request.`);
  notify(to, `You and ${db.profiles[from].display || from} are now friends.`);
  pushSocial(from); pushSocial(to);
}
function enter(ws, n, token) {
  const old = online.get(n);
  if (old && old !== ws) { old.user = null; send(old, { t: "kicked" }); old.close(); }
  ws.user = n; online.set(n, ws);
  send(ws, { t: "joined", me: mine(n), token, history: db.messages.filter(m => m.from === n || m.to === n).slice(-500) });
  pushSocial(n); friendsOf(n).forEach(pushSocial);
}
const cleanLine = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

wss.on("connection", (ws, req) => {
  ws.user = null; ws.busy = false;
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
          const n = String(d.name || "").trim();
          if (!/^[A-Za-z0-9_.]{3,20}$/.test(n)) return authErr("Username must be 3-20 letters, numbers, dots or underscores.");
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
        if (!p || !d.token || !(p.tokens || []).includes(sha(String(d.token)))) return authErr("Your session expired. Please log in again.", { expired: true });
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
        send(ws, { t: "passwordChanged", token: newToken(name) });
      } finally { ws.busy = false; }
    }
    if (d.t === "logout") { p.tokens = (p.tokens || []).filter(h => h !== sha(String(d.token || ""))); save(); }

    // ----- friends -----
    if (d.t === "request") {
      const to = findUser(d.to);
      if (!to) return notify(name, `No user named "${cleanLine(d.to, 20)}".`);
      if (to === name) return notify(name, "That's you.");
      if (isFriend(name, to)) return notify(name, `You are already friends with ${db.profiles[to].display}.`);
      if (hasReq(name, to)) return notify(name, `You already sent ${db.profiles[to].display} a request.`);
      if (hasReq(to, name)) return acceptFriend(to, name); // they asked first: become friends
      db.requests.push({ from: name, to }); save();
      notify(name, `Request sent to ${db.profiles[to].display}.`); notify(to, `${p.display} sent you a friend request.`);
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

    // ----- call setup relay (friends only) -----
    if (d.t === "signal") {
      const peer = online.get(d.to);
      if (peer && isFriend(name, d.to)) send(peer, { t: "signal", from: name, kind: d.kind, data: d.data });
      else if (d.kind === "offer") send(ws, { t: "signal", from: d.to, kind: "unavailable" });
    }

    // ----- typing + read receipts -----
    if (d.t === "typing") { const peer = online.get(d.to); if (peer && isFriend(name, d.to)) send(peer, { t: "typing", from: name }); }
    if (d.t === "read") {
      const from = String(d.from); let upTo = 0;
      db.messages.forEach(m => { if (m.from === from && m.to === name && !m.seen) { m.seen = Date.now(); upTo = Math.max(upTo, m.at); } });
      if (upTo) { save(); const s = online.get(from); if (s) send(s, { t: "seen", by: name, upTo }); }
    }

    // ----- messages -----
    if (d.t === "delete") {
      const i = db.messages.findIndex(x => x.id === d.id && x.from === name);
      if (i !== -1) {
        const [m] = db.messages.splice(i, 1); if (m.img) rm(imFile(m.img)); save();
        new Set([m.from, m.to]).forEach(n => { const s = online.get(n); if (s) send(s, { t: "deleted", id: m.id }); });
      }
    }
    if (d.t === "msg") {
      const text = String(d.text || "").trim().slice(0, 2000);
      const buf = d.img ? parseImage(d.img, 1536 * 1024) : null;
      if (d.img && !buf) return notify(name, "That photo could not be sent. Try a smaller one.");
      if ((!text && !buf) || !db.profiles[d.to]) return;
      if (!isFriend(name, d.to)) return notify(name, "You can only message friends.");
      const m = { id: rid(), from: name, to: d.to, text, at: Date.now() };
      if (buf) { m.img = crypto.randomBytes(12).toString("hex"); fs.writeFileSync(imFile(m.img), buf); }
      db.messages.push(m);
      if (db.messages.length > 20000) { const old = db.messages.shift(); if (old.img) rm(imFile(old.img)); }
      save();
      send(ws, { t: "msg", m });
      const peer = online.get(d.to);
      if (peer && peer !== ws) send(peer, { t: "msg", m });
    }

    // ----- delete my account (asks for the password) -----
    if (d.t === "deleteAccount") {
      if (ws.busy) return; ws.busy = true;
      try {
        if (p.pass && !(await checkPass(p.pass, String(d.password || "")))) return notify(name, "Wrong password. Account not deleted.");
        const gone = name, ex = friendsOf(gone), affected = related(gone);
        db.messages.forEach(m => { if ((m.from === gone || m.to === gone) && m.img) rm(imFile(m.img)); });
        rm(avFile(gone));
        db.users = db.users.filter(u => u !== gone);
        delete db.profiles[gone];
        db.messages = db.messages.filter(m => m.from !== gone && m.to !== gone);
        db.friends = db.friends.filter(q => !q.includes(gone));
        db.requests = db.requests.filter(r => r.from !== gone && r.to !== gone);
        save(); online.delete(gone); ws.user = null;
        send(ws, { t: "accountDeleted" });
        ex.forEach(f => { const s = online.get(f); if (s) send(s, { t: "userDeleted", name: gone }); });
        affected.forEach(pushSocial);
        ws.close();
      } finally { ws.busy = false; }
    }
  });
  ws.on("close", () => {
    const n = ws.user;
    if (n && online.get(n) === ws) {
      online.delete(n);
      if (db.profiles[n]) { db.profiles[n].lastSeen = Date.now(); save(); }
      friendsOf(n).forEach(pushSocial);
    }
  });
});

server.listen(PORT, () => console.log(`Relay running at http://localhost:${PORT}`));
