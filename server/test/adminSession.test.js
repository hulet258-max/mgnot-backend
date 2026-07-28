const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ADMIN_SESSION_ERROR,
  ADMIN_SESSION_EXPIRED,
  SESSION_SECONDS,
  issueToken,
  readToken,
  requireAdmin
} = require("../src/services/adminSession");

test("admin sessions accept valid tokens and reject expired or tampered tokens", () => {
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_SESSION_SECRET = "admin-session-test-secret";
  try {
    const issuedAt = 1_800_000_000;
    const token = issueToken("operator", issuedAt);
    assert.deepEqual(readToken(token, issuedAt + 1), {
      sub: "operator",
      role: "platform_admin",
      exp: issuedAt + SESSION_SECONDS
    });
    assert.equal(readToken(token, issuedAt + SESSION_SECONDS), null);
    assert.equal(readToken(`${token}tampered`, issuedAt + 1), null);
    assert.equal(readToken("not-a-token", issuedAt + 1), null);
  } finally {
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = previousSecret;
  }
});

test("admin middleware returns the stable expired-session contract", () => {
  const req = { get: () => "" };
  const response = {};
  const res = {
    status(status) {
      response.status = status;
      return this;
    },
    json(body) {
      response.body = body;
      return body;
    }
  };

  requireAdmin(req, res, () => assert.fail("missing token must not call next"));

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    success: false,
    code: ADMIN_SESSION_EXPIRED,
    error: ADMIN_SESSION_ERROR
  });
});
