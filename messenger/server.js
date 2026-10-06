const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DB_FILE = path.join(__dirname, "data.json");

// --- tiny JSON "database" ---
let db = { users: [], messages: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
let timer;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => {}), 200); };

// --- static file server ---
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
// ICE servers for video calls. Set TURN_URLS (comma separated), TURN_USERNAME and
// TURN_CREDENTIAL in the environment to add a TURN relay (needed on strict networks).
function iceConfig() {
  const list = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URLS) {
    list.push({ urls: process.env.TURN_URLS.split(",").map(u => u.trim()).filter(Boolean),
                username: process.env.TURN_USERNAME || "", credential: process.env.TURN_CREDENTIAL || "" });
  }
  return list;
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/ice-config") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end(JSON.stringify(iceConfig())); }
  if (url === "/health") return res.writeHead(200).end("ok");
  const file = path.join(PUBLIC, path.normalize(url === "/" ? "/index.html" : url));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// --- realtime messaging ---
const wss = new WebSocketServer({ server });
const online = new Map(); // username -> socket
const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const broadcastUsers = () => {
  const msg = { t: "users", users: db.users.map(name => ({ name, online: online.has(name) })) };
  wss.clients.forEach(c => send(c, msg));
};

wss.on("connection", ws => {
  let name = null;
  ws.on("message", raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }

    if (d.t === "join") {
      const n = String(d.name || "").trim().slice(0, 20);
      if (!n) return;
      if (online.has(n)) return send(ws, { t: "error", text: "That username is already online." });
      name = n; online.set(n, ws);
      if (!db.users.includes(n)) { db.users.push(n); save(); }
      send(ws, { t: "joined", name: n, history: db.messages.filter(m => m.from === n || m.to === n).slice(-500) });
      broadcastUsers();
    }

    if (d.t === "signal" && name) {              // WebRTC call setup relay
      const peer = online.get(d.to);
      if (peer) send(peer, { t: "signal", from: name, kind: d.kind, data: d.data });
      else if (d.kind === "offer") send(ws, { t: "signal", from: d.to, kind: "unavailable" });
    }

    if (d.t === "msg" && name) {
      const text = String(d.text || "").trim().slice(0, 2000);
      if (!text || !db.users.includes(d.to)) return;
      const m = { from: name, to: d.to, text, at: Date.now() };
      db.messages.push(m);
      if (db.messages.length > 20000) db.messages.shift();
      save();
      send(ws, { t: "msg", m });                       // echo to sender
      const peer = online.get(d.to);
      if (peer && peer !== ws) send(peer, { t: "msg", m }); // deliver if online
    }
  });
  ws.on("close", () => { if (name && online.get(name) === ws) { online.delete(name); broadcastUsers(); } });
});

server.listen(PORT, () => console.log(`Relay running at http://localhost:${PORT}`));
