const assert = require("node:assert/strict");
const test = require("node:test");
const { _internals } = require("../src/routes/user/user");

test("phone normalization accepts common international and local formats", () => {
  assert.equal(_internals.normalizePhone("+251 91 234 5678"), "+251 91 234 5678");
  assert.equal(_internals.normalizePhone("091-234-5678"), "091-234-5678");
  assert.equal(_internals.normalizePhone("  +251   91 234 5678  "), "+251 91 234 5678");
});

test("phone normalization rejects invalid values", () => {
  assert.equal(_internals.normalizePhone("123"), null);
  assert.equal(_internals.normalizePhone("+251 call me"), null);
  assert.equal(_internals.normalizePhone("++251912345678"), null);
});
