const OPENAI_API_BASE = "https://api.openai.com/v1";

function apiKey() {
  const value = String(process.env.OPENAI_API_KEY || "").trim();
  if (!value) throw Object.assign(new Error("OPENAI_API_KEY is not configured."), { code: "openai_key_missing" });
  return value;
}

async function openAIRequest(path, body, fetchImpl = global.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch.");
  let response;
  try {
    response = await fetchImpl(`${OPENAI_API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw Object.assign(new Error(`OpenAI network request failed: ${error.message}`), {
      code: "openai_network_error",
      transient: true,
      cause: error,
    });
  }
  const requestId = response.headers?.get?.("x-request-id") || null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const source = payload.error || {};
    throw Object.assign(new Error(source.message || `OpenAI request failed with HTTP ${response.status}.`), {
      status: response.status,
      code: source.code || source.type || "openai_error",
      requestId,
      moderationDetails: source.moderation_details || null,
      transient: response.status === 429 || response.status >= 500,
    });
  }
  return { payload, requestId };
}

function promotionBackgroundPrompt(raffle) {
  return [
    "Create a premium advertising background for MGNOT, an Ethiopian product raffle platform.",
    `Visual mood inspired by this product category: ${raffle.itemName || "consumer product"}.`,
    "Use deep navy, warm gold, subtle emerald accents, studio lighting, and elegant celebratory particles.",
    "Leave a calm dark area on the left for headline and pricing, and a clean bright framed area on the right for a real product photograph that will be composited later.",
    "Do not draw or imitate the product. Do not include people, logos, letters, numbers, words, watermarks, tickets, currency, or readable text.",
    "Landscape commercial composition, polished, trustworthy, modern, high contrast, mobile-friendly.",
  ].join(" ");
}

async function generatePromotionBackground(raffle, options = {}) {
  const { payload, requestId } = await openAIRequest("/images/generations", {
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
    prompt: promotionBackgroundPrompt(raffle),
    size: "1536x1024",
    quality: "medium",
    output_format: "jpeg",
    output_compression: 85,
    n: 1,
  }, options.fetchImpl);
  const encoded = payload.data?.[0]?.b64_json;
  if (!encoded) throw Object.assign(new Error("OpenAI returned no generated image."), { code: "openai_image_missing", requestId });
  return { buffer: Buffer.from(encoded, "base64"), requestId, prompt: promotionBackgroundPrompt(raffle) };
}

function responseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  return (payload.output || [])
    .flatMap((entry) => entry.content || [])
    .filter((entry) => entry.type === "output_text" || typeof entry.text === "string")
    .map((entry) => entry.text || "")
    .join("\n");
}

function parseCopy(text) {
  const normalized = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(normalized);
  const am = String(parsed.am || "").trim().slice(0, 450);
  const en = String(parsed.en || "").trim().slice(0, 450);
  if (!am || !en) throw new Error("OpenAI promotion copy did not contain both languages.");
  return { am, en };
}

async function generateBilingualCopy({ purpose, raffle, raffles = [] }, options = {}) {
  const facts = purpose === "daily_digest"
    ? raffles.map((entry) => ({ itemName: entry.itemName, ticketPrice: entry.ticketPrice, drawAt: entry.drawAt }))
    : { itemName: raffle.itemName, ticketPrice: raffle.ticketPrice, drawAt: raffle.drawAt, shortDescription: raffle.shortDescription };
  const prompt = [
    "Write concise promotional copy for MGNOT using only the JSON facts below.",
    "Return only valid JSON with exactly two string fields: am (natural Amharic) and en (English).",
    "Do not invent discounts, quantities, urgency, guarantees, product features, dates, prices, or odds.",
    "Do not claim that buying guarantees a win. Keep each language under 300 characters and use at most two tasteful emoji.",
    `Purpose: ${purpose}. Facts: ${JSON.stringify(facts)}`,
  ].join("\n");
  const { payload, requestId } = await openAIRequest("/responses", {
    model: process.env.OPENAI_COPY_MODEL || "gpt-5.6-luna",
    input: prompt,
    max_output_tokens: 500,
  }, options.fetchImpl);
  return { ...parseCopy(responseText(payload)), requestId };
}

module.exports = {
  generateBilingualCopy,
  generatePromotionBackground,
  openAIRequest,
  parseCopy,
  promotionBackgroundPrompt,
  responseText,
};
