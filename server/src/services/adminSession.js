const crypto = require("crypto");

const SESSION_SECONDS = 8 * 60 * 60;
const ADMIN_SESSION_EXPIRED = "ADMIN_SESSION_EXPIRED";
const ADMIN_SESSION_ERROR = "Admin session is missing or expired.";

function secret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.BOT_TOKEN || "local-admin-session-change-me";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function issueToken(username, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    role: "platform_admin",
    exp: nowSeconds + SESSION_SECONDS
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.exp > nowSeconds ? session : null;
  } catch (_) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const session = readToken(token);
  if (!session) {
    return res.status(401).json({
      success: false,
      code: ADMIN_SESSION_EXPIRED,
      error: ADMIN_SESSION_ERROR
    });
  }
  req.admin = session;
  return next();
}

module.exports = {
  ADMIN_SESSION_ERROR,
  ADMIN_SESSION_EXPIRED,
  SESSION_SECONDS,
  issueToken,
  readToken,
  requireAdmin,
  safeEqual
};
