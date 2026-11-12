/* Spotlight Quiz server
 * - serves the game (public/index.html)
 * - relays live multiplayer over WebSockets (/ws)
 * - optional: Claude-written questions via your Anthropic API key (/api/sample)
 * - tiny JSON store for the daily quiz leaderboard (/api/db)
 * No npm packages needed: just Node.js 18 or newer.  Start with:  node server.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const MODEL_FAST = process.env.CLAUDE_MODEL_FAST || "claude-haiku-5-5";
const AI_PER_HOUR = +(process.env.AI_REQUESTS_PER_HOUR || 60); // per visitor, protects your API bill
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PAGE = path.join(__dirname, "public", "index.html");

/* ---------------- tiny JSON store ---------------- */
let store = {};
try { store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { store = {}; }
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { fs.writeFile(DATA_FILE, JSON.stringify(store), () => {}); }, 1000); }
const leases = {};
const okPath = p => typeof p === "string" && p.length < 300 && /^[A-Za-z0-9_.~:@+-]+(\/[A-Za-z0-9_.~:@+-]+)*$/.test(p) && p.split("/").length <= 8;
function prune() { // keep only the last 14 days of daily quizzes
  const keys = Object.keys(store); if (keys.length < 5000) return;
  const days = [...new Set(keys.map(k => k.split("/")[1]))].sort().reverse().slice(0, 14);
  for (const k of keys) if (!days.includes(k.split("/")[1])) delete store[k];
}
function dbOp(b) {
  const p = b.path;
  if (!okPath(p)) return { error: "bad_path" };
  if (b.op === "get") return store[p] ? { exists: true, data: store[p] } : { exists: false };
  if (b.op === "set") {
    const s = JSON.stringify(b.data || {}); if (s.length > 60000) return { error: "too_big" };
    store[p] = b.data || {}; prune(); save(); return { ok: true };
  }
  if (b.op === "acquire") {
    const l = leases[p], now = Date.now();
    if (!l || l.until < now || l.holder === b.holder) { leases[p] = { holder: String(b.holder || ""), until: now + Math.min(600000, +b.ttlMs || 60000) }; return { acquired: true }; }
    return { acquired: false };
  }
  if (b.op === "query") {
    const pre = p + "/", lim = Math.max(1, Math.min(100, +b.limit || 20)), f = b.orderBy, desc = b.dir === "desc";
    let docs = Object.keys(store).filter(k => k.startsWith(pre) && !k.slice(pre.length).includes("/")).map(k => ({ id: k.slice(pre.length), data: store[k] }));
    if (f) docs.sort((a, c) => { const x = (a.data || {})[f], y = (c.data || {})[f]; return (x > y ? 1 : x < y ? -1 : 0) * (desc ? -1 : 1); });
    return { docs: docs.slice(0, lim) };
  }
  return { error: "bad_op" };
}

/* ---------------- Claude (optional) ---------------- */
const aiUse = new Map();
function aiAllowed(ip) { const now = Date.now(), a = (aiUse.get(ip) || []).filter(t => now - t < 3600000); if (a.length >= AI_PER_HOUR) { aiUse.set(ip, a); return false; } a.push(now); aiUse.set(ip, a); return true; }
async function callClaude(b) {
  const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 2).map(x => {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(String(x || ""));
    return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : null; }).filter(Boolean);
  let messages;
  if (Array.isArray(b.input)) messages = b.input.filter(m => m && (m.role === "user" || m.role === "assistant")).map(m => ({ role: m.role, content: String(m.content || "") }));
  else messages = [{ role: "user", content: String(b.input || "") }];
  if (!messages.length) throw new Error("empty");
  if (imgs.length) { const last = messages[messages.length - 1]; last.content = [...imgs, { type: "text", text: last.content }]; }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: b.tier === "quick" ? MODEL_FAST : MODEL, max_tokens: 8000, messages })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
  return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
}

/* ---------------- HTTP ---------------- */
function readBody(req, max) {
  return new Promise((res, rej) => { let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > max) { rej(new Error("too_big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { res(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { rej(e); } });
    req.on("error", rej); });
}
const json = (res, code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
const ipOf = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      return fs.createReadStream(PAGE).pipe(res);
    }
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (url.pathname === "/api/config") return json(res, 200, { ai: !!API_KEY });
    if (url.pathname === "/api/sample" && req.method === "POST") {
      if (!API_KEY) return json(res, 403, { code: "not_granted", message: "AI is off on this server" });
      if (!aiAllowed(ipOf(req))) return json(res, 429, { code: "rate_limited", message: "Too many requests, try again later" });
      const b = await readBody(req, 12e6);
      try { return json(res, 200, { text: await callClaude(b) }); }
      catch (e) { return json(res, 502, { code: "upstream", message: String(e.message || e) }); }
    }
    if (url.pathname === "/api/db" && req.method === "POST") {
      const b = await readBody(req, 100000); const r = dbOp(b);
      return json(res, r.error ? 400 : 200, r);
    }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found");
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

/* ---------------- live rooms over WebSockets ---------------- */
const rooms = new Map();       // room name -> Map(connId -> {pres, at})
const conns = new Map();       // connId -> conn
const MAX_MSG = 2 * 1024 * 1024;
function roomOf(name) { let r = rooms.get(name); if (!r) { r = { members: new Map(), t: null }; rooms.set(name, r); } return r; }
function broadcast(name) {
  const r = rooms.get(name); if (!r || r.t) return;
  r.t = setTimeout(() => { r.t = null; if (!r.members.size) { rooms.delete(name); return; }
    const peers = [...r.members].map(([id, m]) => ({ id, pres: m.pres, at: m.at }));
    const msg = JSON.stringify({ t: "peers", room: name, peers });
    for (const id of r.members.keys()) { const c = conns.get(id); if (c) c.send(msg); } }, 25);
}
function leaveRoom(c, name) { const r = rooms.get(name); if (r && r.members.delete(c.id)) { c.rooms.delete(name); broadcast(name); } }
function handle(c, m) {
  if (!m || typeof m !== "object" || typeof m.room !== "string" || m.room.length > 80) return;
  if (m.t === "join") { if (c.rooms.size >= 4 && !c.rooms.has(m.room)) return; const r = roomOf(m.room); if (r.members.size >= 60 && !r.members.has(c.id)) return c.send(JSON.stringify({ t: "full", room: m.room }));
    r.members.set(c.id, { pres: (m.pres && typeof m.pres === "object") ? m.pres : {}, at: Date.now() }); c.rooms.add(m.room); broadcast(m.room); }
  else if (m.t === "pres") { const r = rooms.get(m.room); const me = r && r.members.get(c.id); if (!me || !m.patch || typeof m.patch !== "object") return;
    for (const k in m.patch) { if (m.patch[k] === null) delete me.pres[k]; else me.pres[k] = m.patch[k]; } me.at = Date.now(); broadcast(m.room); }
  else if (m.t === "leave") leaveRoom(c, m.room);
}
function wsFrame(op, payload) {
  const n = payload.length; let h;
  if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
  else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  h[0] = 0x80 | op; return Buffer.concat([h, payload]);
}
server.on("upgrade", (req, sock) => {
  if (new URL(req.url, "http://x").pathname !== "/ws" || !req.headers["sec-websocket-key"]) { sock.destroy(); return; }
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  sock.setNoDelay(true);
  const c = { id: crypto.randomBytes(8).toString("hex"), rooms: new Set(), alive: true, buf: Buffer.alloc(0), frag: null,
    send(s) { if (!sock.destroyed) sock.write(wsFrame(1, Buffer.from(s))); } };
  conns.set(c.id, c);
  c.send(JSON.stringify({ t: "hello", id: c.id }));
  const close = () => { if (!conns.has(c.id)) return; conns.delete(c.id); for (const r of [...c.rooms]) leaveRoom(c, r); sock.destroy(); };
  sock.on("data", d => {
    c.buf = Buffer.concat([c.buf, d]); c.alive = true;
    while (c.buf.length >= 2) {
      const b0 = c.buf[0], b1 = c.buf[1], fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80; let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG) return close();
      const mk = masked ? 4 : 0; if (c.buf.length < off + mk + len) return;
      let p = c.buf.subarray(off + mk, off + mk + len);
      if (masked) { const key = c.buf.subarray(off, off + 4); p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= key[i & 3]; }
      c.buf = c.buf.subarray(off + mk + len);
      if (op === 8) { try { sock.write(wsFrame(8, Buffer.alloc(0))); } catch (e) {} return close(); }
      if (op === 9) { sock.write(wsFrame(10, p)); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 0) {
        c.frag = op === 1 ? [p] : (c.frag ? (c.frag.push(p), c.frag) : null);
        if (!c.frag) continue;
        if (c.frag.reduce((a, x) => a + x.length, 0) > MAX_MSG) return close();
        if (fin) { const txt = Buffer.concat(c.frag).toString("utf8"); c.frag = null; try { handle(c, JSON.parse(txt)); } catch (e) {} }
      }
    }
  });
  sock.on("close", close); sock.on("error", close);
});
setInterval(() => { for (const c of conns.values()) { c.send(JSON.stringify({ t: "ping" })); } }, 25000);

server.listen(PORT, () => console.log(`Spotlight Quiz running on port ${PORT}${API_KEY ? " (Claude questions on)" : " (built-in questions only)"}`));
