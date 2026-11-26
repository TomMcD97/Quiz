/* Dougle server
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
/* one-off score corrections the owner asked for, applied once after the store loads (a marker stops them running twice) */
const FIXES = [
  { id: "phil-1057-2026-11-17", nick: "PhilEatsToast", score: 1057, kind: "dq" },
  { id: "phil-reset-2026-11-18", nick: "PhilEatsToast", day: "2026-11-18", kind: "dqreset" },
  { id: "new-set-2026-11-20", day: "2026-11-20", kind: "dqresetall" } /* today's daily swapped for a new set: everyone's go on the old set (Tom and Lizzie included) is wiped */,
  { id: "easier-set-2026-11-20", day: "2026-11-20", kind: "dqresetall" }, /* and again for the easier replacement set */
  { id: "mix-set-2026-11-20", day: "2026-11-20", kind: "dqresetall" },
  { id: "easier-mix-2026-11-23", day: "2026-11-23", kind: "dqresetall" } /* 23 Nov: everyone's go wiped for the easier 3/4/3 set */ /* and again for the 2 easy / 5 medium / 3 hard set */
];
ready.then(() => {
  for (const f of FIXES) {
    const mark = "fix/" + f.id; if (store[mark]) continue;
    if (f.kind === "dqresetall") { /* wipe every go at one day's daily quiz, plus any saved copy of its questions */
      let n = 0, u = 0;
      for (const sk of Object.keys(store)) if (new RegExp("^dq\\d*/" + f.day + "(/scores/[^/]+)?$").test(sk)) { delete store[sk]; gone.add(sk); dirty.delete(sk); n++; }
      for (const k of Object.keys(store)) if (/^users\/[^/]+$/.test(k) && store[k] && store[k].dq && store[k].dq[f.day]) {
        const p = Object.assign({}, store[k]); p.dq = Object.assign({}, p.dq); delete p.dq[f.day]; p.dqr = Object.assign({}, p.dqr || {}, { [f.day]: Date.now() }); store[k] = p; save(k); u++; }
      store[mark] = { at: Date.now(), day: f.day, scores: n, users: u }; save(mark);
      console.log(`Fix ${f.id}: ${f.day} daily wiped (${n} items, ${u} accounts)`); continue;
    }
    if (f.kind === "dqreset") { /* wipe one player's go at a daily quiz so they can play it again */
      const uk = Object.keys(store).filter(k => /^users\/[^/]+$/.test(k) && String((store[k] || {}).name || "").toLowerCase() === f.nick.toLowerCase());
      if (!uk.length) { console.log(`Fix ${f.id}: no account found for ${f.nick}`); continue; }
      for (const k of uk) {
        const id = k.slice(6), p = Object.assign({}, store[k]);
        if (p.dq) { p.dq = Object.assign({}, p.dq); delete p.dq[f.day]; }
        p.dqr = Object.assign({}, p.dqr || {}, { [f.day]: Date.now() }); store[k] = p; save(k);
        for (const sk of Object.keys(store)) if (new RegExp("^dq\\d*/" + f.day + "/scores/" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$").test(sk)) { delete store[sk]; gone.add(sk); dirty.delete(sk); save(); }
      }
      store[mark] = { at: Date.now(), day: f.day }; save(mark);
      console.log(`Fix ${f.id}: ${f.nick}'s ${f.day} daily quiz reset`); continue;
    }
    const re = f.kind === "dq" ? /^dq\d*\/(\d{4}-\d\d-\d\d)\/scores\/([^/]+)$/ : /^dg\d*\/(\d{4}-\d\d-\d\d)\/scores\/([^/]+)$/;
    const hits = Object.keys(store).map(k => { const m = re.exec(k); return m && store[k] && String(store[k].nick || "").toLowerCase() === f.nick.toLowerCase() ? { k, day: m[1], id: m[2] } : null; }).filter(Boolean);
    if (!hits.length) { console.log(`Fix ${f.id}: no score found for ${f.nick}`); continue; }
    const day = hits.map(h => h.day).sort().pop(); /* their most recent daily */
    for (const h of hits.filter(h => h.day === day)) { store[h.k] = Object.assign({}, store[h.k], { score: f.score }); save(h.k);
      const up = "users/" + (store[h.k].uid || h.id); if (store[up] && store[up][f.kind] && store[up][f.kind][day]) { store[up][f.kind][day].score = f.score; save(up); } }
    store[mark] = { at: Date.now(), day }; save(mark);
    console.log(`Fix ${f.id}: ${f.nick}'s ${day} score set to ${f.score}`);
  }
});
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
function profileOut(user) { const p = store["users/" + user.id] || {}; return { id: user.id, email: user.email, name: p.name || user.name || "", av: p.av || null, dq: p.dq || {}, dg: p.dg || {}, dqr: p.dqr || {}, sj: p.sj || {} }; }
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
      try {
        const j = await sbFetch("/auth/v1/token?grant_type=refresh_token", { method: "POST", headers: { apikey: SB_ANON, "content-type": "application/json" }, body: JSON.stringify({ refresh_token: String(b.refresh_token || "") }) });
        return json(res, 200, { session: sessOut(j) });
      } catch (e) { /* only tell the page to log out when Supabase says the refresh token itself is no good */
        const dead = (e.status === 400 || e.status === 401 || e.status === 403) && /refresh|invalid|not found|revoked|expired|already used/i.test(String(e.message || "") + JSON.stringify(e.body || {}));
        return json(res, dead ? 401 : 503, { error: String(e.message || e), code: dead ? "invalid_refresh" : "try_again" });
      }
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
      if (b.sjd && typeof b.sjd === "object") { // subject stats: add this device's new right/total counts
        p.sj = Object.assign({}, p.sj || {});
        for (const [k, v] of Object.entries(b.sjd).slice(0, 40)) { if (typeof k !== "string" || k.length > 40 || !Array.isArray(v)) continue; const r = Math.max(0, Math.min(500, v[0] | 0)), t = Math.max(0, Math.min(500, v[1] | 0)); if (!t || r > t) continue; const o = p.sj[k] || [0, 0]; p.sj[k] = [o[0] + r, o[1] + t]; }
      }
      for (const f of ["dq", "dg"]) if (b[f] && typeof b[f] === "object") { // daily results by date, for streaks on every device
        p[f] = Object.assign({}, p[f] || {});
        for (const [d, v] of Object.entries(b[f])) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v && typeof v === "object") {
          const old = p[f][d] || {}; // once a day is marked as started or played, it stays that way
          p[f][d] = { score: Math.max(+old.score || 0, +v.score || 0), n: Math.max(+old.n || 0, +v.n || 0), started: 1, guest: old.guest || (v.guest ? 1 : 0) || undefined, r4: old.r4 || (v.r4 ? 1 : 0) || undefined, rv: Math.max(+old.rv || 0, +v.rv || 0) || undefined };
          if (!p[f][d].guest) delete p[f][d].guest; if (!p[f][d].r4) delete p[f][d].r4; if (!p[f][d].rv) delete p[f][d].rv;
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

/* ---------------- reports, error log, owner stats (Nov 2026) ---------------- */
/* the game page, kept ready-compressed in memory (re-read if the file changes) */
let PAGEC = null;
function pageC() { const z = require("zlib"), st = fs.statSync(PAGE); if (PAGEC && PAGEC.m === st.mtimeMs) return PAGEC; const body = fs.readFileSync(PAGE);
  PAGEC = { m: st.mtimeMs, body, br: z.brotliCompressSync(body, { params: { [z.constants.BROTLI_PARAM_QUALITY]: 11, [z.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }), gz: z.gzipSync(body, { level: 9 }), etag: '"' + crypto.createHash("sha1").update(body).digest("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 20) + '"' }; return PAGEC; }
/* the word grid dictionary: its own file, so it isn't part of the first download and phones keep it */
let DICTC = null; function dictC() { if (!DICTC) DICTC = fs.readFileSync(path.join(__dirname, "dict.gz")); return DICTC; }
setTimeout(() => { try { pageC(); } catch (e) {} }, 100);
const STATIC = { "/og.png": ["og.png", "image/png"], "/icon-192.png": ["icon-192.png", "image/png"], "/icon-512.png": ["icon-512.png", "image/png"], "/apple-touch-icon.png": ["icon-180.png", "image/png"], "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"] };
const hits = new Map(); /* simple per-IP rate limit for reports and error logs */
function tooMany(req, kind, max) { const k = kind + ":" + ipOf(req), now = Date.now(), h = (hits.get(k) || []).filter(t => now - t < 3600e3); h.push(now); hits.set(k, h); return h.length > max; }
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
async function reportRoute(req, res) {
  if (tooMany(req, "rep", 30)) return json(res, 429, { error: "slow_down" });
  const b = await readBody(req, 4000); const id = Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
  store["reports/" + id] = { text: clip(b.text, 300), answer: clip(b.answer, 300), t: clip(b.t, 8), cat: clip(b.cat, 40), reason: clip(b.reason, 60), src: clip(b.src, 10), day: clip(b.day, 10), by: clip(b.by, 18), at: Date.now() };
  save("reports/" + id); return json(res, 200, { ok: true });
}
const errRing = [];
async function logRoute(req, res) {
  if (tooMany(req, "log", 60)) return json(res, 429, { error: "slow_down" });
  const b = await readBody(req, 4000); const e = { msg: clip(b.msg, 300), src: clip(b.src, 120), line: +b.line || 0, ua: clip(req.headers["user-agent"], 120), at: Date.now(), v: clip(b.v, 20) };
  errRing.push(e); if (errRing.length > 300) errRing.shift();
  const day = new Date().toISOString().slice(0, 10), k = "errlog/" + day, cur = store[k] || { items: [] };
  if (cur.items.length < 200) { cur.items.push(e); store[k] = cur; save(k); }
  return json(res, 200, { ok: true });
}
/* count parties per day: a live party is a room called sq-xxxx */
function noteParty(name, isNew) { if (!/^(p:)?sq-[a-z]{4}$/.test(name)) return; const day = new Date().toISOString().slice(0, 10), k = "stats/" + day, s = store[k] || { parties: 0, joins: 0 };
  if (isNew) s.parties++; s.joins++; store[k] = s; save(k); }
function adminRoute(req, res, url) {
  const key = process.env.ADMIN_KEY || "";
  if (!key || url.searchParams.get("key") !== key) { res.writeHead(403, { "content-type": "text/plain" }); return res.end(key ? "Wrong key" : "Set ADMIN_KEY in Render's environment settings to use this page."); }
  const days = []; for (let i = 0; i < 14; i++) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  const keys = Object.keys(store), count = re => keys.filter(k => re.test(k)).length;
  const rows = days.map(d => { const st = store["stats/" + d] || {}; return { d, dq: count(new RegExp("^dq\\d*/" + d + "/scores/")), dg: count(new RegExp("^dg\\d*/" + d + "/scores/")), parties: st.parties || 0, joins: st.joins || 0 }; });
  const users = count(/^users\/[^/]+$/), reps = keys.filter(k => k.startsWith("reports/")).map(k => store[k]).sort((a, b) => b.at - a.at).slice(0, 60);
  const errs = errRing.slice(-40).reverse(), live = [...rooms.keys()].filter(n => /^(p:)?sq-[a-z]{4}$/.test(n) && rooms.get(n).members.size);
  const e = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const t = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dougle admin</title><style>body{font:15px/1.45 system-ui,sans-serif;background:#0b0b0c;color:#eee;margin:0;padding:20px max(16px,env(safe-area-inset-left))}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #2a2a2e;padding:7px 6px;text-align:left;vertical-align:top}th{color:#999;font-weight:600}.n{font-variant-numeric:tabular-nums;text-align:right}.m{color:#999}.box{overflow-x:auto}.big{display:flex;gap:12px;flex-wrap:wrap}.big div{border:1px solid #2a2a2e;border-radius:12px;padding:12px 16px}.big b{display:block;font-size:26px}</style>
<h1>Dougle</h1><div class="m">Owner stats · ${e(t)}</div>
<div class="big" style="margin-top:16px"><div><b>${rows[0].dq}</b>daily quiz players today</div><div><b>${rows[0].dg}</b>word grid players today</div><div><b>${rows[0].parties}</b>parties today</div><div><b>${live.length}</b>parties live now</div><div><b>${users}</b>accounts</div></div>
<h2>Last 14 days</h2><div class="box"><table><tr><th>Day</th><th class="n">Daily quiz</th><th class="n">Word grid</th><th class="n">Parties</th><th class="n">Party joins</th></tr>${rows.map(r => `<tr><td>${r.d}</td><td class="n">${r.dq}</td><td class="n">${r.dg}</td><td class="n">${r.parties}</td><td class="n">${r.joins}</td></tr>`).join("")}</table></div>
<p class="m">Daily counts are players with an account on the leaderboard. Party counts started on the day this page went live.</p>
<h2>Reported questions (${reps.length})</h2><div class="box"><table><tr><th>When</th><th>Reason</th><th>Question</th><th>Answer given</th><th>Where</th></tr>${reps.map(r => `<tr><td class="m">${e(new Date(r.at).toLocaleString("en-GB", { timeZone: "Europe/London" }))}</td><td>${e(r.reason)}</td><td>${e(r.text)}</td><td>${e(r.answer)}</td><td class="m">${e(r.src)}${r.cat ? " · " + e(r.cat) : ""}${r.by ? " · " + e(r.by) : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="m">None yet</td></tr>`}</table></div>
<h2>Recent errors from players' phones (${errs.length})</h2><div class="box"><table><tr><th>When</th><th>Error</th><th>Device</th></tr>${errs.map(x => `<tr><td class="m">${e(new Date(x.at).toLocaleTimeString("en-GB", { timeZone: "Europe/London" }))}</td><td>${e(x.msg)}<div class="m">${e(x.src)}:${x.line}</div></td><td class="m">${e(x.ua)}</td></tr>`).join("") || `<tr><td colspan="3" class="m">None since the last restart</td></tr>`}</table></div>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html);
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

/* ---------------- world map data ----------------
   Fetched once from public map sources by the server, slimmed down, cached and served from this site,
   so phones never depend on a third-party CDN to draw the country borders. */
const zlib = require("zlib");
const GEO_SRC = {
  low: [
    "https://cdn.jsdelivr.net/npm/@amcharts/amcharts5-geodata@5/json/worldLow.json",
    "https://unpkg.com/@amcharts/amcharts5-geodata@5/json/worldLow.json",
    "https://cdn.jsdelivr.net/npm/@amcharts/amcharts5-geodata@5/worldLow.js",
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson",
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"
  ],
  high: [
    "https://cdn.jsdelivr.net/npm/@amcharts/amcharts5-geodata@5/json/worldHigh.json",
    "https://unpkg.com/@amcharts/amcharts5-geodata@5/json/worldHigh.json",
    "https://cdn.jsdelivr.net/npm/@amcharts/amcharts5-geodata@5/worldHigh.js",
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
  ]
};
const geoCache = {}, geoWait = {};
function geoSlim(j) {
  const r = n => Math.round(n * 1000) / 1000;
  const ring = a => Array.isArray(a[0]) ? a.map(ring) : [r(a[0]), r(a[1])];
  const features = (j.features || []).filter(f => f && f.geometry).map(f => {
    const p = f.properties || {};
    return { type: "Feature", properties: { name: p.name || p.ADMIN || p.NAME || p.admin || "" }, geometry: { type: f.geometry.type, coordinates: ring(f.geometry.coordinates) } };
  });
  return { type: "FeatureCollection", features };
}
async function geoFetch(kind) {
  for (const u of GEO_SRC[kind]) {
    try {
      const r = await fetch(u, { headers: { "user-agent": "spotlight-quiz" } }); if (!r.ok) continue;
      let t = await r.text(), j = null;
      try { j = JSON.parse(t); } catch (e) { const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a >= 0 && b > a) { try { j = JSON.parse(t.slice(a, b + 1)); } catch (e2) { try { j = Function('"use strict";return (' + t.slice(a, b + 1) + ")")(); } catch (e3) {} } } }
      if (!j || !Array.isArray(j.features) || j.features.length < 100) continue;
      const body = Buffer.from(JSON.stringify(geoSlim(j)));
      console.log(`Map data (${kind}) loaded from ${u}: ${j.features.length} countries, ${Math.round(body.length / 1024)} KB`);
      return { body, gz: zlib.gzipSync(body), src: u };
    } catch (e) {}
  }
  return null;
}
function geoGet(kind) {
  if (geoCache[kind]) return Promise.resolve(geoCache[kind]);
  if (!geoWait[kind]) geoWait[kind] = geoFetch(kind).then(d => { geoWait[kind] = null; if (d) geoCache[kind] = d; return d; });
  return geoWait[kind];
}
setTimeout(() => { geoGet("low").then(() => geoGet("high")); }, 1500); /* warm the cache at start-up */

/* ---- Moving house: spotlightquiz.app now lives at dougle.app ----
   A phone's saved data (login, streak, avatar, leagues) belongs to the address it was saved under,
   so old-address pages get a tiny hand-off page that packs that data into the link and carries it across.
   The API and live-game socket keep answering on the old address so any tab already open finishes its game. */
const NEW_HOST = "dougle.app";
const OLD_HOST = /(^|\.)spotlightquiz\.app$/i;
const MOVE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dougle</title><meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:site_name" content="Dougle"><meta property="og:title" content="Dougle – Quiz night on everyone's phone">
<meta property="og:description" content="Daily quiz, word grid and live party quiz games you play together on your phones.">
<meta property="og:image" content="https://${NEW_HOST}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://${NEW_HOST}/og.png">
<noscript><meta http-equiv="refresh" content="0;url=https://${NEW_HOST}/"></noscript>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#f3f2f0;font:600 18px/1.4 system-ui,sans-serif;text-align:center;padding:24px}a{color:#ff8f6b}</style></head>
<body><div>Spotlight Quiz is now <b>Dougle</b>.<br>Taking you there…<br><br><a id="go" href="https://${NEW_HOST}/">Go to dougle.app</a></div>
<script>(function(){
  var dest="https://${NEW_HOST}"+location.pathname+location.search, d={}, n=0;
  try{ for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if(k&&k.indexOf("sq-")===0){ d[k]=localStorage.getItem(k); n++; } } }catch(e){}
  var pack=function(o){ try{ return n?"#sqmove="+encodeURIComponent(JSON.stringify(o)):""; }catch(e){ return ""; } };
  var h=pack(d);
  if(h.length>1500000){ for(var k in d){ if(/selfie|charkeys|port-/.test(k)) delete d[k]; } h=pack(d); } /* very long links can fail: drop the big image caches, keep the rest */
  if(h.length>1500000) h="";
  document.getElementById("go").href=dest+h;
  location.replace(dest+h);
})();</script></body></html>`;
function moveIfOld(req, res, url) {
  const host = String(req.headers.host || "").split(":")[0];
  if (!OLD_HOST.test(host)) return false;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname === "/healthz") return false;
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(MOVE_PAGE); return true;
  }
  res.writeHead(301, { location: "https://" + NEW_HOST + url.pathname + url.search, "cache-control": "max-age=3600" });
  res.end(); return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (moveIfOld(req, res, url)) return;
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      /* the page is sent compressed (about a third of the size), and a phone that already has this version is told "no change" instead of downloading it again */
      const pc = pageC(), ae = req.headers["accept-encoding"] || "";
      const h = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "etag": pc.etag, "vary": "accept-encoding" };
      if ((req.headers["if-none-match"] || "") === pc.etag) { res.writeHead(304, h); return res.end(); }
      if (/\bbr\b/.test(ae)) { res.writeHead(200, Object.assign(h, { "content-encoding": "br" })); return res.end(pc.br); }
      if (/\bgzip\b/.test(ae)) { res.writeHead(200, Object.assign(h, { "content-encoding": "gzip" })); return res.end(pc.gz); }
      res.writeHead(200, h); return res.end(pc.body);
    }
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "GET" && (url.pathname === "/geo/low.json" || url.pathname === "/geo/high.json")) {
      const d = await geoGet(url.pathname.includes("high") ? "high" : "low");
      if (!d) return json(res, 503, { error: "map data unavailable" });
      const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
      res.writeHead(200, Object.assign({ "content-type": "application/json", "cache-control": "public, max-age=604800", "access-control-allow-origin": "*" }, gz ? { "content-encoding": "gzip" } : {}));
      return res.end(gz ? d.gz : d.body);
    }
    if (url.pathname === "/api/config") return json(res, 200, { ai: !!API_KEY, auth: SB_ON });
    if (url.pathname.startsWith("/api/auth/")) { await ready; return authRoute(req, res, url); }
    if (url.pathname === "/api/sample" && req.method === "POST") {
      if (!API_KEY) return json(res, 403, { code: "not_granted", message: "AI is off on this server" });
      if (!aiAllowed(ipOf(req))) return json(res, 429, { code: "rate_limited", message: "Too many requests, try again later" });
      const b = await readBody(req, 12e6);
      try { return json(res, 200, { text: await callClaude(b) }); }
      catch (e) { return json(res, 502, { code: "upstream", message: String(e.message || e) }); }
    }
    if (url.pathname === "/api/report" && req.method === "POST") { await ready; return reportRoute(req, res); }
    if (url.pathname === "/api/log" && req.method === "POST") { await ready; return logRoute(req, res); }
    if (url.pathname === "/admin" && req.method === "GET") { await ready; return adminRoute(req, res, url); }
    /* face finding and head cut-out models, loaded only when someone uses "Use my face" */
    if (req.method === "GET" && url.pathname.startsWith("/face/")) {
      const rel = url.pathname.slice(6), fp = path.join(__dirname, "face", rel);
      if (!/^[a-z0-9_\-]+(\/[a-z0-9_\-]+)?\.(js|json|bin|wasm|tflite|binarypb|data)$/i.test(rel) || !fp.startsWith(path.join(__dirname, "face"))) { res.writeHead(404); return res.end(); }
      fs.readFile(fp, (err, body) => { if (err) { res.writeHead(404); return res.end(); }
        const ext = rel.split(".").pop(), type = { js: "text/javascript; charset=utf-8", json: "application/json", wasm: "application/wasm" }[ext] || "application/octet-stream";
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=2592000", "access-control-allow-origin": "*" }); res.end(body); });
      return;
    }
    if (req.method === "GET" && url.pathname === "/dict.gz") { try { const body = dictC(); res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" }); return res.end(body); } catch (e) { return json(res, 404, { error: "no dictionary" }); } }
    if (req.method === "GET" && STATIC[url.pathname]) { const f = STATIC[url.pathname]; try { const body = fs.readFileSync(path.join(__dirname, f[0])); res.writeHead(200, { "content-type": f[1], "cache-control": "public, max-age=86400" }); return res.end(body); } catch (e) {} }
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
  if (m.t === "join") { if (c.rooms.size >= 4 && !c.rooms.has(m.room)) return; const isNew = !rooms.has(m.room); const r = roomOf(m.room); if (!r.members.has(c.id)) { try { noteParty(m.room, isNew); } catch (e) {} } if (r.members.size >= 60 && !r.members.has(c.id)) return c.send(JSON.stringify({ t: "full", room: m.room }));
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

server.listen(PORT, () => console.log(`Dougle running on port ${PORT}${API_KEY ? " (Claude questions on)" : " (built-in questions only)"}${SB_ON ? ", accounts + Supabase storage on" : ", accounts off (data.json storage)"}`));
