"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "wattwise.sqlite");
const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 310000;
const DEFAULT_SLABS = [{ upto: 100, rate: 3 }, { upto: 200, rate: 5 }, { upto: 400, rate: 7 }, { upto: null, rate: 9 }];
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS appliances (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    watts REAL NOT NULL CHECK (watts > 0),
    hours REAL NOT NULL CHECK (hours >= 0 AND hours <= 24),
    qty INTEGER NOT NULL CHECK (qty > 0)
  );
  CREATE TABLE IF NOT EXISTS rate_slabs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    upto REAL,
    rate REAL NOT NULL CHECK (rate >= 0),
    UNIQUE(user_id, position)
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_bill REAL CHECK (last_bill IS NULL OR last_bill >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bill_history (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    units REAL NOT NULL CHECK (units >= 0),
    bill REAL NOT NULL CHECK (bill >= 0),
    saved_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, month)
  );
`);

const q = {
  findUser: db.prepare("SELECT id, name, email, password_hash, password_salt FROM users WHERE email = ?"),
  insertUser: db.prepare("INSERT INTO users(name,email,password_hash,password_salt) VALUES(?,?,?,?)"),
  insertSession: db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)"),
  sessionUser: db.prepare("SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash=?"),
  getAppliances: db.prepare("SELECT name,watts,hours,qty FROM appliances WHERE user_id=? ORDER BY id"),
  getSlabs: db.prepare("SELECT upto,rate FROM rate_slabs WHERE user_id=? ORDER BY position"),
  getSettings: db.prepare("SELECT last_bill FROM user_settings WHERE user_id=?"),
  getHistory: db.prepare("SELECT month,units,bill,saved_at FROM bill_history WHERE user_id=? ORDER BY month DESC LIMIT 12"),
};

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...extraHeaders });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error("Invalid JSON."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((piece) => piece.trim().split(/=(.*)/s).slice(0, 2)).filter(([key, value]) => key && value !== undefined));
}
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function passwordHash(password, salt) { return crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256").toString("hex"); }
function safeEqual(a, b) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function currentUser(req) {
  const token = cookies(req).wattwise_session;
  if (!token || token.length > 200) return null;
  return q.sessionUser.get(hashToken(token), Date.now()) || null;
}
function sessionCookie(token) {
  return `wattwise_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
function clearCookie() { return "wattwise_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"; }
function cleanEmail(email) { return String(email || "").trim().toLowerCase(); }
function validAppliances(value) {
  return Array.isArray(value) && value.length <= 200 && value.every((a) => a && typeof a.name === "string" && a.name.trim().length > 0 && a.name.length <= 80 && Number.isFinite(Number(a.watts)) && Number(a.watts) > 0 && Number.isFinite(Number(a.hours)) && Number(a.hours) >= 0 && Number(a.hours) <= 24 && Number.isInteger(Number(a.qty)) && Number(a.qty) > 0 && Number(a.qty) <= 100);
}
function validSlabs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) return false;
  let previous = 0;
  for (let i = 0; i < value.length; i++) {
    const slab = value[i];
    if (!slab || !Number.isFinite(Number(slab.rate)) || Number(slab.rate) < 0) return false;
    if (i === value.length - 1) {
      if (slab.upto !== null && slab.upto !== "") return false;
    } else {
      const cap = Number(slab.upto);
      if (!Number.isFinite(cap) || cap <= previous) return false;
      previous = cap;
    }
  }
  return true;
}
function dashboardData(userId) {
  const settings = q.getSettings.get(userId);
  return {
    appliances: q.getAppliances.all(userId),
    slabs: q.getSlabs.all(userId).map((s) => ({ upto: s.upto, rate: s.rate })),
    lastBill: settings?.last_bill ?? "",
    history: q.getHistory.all(userId),
  };
}
function seedUser(userId) {
  const addSlab = db.prepare("INSERT INTO rate_slabs(user_id,position,upto,rate) VALUES(?,?,?,?)");
  DEFAULT_SLABS.forEach((s, i) => addSlab.run(userId, i, s.upto, s.rate));
  db.prepare("INSERT INTO user_settings(user_id,last_bill) VALUES(?,NULL)").run(userId);
}

async function handleApi(req, res, url) {
  const method = req.method;
  if (method === "POST" && url.pathname === "/api/signup") {
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const email = cleanEmail(body.email);
    const password = String(body.password || "");
    if (name.length < 2 || name.length > 80) return json(res, 400, { error: "Enter a name between 2 and 80 characters." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(res, 400, { error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 200) return json(res, 400, { error: "Password must be at least 8 characters." });
    if (body.terms !== true) return json(res, 400, { error: "Please accept the terms to create an account." });
    if (q.findUser.get(email)) return json(res, 409, { error: "An account with that email already exists." });
    const salt = crypto.randomBytes(16).toString("hex");
    const result = db.prepare("INSERT INTO users(name,email,password_hash,password_salt) VALUES(?,?,?,?)").run(name, email, passwordHash(password, salt), salt);
    const userId = Number(result.lastInsertRowid);
    seedUser(userId);
    const token = crypto.randomBytes(32).toString("base64url");
    q.insertSession.run(hashToken(token), userId, Date.now() + SESSION_DAYS * 86400000);
    return json(res, 201, { user: { id: userId, name, email } }, { "Set-Cookie": sessionCookie(token) });
  }

  if (method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    const user = q.findUser.get(cleanEmail(body.email));
    const password = String(body.password || "");
    if (!user || password.length > 200 || !safeEqual(passwordHash(password, user.password_salt), user.password_hash)) {
      return json(res, 401, { error: "Email or password is incorrect." });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    q.insertSession.run(hashToken(token), user.id, Date.now() + SESSION_DAYS * 86400000);
    return json(res, 200, { user: { id: user.id, name: user.name, email: user.email } }, { "Set-Cookie": sessionCookie(token) });
  }

  if (method === "POST" && url.pathname === "/api/logout") {
    const token = cookies(req).wattwise_session;
    if (token) q.deleteSession.run(hashToken(token));
    return json(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
  }

  const user = currentUser(req);
  if (method === "GET" && url.pathname === "/api/me") {
    return user ? json(res, 200, { user }) : json(res, 401, { error: "Sign in to continue." });
  }
  if (!user) return json(res, 401, { error: "Sign in to continue." });

  if (method === "GET" && url.pathname === "/api/dashboard") return json(res, 200, dashboardData(user.id));

  if (method === "PUT" && url.pathname === "/api/appliances") {
    const body = await readJson(req);
    if (!validAppliances(body.appliances)) return json(res, 400, { error: "Check appliance names, power, daily hours, and quantity." });
    const replace = db.prepare("DELETE FROM appliances WHERE user_id=?");
    const insert = db.prepare("INSERT INTO appliances(user_id,name,watts,hours,qty) VALUES(?,?,?,?,?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      replace.run(user.id);
      for (const a of body.appliances) insert.run(user.id, a.name.trim(), Number(a.watts), Number(a.hours), Number(a.qty));
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
    return json(res, 200, { appliances: q.getAppliances.all(user.id) });
  }

  if (method === "PUT" && url.pathname === "/api/rates") {
    const body = await readJson(req);
    if (!validSlabs(body.slabs)) return json(res, 400, { error: "Enter increasing unit limits, non-negative rates, and leave the final limit empty." });
    const replace = db.prepare("DELETE FROM rate_slabs WHERE user_id=?");
    const insert = db.prepare("INSERT INTO rate_slabs(user_id,position,upto,rate) VALUES(?,?,?,?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      replace.run(user.id);
      body.slabs.forEach((s, i) => insert.run(user.id, i, i === body.slabs.length - 1 ? null : Number(s.upto), Number(s.rate)));
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
    return json(res, 200, { slabs: q.getSlabs.all(user.id) });
  }

  if (method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJson(req);
    const lastBill = body.lastBill === "" || body.lastBill === null ? null : Number(body.lastBill);
    if (lastBill !== null && (!Number.isFinite(lastBill) || lastBill < 0 || lastBill > 100000000)) return json(res, 400, { error: "Enter a valid previous bill amount." });
    db.prepare("INSERT INTO user_settings(user_id,last_bill,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET last_bill=excluded.last_bill,updated_at=datetime('now')").run(user.id, lastBill);
    return json(res, 200, { lastBill: lastBill ?? "" });
  }

  if (method === "POST" && url.pathname === "/api/history") {
    const body = await readJson(req);
    const month = String(body.month || "");
    const units = Number(body.units);
    const bill = Number(body.bill);
    if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(units) || units < 0 || !Number.isFinite(bill) || bill < 0) return json(res, 400, { error: "Invalid monthly estimate." });
    db.prepare("INSERT INTO bill_history(user_id,month,units,bill) VALUES(?,?,?,?) ON CONFLICT(user_id,month) DO UPDATE SET units=excluded.units,bill=excluded.bill,saved_at=datetime('now')").run(user.id, month, units, bill);
    return json(res, 201, { history: q.getHistory.all(user.id) });
  }

  return json(res, 404, { error: "API route not found." });
}

function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end("Bad request"); return; }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(ROOT + path.sep) || filePath.startsWith(DATA_DIR + path.sep)) { res.writeHead(404).end("Not found"); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600" });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed." }, { Allow: "GET, HEAD" });
    return serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : "Something went wrong. Please try again." });
    else res.destroy();
    if (!err.status) console.error(err);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Wattwise is running at http://127.0.0.1:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});

function shutdown() { db.close(); server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
