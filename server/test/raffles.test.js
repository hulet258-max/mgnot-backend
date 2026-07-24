const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { isRecentWinner, publicRaffle, verifyTelegramInitData } = require("../src/api/raffles");
const { _internals: postgresInternals } = require("../src/config/postgres");
const { createInitialWinnerRaffles } = require("../src/data/raffles");

test("publicRaffle calculates paid capacity without exposing private purchases", () => {
  const result = publicRaffle({
    id: "item-1",
    itemName: "Demo item",
    ticketPrice: "25",
    ticketLimit: "100",
    reservedCount: "14",
    drawAt: "2026-07-24T12:00:00.000Z",
    secret: "do-not-return",
  });
  assert.equal(result.ticketPrice, 25);
  assert.equal(result.ticketLimit, 100);
  assert.equal(result.availableCount, 86);
  assert.equal(result.drawAt, "2026-07-24T12:00:00.000Z");
  assert.equal(result.secret, undefined);
});

test("first-run winner history contains five varied synthetic Ethiopian winners", () => {
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  const winners = createInitialWinnerRaffles(now);
  assert.equal(winners.length, 5);
  assert.deepEqual(winners.map((raffle) => raffle.itemName), [
    "Samsung Galaxy A15 Phone",
    "iPhone 11 Pro Max",
    "Clothes Ironing Machine",
    "Wireless Headset",
    "Nike Shoes – Size 42",
  ]);
  assert.equal(new Set(winners.map((raffle) => raffle.winner.username)).size, 5);
  winners.forEach((raffle) => {
    assert.match(raffle.winner.phone, /^\+251 9[1-5] \d{3} \d{4}$/);
    assert.equal(isRecentWinner(raffle, now), true);
  });
});

test("completed winners leave the recent feed 30 days after their draw", () => {
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  const winner = {
    status: "completed",
    winningNumber: 42,
    winner: { displayName: "Synthetic Winner" },
  };
  assert.equal(isRecentWinner({ ...winner, drawnAt: new Date(now - (29 * 24 * 60 * 60 * 1000)).toISOString() }, now), true);
  assert.equal(isRecentWinner({ ...winner, drawnAt: new Date(now - (30 * 24 * 60 * 60 * 1000)).toISOString() }, now), false);
});

test("Telegram init data accepts a fresh valid signature and rejects tampering", () => {
  const previousToken = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = "test-bot-token";
  const authDate = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: 4242, first_name: "Demo" });
  const values = { auth_date: String(authDate), query_id: "query-1", user };
  const check = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secret).update(check).digest("hex");
  const valid = new URLSearchParams({ ...values, hash }).toString();
  assert.equal(verifyTelegramInitData(valid), "4242");
  assert.equal(verifyTelegramInitData(valid.replace("query-1", "query-2")), null);
  if (previousToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = previousToken;
});

test("Postgres connection URLs are forced to mgnot without losing connection options", () => {
  const result = new URL(postgresInternals.databaseUrlFor(
    "postgresql://demo:secret@db.example:5432/worldcup?sslmode=require&application_name=mgnot-api",
    "mgnot"
  ));
  assert.equal(result.pathname, "/mgnot");
  assert.equal(result.searchParams.get("sslmode"), "require");
  assert.equal(result.searchParams.get("application_name"), "mgnot-api");
  assert.equal(result.username, "demo");
});
