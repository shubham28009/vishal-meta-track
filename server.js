require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { Pool } = require("pg");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const COOKIE_SECRET = process.env.COOKIE_SECRET || "";
const CHANNEL_NAME = process.env.CHANNEL_NAME || "VISHAL QX";

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use("/static", express.static(path.join(__dirname, "public")));

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}

function signSession(value) {
  return crypto.createHmac("sha256", COOKIE_SECRET || "dev-secret").update(value).digest("hex");
}

function createSessionCookie() {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 7;
  const value = String(exp);
  return `${value}.${signSession(value)}`;
}

function validSessionCookie(value) {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = signSession(exp);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD || !COOKIE_SECRET) {
    return res.status(500).json({ error: "ADMIN_PASSWORD and COOKIE_SECRET must be configured." });
  }
  if (validSessionCookie(req.cookies.admin_session)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function db(sql, params = []) {
  return pool.query(sql, params);
}

async function ensureSchema() {
  await db(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_updates (
      update_id BIGINT PRIMARY KEY,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS web_visits (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      utm_source TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      utm_medium TEXT,
      page TEXT,
      referrer TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS button_clicks (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      utm_source TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      destination TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS invite_links (
      id BIGSERIAL PRIMARY KEY,
      invite_link TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS telegram_users (
      telegram_user_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      language_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS join_requests (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      telegram_user_id BIGINT NOT NULL,
      invite_link TEXT,
      invite_name TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      left_at TIMESTAMPTZ,
      removed_at TIMESTAMPTZ,
      raw_update JSONB
    );
    CREATE TABLE IF NOT EXISTS member_events (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      telegram_user_id BIGINT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_update JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_web_visits_created_at ON web_visits(created_at);
    CREATE INDEX IF NOT EXISTS idx_button_clicks_created_at ON button_clicks(created_at);
    CREATE INDEX IF NOT EXISTS idx_join_requests_requested_at ON join_requests(requested_at);
    CREATE INDEX IF NOT EXISTS idx_join_requests_status ON join_requests(status);
    CREATE INDEX IF NOT EXISTS idx_join_requests_source ON join_requests(source);
    CREATE INDEX IF NOT EXISTS idx_join_requests_user ON join_requests(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_member_events_occurred_at ON member_events(occurred_at);
  `);
  await db(`
    DELETE FROM join_requests a
    USING join_requests b
    WHERE a.id > b.id
      AND a.chat_id = b.chat_id
      AND a.telegram_user_id = b.telegram_user_id
      AND a.status = 'pending'
      AND b.status = 'pending'
      AND ABS(EXTRACT(EPOCH FROM (a.requested_at - b.requested_at))) <= 2
  `);

  await db(
    `INSERT INTO settings(key,value) VALUES ('channel_name',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    [CHANNEL_NAME]
  );
}

async function telegram(method, body = {}) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not configured.");
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || `Telegram API error: ${method}`);
  return data.result;
}

function inferSource(name = "", link = "") {
  const s = `${name} ${link}`.toLowerCase();
  if (s.includes("facebook") || s.includes("fb")) return "facebook";
  if (s.includes("instagram") || s.includes("ig")) return "instagram";
  if (s.includes("meta")) return "meta";
  return "unknown";
}

async function setSetting(key, value) {
  await db(
    `INSERT INTO settings(key,value) VALUES($1,$2)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    [key, String(value)]
  );
}

async function getSetting(key) {
  const r = await db(`SELECT value FROM settings WHERE key=$1`, [key]);
  return r.rows[0]?.value || null;
}

async function setupWebhook() {
  if (!PUBLIC_URL || !BOT_TOKEN) return;
  const url = `${PUBLIC_URL}/webhook/telegram`;
  try {
    await telegram("setWebhook", {
      url,
      secret_token: WEBHOOK_SECRET || undefined,
      allowed_updates: ["chat_join_request", "chat_member", "my_chat_member"]
    });
    console.log("Telegram webhook configured:", url);
  } catch (e) {
    console.error("Webhook setup failed:", e.message);
  }
}

function renderLogin() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vishal QX Dashboard Login</title>
<style>
body{margin:0;font-family:Inter,Arial;background:#08111f;color:#fff;display:grid;place-items:center;min-height:100vh}
.card{width:min(400px,90vw);background:#111d31;border:1px solid #22334f;border-radius:18px;padding:28px;box-shadow:0 20px 70px #0008}
h1{margin:0 0 8px}.muted{color:#8ea2c0}.row{margin-top:20px}input{width:100%;padding:13px;border-radius:10px;border:1px solid #2d405f;background:#0a1424;color:#fff;box-sizing:border-box}button{margin-top:14px;width:100%;padding:13px;border:0;border-radius:10px;background:#2fa4ff;color:#fff;font-weight:700;cursor:pointer}
</style></head><body><div class="card"><h1>VISHAL QX</h1><div class="muted">Live Telegram Ads Dashboard</div>
<form method="post" action="/login"><div class="row"><input type="password" name="password" placeholder="Dashboard password" required></div><button>Login</button></form></div></body></html>`;
}

app.get("/health", async (_req, res) => {
  try {
    await db("SELECT 1");
    res.json({ ok: true, service: "vishal-qx-dashboard", time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.get("/", (req, res) => {
  if (validSessionCookie(req.cookies.admin_session)) return res.redirect("/admin");
  res.type("html").send(renderLogin());
});

app.post("/login", (req, res) => {
  if (!ADMIN_PASSWORD || req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).type("html").send(renderLogin().replace("</form>", '<div style="color:#ff7b7b;margin-top:12px">Invalid password</div></form>'));
  }
  res.cookie("admin_session", createSessionCookie(), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
  res.redirect("/admin");
});

app.get("/logout", (_req, res) => {
  res.clearCookie("admin_session");
  res.redirect("/");
});

app.get("/admin", requireAdmin, (_req, res) => {
  res.type("html").send(require("fs").readFileSync(path.join(__dirname, "public", "dashboard.html"), "utf8"));
});

app.get("/api/events", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: ready\ndata: {}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.get("/api/dashboard", requireAdmin, async (req, res) => {
  const range = ["today", "yesterday", "7d", "30d", "all"].includes(req.query.range) ? req.query.range : "today";
  let where = "";
  if (range === "today") where = `created_at >= CURRENT_DATE`;
  if (range === "yesterday") where = `created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE`;
  if (range === "7d") where = `created_at >= NOW() - INTERVAL '7 days'`;
  if (range === "30d") where = `created_at >= NOW() - INTERVAL '30 days'`;
  if (range === "all") where = "TRUE";

  const v = await db(`SELECT COUNT(*)::int AS n FROM web_visits WHERE ${where}`);
  const c = await db(`SELECT COUNT(*)::int AS n FROM button_clicks WHERE ${where}`);
  const r = await db(`SELECT COUNT(*)::int AS n FROM join_requests WHERE requested_at ${range === "all" ? "IS NOT NULL" : range === "today" ? ">= CURRENT_DATE" : range === "yesterday" ? ">= CURRENT_DATE - INTERVAL '1 day' AND requested_at < CURRENT_DATE" : range === "7d" ? ">= NOW() - INTERVAL '7 days'" : ">= NOW() - INTERVAL '30 days'"}`);
  const pending = await db(`SELECT COUNT(*)::int AS n FROM join_requests WHERE status='pending'`);
  const joined = await db(`SELECT COUNT(*)::int AS n FROM join_requests WHERE status='joined'`);
  const left = await db(`SELECT COUNT(*)::int AS n FROM join_requests WHERE status='left'`);
  const removed = await db(`SELECT COUNT(*)::int AS n FROM join_requests WHERE status='removed'`);

  const sources = await db(`
    SELECT source,
      COUNT(*)::int AS requests,
      COUNT(*) FILTER (WHERE status='joined')::int AS joined,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending
    FROM join_requests
    WHERE requested_at >= CASE
      WHEN $1='today' THEN CURRENT_DATE
      WHEN $1='yesterday' THEN CURRENT_DATE - INTERVAL '1 day'
      WHEN $1='7d' THEN NOW() - INTERVAL '7 days'
      WHEN $1='30d' THEN NOW() - INTERVAL '30 days'
      ELSE TIMESTAMPTZ '1970-01-01'
    END
    AND ($1 <> 'yesterday' OR requested_at < CURRENT_DATE)
    GROUP BY source ORDER BY requests DESC
  `, [range]);

  const latest = await db(`
    SELECT jr.id, jr.telegram_user_id, tu.username, tu.first_name, tu.last_name,
           jr.source, jr.status, jr.requested_at, jr.approved_at
    FROM join_requests jr
    LEFT JOIN telegram_users tu ON tu.telegram_user_id=jr.telegram_user_id
    ORDER BY jr.requested_at DESC LIMIT 100
  `);

  const inviteLinks = await db(`SELECT id, name, source, invite_link, created_at FROM invite_links ORDER BY created_at DESC`);

  res.json({
    range,
    channel_name: CHANNEL_NAME,
    funnel: {
      visitors: v.rows[0].n,
      clicks: c.rows[0].n,
      requests: r.rows[0].n
    },
    status: {
      pending: pending.rows[0].n,
      joined: joined.rows[0].n,
      left: left.rows[0].n,
      removed: removed.rows[0].n
    },
    sources: sources.rows,
    latest: latest.rows,
    invite_links: inviteLinks.rows
  });
});

app.post("/api/track/visit", async (req, res) => {
  const b = req.body || {};
  await db(`
    INSERT INTO web_visits(session_id,source,utm_source,utm_campaign,utm_content,utm_medium,page,referrer)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
  `, [
    b.session_id || null,
    b.source || "unknown",
    b.utm_source || null,
    b.utm_campaign || null,
    b.utm_content || null,
    b.utm_medium || null,
    b.page || null,
    b.referrer || null
  ]);
  broadcast("dashboard", { type: "visit" });
  res.json({ ok: true });
});

app.post("/api/track/click", async (req, res) => {
  const b = req.body || {};
  await db(`
    INSERT INTO button_clicks(session_id,source,utm_source,utm_campaign,utm_content,destination)
    VALUES($1,$2,$3,$4,$5,$6)
  `, [
    b.session_id || null,
    b.source || "unknown",
    b.utm_source || null,
    b.utm_campaign || null,
    b.utm_content || null,
    b.destination || null
  ]);
  broadcast("dashboard", { type: "click" });
  res.json({ ok: true });
});

app.get("/go", async (req, res) => {
  const source = String(req.query.source || "auto").toLowerCase();
  const sid = String(req.query.sid || "");
  const fb = process.env.FACEBOOK_INVITE_LINK;
  const ig = process.env.INSTAGRAM_INVITE_LINK;

  let link = null;
  if (source === "facebook") link = fb;
  else if (source === "instagram") link = ig;
  else link = fb || ig;

  if (!link) {
    return res.status(503).send("Invite link is not configured yet. Ask the administrator to create it.");
  }

  await db(
    `INSERT INTO button_clicks(session_id,source,destination) VALUES($1,$2,$3)`,
    [sid || null, source, link]
  );
  broadcast("dashboard", { type: "click" });
  return res.redirect(link);
});

app.get("/api/admin/invites", requireAdmin, async (_req, res) => {
  const r = await db(`SELECT * FROM invite_links ORDER BY created_at DESC`);
  res.json(r.rows);
});

app.post("/api/admin/create-invite", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const source = String(req.body.source || "unknown").trim().toLowerCase();
    if (!name) return res.status(400).json({ error: "Name is required." });

    let channelId = process.env.CHANNEL_ID || await getSetting("channel_id");
    if (!channelId) return res.status(400).json({ error: "Channel ID has not been detected yet. Send/approve a test join request first so the bot receives a channel update." });

    const result = await telegram("createChatInviteLink", {
      chat_id: channelId,
      name,
      creates_join_request: true
    });

    await db(`
      INSERT INTO invite_links(invite_link,name,source)
      VALUES($1,$2,$3)
      ON CONFLICT(invite_link) DO UPDATE SET name=EXCLUDED.name, source=EXCLUDED.source
    `, [result.invite_link, name, source]);

    const envKey = source === "facebook" ? "FACEBOOK_INVITE_LINK" : source === "instagram" ? "INSTAGRAM_INVITE_LINK" : null;
    if (envKey) {
      // We cannot mutate Railway environment variables from inside the app.
      // The URL is returned so it can be pasted into Railway Variables.
    }

    res.json({ ok: true, invite: result, env_key: envKey });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function handleJoinRequest(u) {
  const chat = u.chat;
  const user = u.from;
  const invite = u.invite_link || {};
  const source = inferSource(invite.name, invite.invite_link);

  await setSetting("channel_id", chat.id);

  await db(`
    INSERT INTO telegram_users(telegram_user_id,username,first_name,last_name,language_code,updated_at)
    VALUES($1,$2,$3,$4,$5,NOW())
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username=EXCLUDED.username, first_name=EXCLUDED.first_name,
      last_name=EXCLUDED.last_name, language_code=EXCLUDED.language_code,
      updated_at=NOW()
  `, [user.id, user.username || null, user.first_name || null, user.last_name || null, user.language_code || null]);

  const existingInvite = invite.invite_link
    ? await db(`SELECT source, name FROM invite_links WHERE invite_link=$1`, [invite.invite_link])
    : { rows: [] };

  const finalSource = existingInvite.rows[0]?.source || source;
  const finalName = existingInvite.rows[0]?.name || invite.name || null;

  const existingPending = await db(`
    SELECT id FROM join_requests
    WHERE chat_id=$1
      AND telegram_user_id=$2
      AND status='pending'
      AND requested_at >= NOW() - INTERVAL '10 minutes'
    ORDER BY requested_at DESC
    LIMIT 1
  `, [chat.id, user.id]);

  if (existingPending.rowCount > 0) return;

  const inserted = await db(`
    INSERT INTO join_requests(chat_id,telegram_user_id,invite_link,invite_name,source,status,raw_update)
    VALUES($1,$2,$3,$4,$5,'pending',$6)
    RETURNING id
  `, [chat.id, user.id, invite.invite_link || null, finalName, finalSource, JSON.stringify(u)]);

  broadcast("join_request", { id: inserted.rows[0].id, user_id: user.id, source: finalSource });
}

async function handleChatMember(u) {
  const chat = u.chat;
  const user = u.new_chat_member?.user;
  if (!chat || !user) return;

  await setSetting("channel_id", chat.id);

  const oldStatus = u.old_chat_member?.status || null;
  const newStatus = u.new_chat_member?.status || null;

  await db(`
    INSERT INTO telegram_users(telegram_user_id,username,first_name,last_name,language_code,updated_at)
    VALUES($1,$2,$3,$4,$5,NOW())
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username=EXCLUDED.username, first_name=EXCLUDED.first_name,
      last_name=EXCLUDED.last_name, language_code=EXCLUDED.language_code,
      updated_at=NOW()
  `, [user.id, user.username || null, user.first_name || null, user.last_name || null, user.language_code || null]);

  await db(`
    INSERT INTO member_events(chat_id,telegram_user_id,old_status,new_status,raw_update)
    VALUES($1,$2,$3,$4,$5)
  `, [chat.id, user.id, oldStatus, newStatus, JSON.stringify(u)]);

  if (newStatus === "member" || newStatus === "administrator") {
    await db(`
      UPDATE join_requests
      SET status='joined', approved_at=COALESCE(approved_at,NOW())
      WHERE chat_id=$1 AND telegram_user_id=$2 AND status='pending'
    `, [chat.id, user.id]);
  } else if (newStatus === "left") {
    await db(`
      UPDATE join_requests
      SET status='left', left_at=NOW()
      WHERE chat_id=$1 AND telegram_user_id=$2
        AND status='joined'
        AND id=(SELECT id FROM join_requests WHERE chat_id=$1 AND telegram_user_id=$2 ORDER BY requested_at DESC LIMIT 1)
    `, [chat.id, user.id]);
  } else if (newStatus === "kicked") {
    await db(`
      UPDATE join_requests
      SET status='removed', removed_at=NOW()
      WHERE chat_id=$1 AND telegram_user_id=$2
        AND id=(SELECT id FROM join_requests WHERE chat_id=$1 AND telegram_user_id=$2 ORDER BY requested_at DESC LIMIT 1)
    `, [chat.id, user.id]);
  }

  broadcast("member_update", { user_id: user.id, status: newStatus });
}

app.post("/webhook/telegram", async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const got = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (got !== WEBHOOK_SECRET) return res.sendStatus(403);
    }

    const update = req.body || {};
    if (Number.isSafeInteger(update.update_id)) {
      const seen = await db(
        `INSERT INTO processed_updates(update_id) VALUES($1) ON CONFLICT(update_id) DO NOTHING RETURNING update_id`,
        [update.update_id]
      );
      if (seen.rowCount === 0) return res.sendStatus(200);
    }

    if (update.chat_join_request) await handleJoinRequest(update.chat_join_request);
    if (update.chat_member) await handleChatMember(update.chat_member);

    res.sendStatus(200);
  } catch (e) {
    console.error("Telegram webhook error:", e);
    res.sendStatus(500);
  }
});

app.post("/api/admin/approve/:id", requireAdmin, async (req, res) => {
  try {
    const r = await db(`SELECT * FROM join_requests WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Request not found" });
    const jr = r.rows[0];

    await telegram("approveChatJoinRequest", {
      chat_id: jr.chat_id,
      user_id: jr.telegram_user_id
    });

    await db(`UPDATE join_requests SET status='joined', approved_at=NOW() WHERE id=$1`, [jr.id]);
    broadcast("member_update", { request_id: jr.id, status: "joined" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/decline/:id", requireAdmin, async (req, res) => {
  try {
    const r = await db(`SELECT * FROM join_requests WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Request not found" });
    const jr = r.rows[0];

    await telegram("declineChatJoinRequest", {
      chat_id: jr.chat_id,
      user_id: jr.telegram_user_id
    });

    await db(`UPDATE join_requests SET status='removed' WHERE id=$1`, [jr.id]);
    broadcast("member_update", { request_id: jr.id, status: "removed" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/static/dashboard.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

async function start() {
  await ensureSchema();
  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Vishal QX dashboard listening on ${PORT}`);
    await setupWebhook();
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
