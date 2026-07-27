const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizePhone } = require("../src/services/paymentNumbers");

test("payment phone normalization ignores display formatting", () => {
  assert.equal(normalizePhone("+251 91 234 5678"), "+251912345678");
  assert.equal(normalizePhone("+251-91-234-5678"), "+251912345678");
});
