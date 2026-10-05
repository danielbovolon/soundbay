// Soundbay account API — Cloudflare Worker + D1
// Accounts (email + password), sessions, and each user's saved entries.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

const DAY = 86400000;
const SESSION_DAYS = 90;
const MAX_ITEM_BYTES = 1_000_000; // one note, plan or sketch
const MAX_ITEMS = 5000; // per account
const LOCK_AFTER = 5; // failed sign-ins
const LOCK_MINUTES = 15;
const PBKDF2_ITERATIONS = 100000; // Workers' maximum

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return hex(bits);
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin) && !allowed.includes("*")) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function newSession(env, userId, email) {
  const token = rand(32);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)").bind(
      await sha256(token),
      userId,
      now + SESSION_DAYS * DAY
    ),
    env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(now),
  ]);
  return { token, email };
}

async function currentUser(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  const th = await sha256(m[1]);
  const row = await env.DB.prepare(
    "SELECT s.user_id AS id, u.email AS email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?"
  )
    .bind(th, Date.now())
    .first();
  return row ? { ...row, th } : null;
}

async function signup(req, env, h) {
  const b = await readJson(req);
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400, h);
  if (password.length < 8 || password.length > 200)
    return json({ error: "Use a password of at least 8 characters." }, 400, h);
  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) return json({ error: "An account with this email already exists. Sign in instead." }, 409, h);
  const id = rand(12);
  const salt = rand(16);
  await env.DB.prepare("INSERT INTO users (id, email, pw_hash, salt, created) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, await hashPassword(password, salt), salt, Date.now())
    .run();
  return json(await newSession(env, id, email), 200, h);
}

async function login(req, env, h) {
  const b = await readJson(req);
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  const wrong = { error: "That email and password don’t match an account." };
  const u = await env.DB.prepare("SELECT id, pw_hash, salt, fails, locked_until FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (!u) {
    await hashPassword(password, "timing-equaliser");
    return json(wrong, 401, h);
  }
  const now = Date.now();
  if (u.locked_until > now) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429, h);
  if (!same(await hashPassword(password, u.salt), u.pw_hash)) {
    const fails = u.fails + 1;
    const lock = fails >= LOCK_AFTER;
    await env.DB.prepare("UPDATE users SET fails = ?, locked_until = ? WHERE id = ?")
      .bind(lock ? 0 : fails, lock ? now + LOCK_MINUTES * 60000 : 0, u.id)
      .run();
    return json(lock ? { error: "Too many attempts. Try again in 15 minutes." } : wrong, lock ? 429 : 401, h);
  }
  if (u.fails) await env.DB.prepare("UPDATE users SET fails = 0 WHERE id = ?").bind(u.id).run();
  return json(await newSession(env, u.id, email), 200, h);
}

export default {
  async fetch(req, env) {
    const h = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") return json({ ok: true }, 200, h);
      if (path === "/api/signup" && req.method === "POST") return await signup(req, env, h);
      if (path === "/api/login" && req.method === "POST") return await login(req, env, h);

      const user = await currentUser(req, env);
      if (!user) return json({ error: "Your session has ended. Sign in again." }, 401, h);

      if (path === "/api/logout" && req.method === "POST") {
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.th).run();
        return json({ ok: true }, 200, h);
      }

      if (path === "/api/me" && req.method === "GET") return json({ email: user.email }, 200, h);

      // Changes since a server timestamp. The client keeps the returned `now` for the next call.
      if (path === "/api/items" && req.method === "GET") {
        const since = Number(url.searchParams.get("since")) || 0;
        const now = Date.now();
        const r = await env.DB.prepare(
          "SELECT id, kind, data, updated, deleted FROM items WHERE user_id = ? AND srv >= ? ORDER BY srv"
        )
          .bind(user.id, since)
          .all();
        return json({ items: r.results, now }, 200, h);
      }

      const m = path.match(/^\/api\/items\/([A-Za-z0-9._~-]{1,80})$/);
      if (m && req.method === "PUT") {
        const b = await readJson(req);
        const data = String(b.data || "");
        if (enc.encode(data).length > MAX_ITEM_BYTES)
          return json({ error: "This entry is too large to sync (over 1 MB). Split the sketch or note." }, 413, h);
        const updated = Number(b.updated) || Date.now();
        const existing = await env.DB.prepare("SELECT updated, deleted FROM items WHERE user_id = ? AND id = ?")
          .bind(user.id, m[1])
          .first();
        if (!existing || existing.deleted) {
          const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND deleted = 0")
            .bind(user.id)
            .first();
          if (c.n >= MAX_ITEMS) return json({ error: `Your account is full (${MAX_ITEMS} entries).` }, 413, h);
        }
        if (existing && existing.updated > updated) return json({ ok: true, stale: true }, 200, h);
        await env.DB.prepare(
          `INSERT INTO items (user_id, id, kind, data, updated, deleted, srv) VALUES (?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT (user_id, id) DO UPDATE SET kind = excluded.kind, data = excluded.data,
           updated = excluded.updated, deleted = 0, srv = excluded.srv`
        )
          .bind(user.id, m[1], String(b.kind || "").slice(0, 20), data, updated, Date.now())
          .run();
        return json({ ok: true }, 200, h);
      }

      if (m && req.method === "DELETE") {
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO items (user_id, id, kind, data, updated, deleted, srv) VALUES (?, ?, '', '', ?, 1, ?)
           ON CONFLICT (user_id, id) DO UPDATE SET data = '', deleted = 1, updated = excluded.updated, srv = excluded.srv`
        )
          .bind(user.id, m[1], now, now)
          .run();
        return json({ ok: true }, 200, h);
      }

      if (path === "/api/account" && req.method === "DELETE") {
        const b = await readJson(req);
        const u = await env.DB.prepare("SELECT pw_hash, salt FROM users WHERE id = ?").bind(user.id).first();
        if (!u || !same(await hashPassword(String(b.password || ""), u.salt), u.pw_hash))
          return json({ error: "That password isn’t right." }, 403, h);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM items WHERE user_id = ?").bind(user.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
          env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
        ]);
        return json({ ok: true }, 200, h);
      }

      return json({ error: "Not found" }, 404, h);
    } catch (e) {
      console.error(e);
      return json({ error: "Something went wrong on the server. Try again." }, 500, h);
    }
  },
};
