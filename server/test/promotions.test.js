const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const { raffleUploadsDir } = require("../src/config/uploads");
const {
  generateBilingualCopy,
  generatePromotionBackground,
  parseCopy,
  promotionBackgroundPrompt,
} = require("../src/services/openaiPromotion");
const {
  composePromotionCard,
  countdownFor,
  dailyCaption,
  localDateParts,
  materialPromotionChanged,
  normalizePromotionSettings,
} = require("../src/services/promotions");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "x-request-id" ? "req_test" : null },
    json: async () => payload,
  };
}

async function withOpenAIKey(run) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
}

test("GPT Image request generates one text-free campaign background", async () => {
  await withOpenAIKey(async () => {
    const expected = Buffer.from("generated-image");
    let request;
    const result = await generatePromotionBackground({ itemName: "Smartphone" }, {
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return response({ data: [{ b64_json: expected.toString("base64") }] });
      },
    });
    assert.equal(request.model, "gpt-image-2");
    assert.equal(request.size, "1536x1024");
    assert.equal(request.quality, "medium");
    assert.match(request.prompt, /Do not draw or imitate the product/);
    assert.deepEqual(result.buffer, expected);
    assert.equal(result.requestId, "req_test");
  });
});

test("bilingual copy parses Responses API output and rejects missing languages", async () => {
  await withOpenAIKey(async () => {
    const result = await generateBilingualCopy({
      purpose: "new_product",
      raffle: { itemName: "Laptop", ticketPrice: 100, drawAt: "2026-08-10T09:00:00Z" },
    }, {
      fetchImpl: async () => response({ output_text: JSON.stringify({ am: "አዲስ ዕቃ", en: "New item" }) }),
    });
    assert.deepEqual({ am: result.am, en: result.en }, { am: "አዲስ ዕቃ", en: "New item" });
    assert.throws(() => parseCopy('{"en":"Only English"}'), /both languages/);
  });
});

test("OpenAI errors retain request IDs and transient retry classification", async () => {
  await withOpenAIKey(async () => {
    await assert.rejects(
      generatePromotionBackground({ itemName: "Phone" }, {
        fetchImpl: async () => response({ error: { code: "rate_limit_exceeded", message: "Slow down" } }, 429),
      }),
      (error) => error.code === "rate_limit_exceeded" && error.requestId === "req_test" && error.transient === true
    );
  });
});

test("promotion schedule is a single validated Nairobi-time setting", () => {
  const settings = normalizePromotionSettings({ enabled: true, dailySendTime: "18:35" }, "owner");
  assert.equal(settings.enabled, true);
  assert.equal(settings.dailySendTime, "18:35");
  assert.equal(settings.timezone, "Africa/Nairobi");
  assert.equal(settings.updatedBy, "owner");
  assert.throws(() => normalizePromotionSettings({ enabled: true, dailySendTime: "25:00" }), /HH:mm/);
});

test("Nairobi countdown uses calendar dates instead of server timezone", () => {
  const now = new Date("2026-08-02T20:00:00Z"); // 23:00 in Nairobi
  assert.equal(localDateParts(now).date, "2026-08-02");
  assert.deepEqual(countdownFor("2026-08-03T05:00:00Z", now), { days: 1, label: "1 DAY LEFT" });
  assert.deepEqual(countdownFor("2026-08-02T20:30:00Z", now), { days: 0, label: "DRAW TODAY" });
});

test("material product changes invalidate promotion approval", () => {
  const original = { itemName: "Phone", ticketPrice: 50, coverImageUrl: "/phone.jpg", drawAt: "2026-08-10", shortDescription: "New" };
  assert.equal(materialPromotionChanged(original, { ...original, status: "open" }), false);
  assert.equal(materialPromotionChanged(original, { ...original, ticketPrice: 60 }), true);
  assert.equal(materialPromotionChanged(original, { ...original, drawAt: "2026-08-11" }), true);
});

test("daily digest keeps exact facts and limits Telegram caption length", () => {
  const text = dailyCaption({ am: "የዛሬ ዕድሎች", en: "Today's opportunities" }, [{
    itemName: "Phone",
    ticketPrice: 75,
    drawAt: "2099-08-10T09:00:00Z",
  }]);
  assert.match(text, /Phone — 75 ETB/);
  assert.ok(text.length <= 900);
});

test("Sharp promotion card preserves the uploaded product as a separate composite", async () => {
  await fs.promises.mkdir(raffleUploadsDir, { recursive: true });
  const id = `promotion-test-${Date.now()}`;
  const productPath = path.join(raffleUploadsDir, `${id}.png`);
  try {
    await sharp({ create: { width: 300, height: 500, channels: 4, background: "#ff0000" } }).png().toFile(productPath);
    const background = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: "#102040" } }).jpeg().toBuffer();
    const card = await composePromotionCard({
      background,
      raffle: { itemName: "Test Phone", coverImageUrl: `/uploads/raffles/${id}.png`, ticketPrice: 50, drawAt: "2099-08-10T09:00:00Z" },
      label: "3 DAYS LEFT",
    });
    const metadata = await sharp(card).metadata();
    assert.equal(metadata.width, 1536);
    assert.equal(metadata.height, 1024);
    assert.equal(metadata.format, "jpeg");
  } finally {
    await fs.promises.unlink(productPath).catch(() => undefined);
  }
});

test("background prompt forbids generated product and text substitutions", () => {
  const prompt = promotionBackgroundPrompt({ itemName: "Television" });
  assert.match(prompt, /Do not draw or imitate the product/);
  assert.match(prompt, /Do not include.*letters.*numbers.*words/);
});
