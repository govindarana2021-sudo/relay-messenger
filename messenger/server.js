const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const webpush = require("web-push");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DB_FILE = path.join(__dirname, "data.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;
const STORY_TTL_MS = (Number(process.env.STORY_TTL_HOURS) || 24) * 3600 * 1000;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- tiny JSON "database" ----------
let loaded = {};
try { loaded = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
const db = { users: loaded.users || [], messages: loaded.messages || [], friends: loaded.friends || null,
             requests: loaded.requests || [], files: loaded.files || {}, stories: loaded.stories || [], push: loaded.push || {} };
const NAME_RE = /^[A-Za-z0-9]{1,20}$/; // usernames: letters and numbers only
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
db.messages.forEach(m => { if (!m.id) m.id = rid(); });
const isFriend = (a, b) => (db.friends || []).some(([x, y]) => (x === a && y === b) || (x === b && y === a));
if (!db.friends) { // older data: people who already chatted become friends
  db.friends = [];
  db.messages.forEach(m => { if (m.from !== m.to && !isFriend(m.from, m.to)) db.friends.push([m.from, m.to]); });
}
const friendsOf = n => db.friends.filter(p => p.includes(n)).map(p => (p[0] === n ? p[1] : p[0]));
const hasReq = (a, b) => db.requests.some(r => r.from === a && r.to === b);
const dropReq = (a, b) => { db.requests = db.requests.filter(r => !(r.from === a && r.to === b)); };
let timer;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => {}), 200); };

// ---------- web push (call notifications when the app is closed) ----------
let vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
if (!vapid.publicKey || !vapid.privateKey) {
  const vf = path.join(__dirname, "vapid.json");
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

// ---------- uploaded files & stories ----------
const tokens = new Map(); // session token -> username
const kindOf = mime => /^image\/(png|jpe?g|gif|webp)$/.test(mime) ? "image" : /^video\/(mp4|webm|ogg|quicktime)$/.test(mime) ? "video" : "file";
const removeFile = id => { delete db.files[id]; fs.unlink(path.join(UPLOAD_DIR, id), () => {}); };
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

// ---------- ICE servers for video calls (optional TURN via env vars) ----------
function iceConfig() {
  const list = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URLS) {
    list.push({ urls: process.env.TURN_URLS.split(",").map(u => u.trim()).filter(Boolean),
                username: process.env.TURN_USERNAME || "", credential: process.env.TURN_CREDENTIAL || "" });
  }
  return list;
}

// ---------- HTTP: static files, uploads, protected downloads ----------
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), url = u.pathname, q = u.searchParams;
  if (url === "/ice-config") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end(JSON.stringify(iceConfig())); }
  if (url === "/health") return res.writeHead(200).end("ok");
  if (url === "/push-key") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ key: vapid.publicKey })); }

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
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- realtime ----------
const wss = new WebSocketServer({ server });
const online = new Map(); // username -> socket
const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const notify = (n, text) => { const s = online.get(n); if (s) send(s, { t: "notice", text }); };
const pushSocial = n => {
  const s = online.get(n); if (!s) return;
  send(s, { t: "social",
    friends: friendsOf(n).map(f => ({ name: f, online: online.has(f) })),
    incoming: db.requests.filter(r => r.to === n).map(r => r.from),
    outgoing: db.requests.filter(r => r.from === n).map(r => r.to),
    stories: activeStories().filter(x => x.user === n || isFriend(x.user, n)).map(({ id, user, kind, text, at, file }) => ({ id, user, kind, text, at, file })) });
};
function acceptFriend(from, to) {
  dropReq(from, to);
  if (!isFriend(from, to)) db.friends.push([from, to]);
  save();
  notify(from, `${to} accepted your friend request.`);
  notify(to, `You and ${from} are now friends.`);
  pushSocial(from); pushSocial(to);
}
const claimFile = (name, id) => { // attach an uploaded file you own (once)
  const f = db.files[id];
  if (!f || f.owner !== name || f.used) return null;
  f.used = true; return { id, name: f.name, kind: f.kind, size: f.size };
};

setInterval(() => { // expire stories, drop abandoned uploads
  activeStories();
  Object.entries(db.files).forEach(([id, f]) => { if (!f.used && f.at < Date.now() - 3600e3) removeFile(id); });
  save(); online.forEach((_, n) => pushSocial(n));
}, 10 * 60 * 1000).unref();

wss.on("connection", ws => {
  let name = null, token = null;
  ws.on("message", raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }

    if (d.t === "join") {
      const n = String(d.name || "").trim();
      if (!NAME_RE.test(n)) return send(ws, { t: "error", text: "Username can only contain letters and numbers (no spaces or symbols), up to 20 characters." });
      if (online.has(n)) return send(ws, { t: "error", text: "That username is already online." });
      name = n; online.set(n, ws);
      token = rid() + rid() + rid(); tokens.set(token, n);
      if (!db.users.includes(n)) { db.users.push(n); save(); }
      send(ws, { t: "joined", name: n, token, history: db.messages.filter(m => m.from === n || m.to === n).slice(-500) });
      pushSocial(n); friendsOf(n).forEach(pushSocial);
      const call = pendingCalls.get(n);                 // someone rang while you were away
      if (call) {
        pendingCalls.delete(n);
        if (isFriend(call.from, n) && online.has(call.from)) {
          send(ws, { t: "signal", from: call.from, kind: "offer", data: call.offer });
          call.ice.forEach(c => send(ws, { t: "signal", from: call.from, kind: "ice", data: c }));
        }
      }
      return;
    }
    if (!name) return;

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
      const to = String(d.to || "").trim();
      if (!to || !db.users.includes(to)) return notify(name, `No user named "${to}".`);
      if (to === name) return notify(name, "That's you.");
      if (isFriend(name, to)) return notify(name, `You are already friends with ${to}.`);
      if (hasReq(name, to)) return notify(name, `You already sent ${to} a request.`);
      if (hasReq(to, name)) return acceptFriend(to, name);
      db.requests.push({ from: name, to }); save();
      notify(name, `Request sent to ${to}.`); notify(to, `${name} sent you a friend request.`);
      pushSocial(name); pushSocial(to);
    }
    if (d.t === "accept" && hasReq(String(d.from), name)) acceptFriend(String(d.from), name);
    if (d.t === "decline" && hasReq(String(d.from), name)) { dropReq(String(d.from), name); save(); pushSocial(name); pushSocial(String(d.from)); }
    if (d.t === "cancel" && hasReq(name, String(d.to))) { dropReq(name, String(d.to)); save(); pushSocial(name); pushSocial(String(d.to)); }
    if (d.t === "unfriend" && isFriend(name, String(d.user))) {
      const u = String(d.user);
      db.friends = db.friends.filter(p => !(p.includes(name) && p.includes(u))); save();
      notify(u, `${name} removed you from their friends.`);
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

    // ----- call setup relay (friends only) -----
    if (d.t === "signal") {
      const to = String(d.to || ""), peer = online.get(to);
      if (!isFriend(name, to)) { if (d.kind === "offer") send(ws, { t: "signal", from: to, kind: "unavailable" }); }
      else if (peer) send(peer, { t: "signal", from: name, kind: d.kind, data: d.data });
      else if (d.kind === "offer") {                    // friend is offline: ring their phone/browser via push
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

    // ----- messages (text, photo, video, file) -----
    if (d.t === "delete") {
      const i = db.messages.findIndex(x => x.id === d.id && x.from === name);
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

    // ----- delete my account -----
    if (d.t === "deleteAccount") {
      const gone = name, ex = friendsOf(gone);
      const affected = new Set([...ex, ...db.requests.filter(r => r.from === gone || r.to === gone).flatMap(r => [r.from, r.to])]);
      affected.delete(gone);
      db.messages.filter(m => m.from === gone || m.to === gone).forEach(m => m.file && removeFile(m.file.id));
      db.stories.filter(s => s.user === gone).forEach(s => s.file && removeFile(s.file.id));
      Object.entries(db.files).forEach(([id, f]) => { if (f.owner === gone) removeFile(id); });
      db.stories = db.stories.filter(s => s.user !== gone);
      db.users = db.users.filter(u => u !== gone);
      db.messages = db.messages.filter(m => m.from !== gone && m.to !== gone);
      db.friends = db.friends.filter(p => !p.includes(gone));
      db.requests = db.requests.filter(r => r.from !== gone && r.to !== gone);
      delete db.push[gone]; pendingCalls.delete(gone); pendingCalls.forEach((c, k) => { if (c.from === gone) pendingCalls.delete(k); });
      save(); online.delete(gone); tokens.delete(token); name = null;
      send(ws, { t: "accountDeleted" });
      ex.forEach(f => { const s = online.get(f); if (s) send(s, { t: "userDeleted", name: gone }); });
      affected.forEach(pushSocial);
      ws.close();
    }
  });
  ws.on("close", () => {
    if (token) tokens.delete(token);
    if (name) pendingCalls.forEach((c, k) => { if (c.from === name) pendingCalls.delete(k); });
    if (name && online.get(name) === ws) { online.delete(name); friendsOf(name).forEach(pushSocial); }
  });
});

server.listen(PORT, () => console.log(`Relay running at http://localhost:${PORT}`));
