/* Spotlight Quiz server
 * - serves the game (public/index.html)
 * - relays live multiplayer over WebSockets (/ws)
 * - optional: Claude-written questions via your Anthropic API key (/api/sample)
 * - small data store for the daily leaderboards (/api/db): kept in Supabase when configured, otherwise in data.json
 * - optional player accounts (email + password) through Supabase Auth (/api/auth/*)
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
const SB_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/(rest|auth)\/v1$/, ""); // tolerate a pasted ".../rest/v1/"
const SB_ANON = process.env.SUPABASE_ANON_KEY || "";        // the "anon" / "publishable" key
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY || "";  // the "service_role" / "secret" key: server only, never in the page
const SB_ON = !!(SB_URL && SB_ANON && SB_SERVICE);
const PAGE = fs.existsSync(path.join(__dirname, "index.html")) ? path.join(__dirname, "index.html") : path.join(__dirname, "public", "index.html");

/* ---------------- data store ---------------- */
/* Everything lives in memory for speed. With Supabase set up, each change is also written to its "kv" table and the
   whole table is loaded at start-up, so leaderboards and accounts survive restarts and redeploys. Without it, data.json. */
let store = {};
const sbHead = (key, extra) => Object.assign({ apikey: key, "content-type": "application/json" }, key.startsWith("eyJ") ? { authorization: "Bearer " + key } : {}, extra || {});
async function sbFetch(pathq, opts) {
  const r = await fetch(SB_URL + pathq, opts);
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
  if (!r.ok) { const e = new Error((j && (j.msg || j.message || j.error_description || j.error)) || ("HTTP " + r.status)); e.status = r.status; e.body = j; throw e; }
  return j;
}
const ready = (async () => {
  if (!SB_ON) { try { store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { store = {}; } return; }
  for (let off = 0; ; off += 1000) {
    let rows;
    try { rows = await sbFetch(`/rest/v1/kv?select=path,data&order=path&offset=${off}&limit=1000`, { headers: sbHead(SB_SERVICE) }); }
    catch (e) { console.error("Supabase: couldn't load the kv table. Did you run the setup SQL?", e.message); return; }
    for (const r of rows || []) store[r.path] = r.data;
    if (!rows || rows.length < 1000) break;
  }
  console.log("Supabase: loaded " + Object.keys(store).length + " saved items");
})();
const dirty = new Set(), gone = new Set(); let saveT = null;
function save(p) {
  if (p) { dirty.add(p); gone.delete(p); }
  clearTimeout(saveT); saveT = setTimeout(flush, SB_ON ? 300 : 1000);
}
async function flush() {
  if (!SB_ON) { fs.writeFile(DATA_FILE, JSON.stringify(store), () => {}); return; }
  const up = [...dirty].filter(p => p in store).map(p => ({ path: p, data: store[p], updated_at: new Date().toISOString() })); dirty.clear();
  const del = [...gone]; gone.clear();
  try {
    if (up.length) await sbFetch("/rest/v1/kv?on_conflict=path", { method: "POST", headers: sbHead(SB_SERVICE, { prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(up) });
    for (let i = 0; i < del.length; i += 50) await sbFetch("/rest/v1/kv?path=in.(" + del.slice(i, i + 50).map(p => '"' + p + '"').join(",") + ")", { method: "DELETE", headers: sbHead(SB_SERVICE, { prefer: "return=minimal" }) });
  } catch (e) { console.error("Supabase save failed, will retry:", e.message); up.forEach(r => dirty.add(r.path)); del.forEach(p => gone.add(p)); setTimeout(flush, 5000); }
}
const leases = {};
const okPath = p => typeof p === "string" && p.length < 300 && /^[A-Za-z0-9_.~:@+-]+(\/[A-Za-z0-9_.~:@+-]+)*$/.test(p) && p.split("/").length <= 8;
const DAILY = /^(daily|dq\d*|dg\d*)\//;
function prune() { // keep only the last 30 days of daily quizzes and grids (accounts are never pruned)
  const keys = Object.keys(store).filter(k => DAILY.test(k)); if (keys.length < 5000) return;
  const days = [...new Set(keys.map(k => k.split("/")[1]))].sort().reverse().slice(0, 30);
  for (const k of keys) if (!days.includes(k.split("/")[1])) { delete store[k]; gone.add(k); }
}
const SCORE = /^(daily|dq\d*|dg\d*)\/[^/]+\/scores\/([^/]+)$/;
function dbOp(b, user) {
  const p = b.path;
  if (!okPath(p)) return { error: "bad_path" };
  if (b.op === "set" && /^users\//.test(p)) return { error: "not_allowed" };
  if (b.op === "set" && SB_ON) { // with accounts on, a leaderboard score must come from that player's own account
    const m = SCORE.exec(p);
    if (m) {
      if (!user) return { error: "login_required", code: "login_required" };
      if (m[2] !== user.id) return { error: "not_allowed" };
      const prof = store["users/" + user.id] || {};
      // one go per day: the first score stands, and a game played as a guest before logging in doesn't count
      if (store[p]) return { error: "You've already played this one today.", code: "already_played" };
      const day = p.split("/")[1], kind = /^dg/.test(p) ? "dg" : "dq", ent = (prof[kind] || {})[day];
      if (ent && ent.guest) return { error: "Games played before logging in don't go on the leaderboard.", code: "already_played" };
      b.data = Object.assign({}, b.data || {}, { nick: String(prof.name || user.name || "Player").slice(0, 18), uid: user.id });
    }
  }
  if (b.op === "get") return store[p] ? { exists: true, data: store[p] } : { exists: false };
  if (b.op === "set") {
    const s = JSON.stringify(b.data || {}); if (s.length > 60000) return { error: "too_big" };
    store[p] = b.data || {}; prune(); save(p); return { ok: true };
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

/* ---------------- accounts (Supabase Auth, email + password) ---------------- */
const tokCache = new Map();
async function userOf(req) {
  if (!SB_ON) return null;
  const h = String(req.headers.authorization || ""); const tok = h.startsWith("Bearer ") ? h.slice(7) : ""; if (!tok || tok.length > 4000) return null;
  const c = tokCache.get(tok); if (c && c.until > Date.now()) return c.user;
  try { const u = await sbFetch("/auth/v1/user", { headers: { apikey: SB_ANON, authorization: "Bearer " + tok } });
    const user = u && u.id ? { id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.name) || "" } : null;
    if (tokCache.size > 5000) tokCache.clear(); tokCache.set(tok, { user, until: Date.now() + 5 * 60000 }); return user; }
  catch (e) { tokCache.set(tok, { user: null, until: Date.now() + 30000 }); return null; }
}
const cleanName = n => String(n || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 18);
const nameKey = n => cleanName(n).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
function nameTaken(n, exceptId) { // leaderboard names are unique, ignoring case, spaces and punctuation
  const k = nameKey(n); if (!k) return false;
  for (const key in store) if (key.startsWith("users/") && key !== "users/" + exceptId && nameKey((store[key] || {}).name) === k) return true;
  return false;
}
const TAKEN = "That name's already taken. Try another.";
function profileOut(user) { const p = store["users/" + user.id] || {}; return { id: user.id, email: user.email, name: p.name || user.name || "", av: p.av || null, dq: p.dq || {}, dg: p.dg || {} }; }
function sessOut(j) { return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)) }; }
const authTries = new Map();
function authAllowed(ip) { const now = Date.now(), a = (authTries.get(ip) || []).filter(t => now - t < 600000); if (a.length >= 30) return false; a.push(now); authTries.set(ip, a); return true; }
function friendly(e) {
  const m = String(e.message || "").toLowerCase();
  if (m.includes("invalid login")) return "That email and password don't match.";
  if (m.includes("not confirmed")) return "Check your inbox and tap the confirmation link first.";
  if (m.includes("already registered") || m.includes("already been registered")) return "There's already an account with that email. Try logging in.";
  if (m.includes("password") && (m.includes("6") || m.includes("short") || m.includes("weak"))) return "Use a longer password (at least 8 characters).";
  if (m.includes("rate") || e.status === 429) return "Too many tries. Wait a few minutes and try again.";
  if (m.includes("email") && m.includes("invalid")) return "That email address doesn't look right.";
  return "Something went wrong: " + (e.message || "try again");
}
async function authRoute(req, res, url) {
  const ip = ipOf(req), act = url.pathname.slice("/api/auth/".length), origin = (req.headers["x-forwarded-proto"] || "https") + "://" + req.headers.host + "/";
  if (!SB_ON) return json(res, 404, { error: "Accounts are off on this server" });
  if (req.method === "POST" && !["me", "profile", "refresh"].includes(act) && !authAllowed(ip)) return json(res, 429, { error: "Too many tries. Wait a few minutes and try again." });
  const b = req.method === "POST" ? await readBody(req, 20000) : {};
  const email = String(b.email || "").trim().toLowerCase().slice(0, 200), password = String(b.password || "").slice(0, 200);
  try {
    if (act === "signup") {
      const name = cleanName(b.name); if (!name || !nameKey(name)) return json(res, 400, { error: "Add a name for the leaderboard." });
      if (nameTaken(name, "")) return json(res, 400, { error: TAKEN, code: "name_taken" });
      if (password.length < 8) return json(res, 400, { error: "Use a longer password (at least 8 characters)." });
      const j = await sbFetch("/auth/v1/signup?redirect_to=" + encodeURIComponent(origin), { method: "POST", headers: { apikey: SB_ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password, data: { name } }) });
      const u = (j && (j.user || (j.id ? j : null))) || null;
      if (u && u.id && !store["users/" + u.id]) { store["users/" + u.id] = { name, av: b.av || null, at: Date.now() }; save("users/" + u.id); }
      if (j && j.access_token) return json(res, 200, { session: sessOut(j), profile: profileOut({ id: u.id, email, name }) });
      return json(res, 200, { confirm: true });
    }
    if (act === "login") {
      const j = await sbFetch("/auth/v1/token?grant_type=password", { method: "POST", headers: { apikey: SB_ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      const u = j.user; return json(res, 200, { session: sessOut(j), profile: profileOut({ id: u.id, email: u.email, name: (u.user_metadata || {}).name }) });
    }
    if (act === "refresh") {
      const j = await sbFetch("/auth/v1/token?grant_type=refresh_token", { method: "POST", headers: { apikey: SB_ANON, "content-type": "application/json" }, body: JSON.stringify({ refresh_token: String(b.refresh_token || "") }) });
      return json(res, 200, { session: sessOut(j) });
    }
    if (act === "forgot") {
      await sbFetch("/auth/v1/recover?redirect_to=" + encodeURIComponent(origin), { method: "POST", headers: { apikey: SB_ANON, "content-type": "application/json" }, body: JSON.stringify({ email, redirect_to: origin }) });
      return json(res, 200, { ok: true });
    }
    const user = await userOf(req); if (!user) return json(res, 401, { error: "Please log in again.", code: "login_required" });
    if (act === "me") return json(res, 200, { profile: profileOut(user) });
    if (act === "password") {
      if (password.length < 8) return json(res, 400, { error: "Use a longer password (at least 8 characters)." });
      await sbFetch("/auth/v1/user", { method: "PUT", headers: { apikey: SB_ANON, authorization: req.headers.authorization, "content-type": "application/json" }, body: JSON.stringify({ password }) });
      return json(res, 200, { ok: true });
    }
    if (act === "profile") {
      const k = "users/" + user.id, p = Object.assign({}, store[k] || {});
      if (b.name !== undefined) { const n = cleanName(b.name); if (n && nameKey(n)) { if (nameTaken(n, user.id)) return json(res, 400, { error: TAKEN, code: "name_taken" }); p.name = n; } }
      if (typeof b.av === "string" && b.av.length < 600) p.av = b.av;
      for (const f of ["dq", "dg"]) if (b[f] && typeof b[f] === "object") { // daily results by date, for streaks on every device
        p[f] = Object.assign({}, p[f] || {});
        for (const [d, v] of Object.entries(b[f])) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v && typeof v === "object") {
          const old = p[f][d] || {}; // once a day is marked as started or played, it stays that way
          p[f][d] = { score: Math.max(+old.score || 0, +v.score || 0), n: Math.max(+old.n || 0, +v.n || 0), started: 1, guest: old.guest || (v.guest ? 1 : 0) || undefined };
          if (!p[f][d].guest) delete p[f][d].guest;
        }
        const ks = Object.keys(p[f]).sort(); ks.slice(0, Math.max(0, ks.length - 120)).forEach(d => delete p[f][d]);
      }
      p.at = Date.now(); store[k] = p; save(k);
      return json(res, 200, { profile: profileOut(user) });
    }
    return json(res, 404, { error: "unknown" });
  } catch (e) { return json(res, e.status && e.status < 500 ? 400 : 502, { error: friendly(e) }); }
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
  if (Array.isArray(b._messages)) messages = b._messages;
  const body = { model: b.tier === "quick" ? MODEL_FAST : MODEL, max_tokens: 8000, messages };
  // b.web: let Claude search the web (used for the daily quiz's recent-news questions)
  if (b.web) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
  const content = j.content || [];
  // with web search on, keep only the text written after the last search result (the answer itself)
  let last = -1; content.forEach((c, i) => { if (c.type === "web_search_tool_result") last = i; });
  if (b.web && j.stop_reason === "pause_turn" && (b._turns || 0) < 3) return callClaude({ ...b, _turns: (b._turns || 0) + 1, _messages: [...messages, { role: "assistant", content }] });
  return content.slice(last + 1).filter(c => c.type === "text").map(c => c.text).join("");
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
    if (url.pathname === "/api/config") return json(res, 200, { ai: !!API_KEY, auth: SB_ON });
    if (url.pathname.startsWith("/api/auth/")) { await ready; return authRoute(req, res, url); }
    if (url.pathname === "/api/sample" && req.method === "POST") {
      if (!API_KEY) return json(res, 403, { code: "not_granted", message: "AI is off on this server" });
      if (!aiAllowed(ipOf(req))) return json(res, 429, { code: "rate_limited", message: "Too many requests, try again later" });
      const b = await readBody(req, 12e6);
      try { return json(res, 200, { text: await callClaude(b) }); }
      catch (e) { return json(res, 502, { code: "upstream", message: String(e.message || e) }); }
    }
    if (url.pathname === "/api/db" && req.method === "POST") {
      await ready; const b = await readBody(req, 100000); const r = dbOp(b, b.op === "set" ? await userOf(req) : null);
      return json(res, r.error ? (r.code === "login_required" ? 401 : 400) : 200, r);
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

server.listen(PORT, () => console.log(`Spotlight Quiz running on port ${PORT}${API_KEY ? " (Claude questions on)" : " (built-in questions only)"}${SB_ON ? ", accounts + Supabase storage on" : ", accounts off (data.json storage)"}`));
