const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const db = require("../config/postgres");
const { raffleUploadsDir } = require("../config/uploads");
const { generateBilingualCopy, generatePromotionBackground } = require("./openaiPromotion");

const SETTINGS_ID = "telegram-promotions";
const TIMEZONE = "Africa/Nairobi";
const MATERIAL_FIELDS = ["itemName", "shortDescription", "coverImageUrl", "ticketPrice", "drawAt"];

const isoNow = () => new Date().toISOString();
const safeId = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
const campaignRef = (raffleId) => db.collection("promotion_campaigns").doc(String(raffleId));
const settingsRef = () => db.collection("system").doc(SETTINGS_ID);

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function localUploadPath(publicUrl) {
  const value = String(publicUrl || "");
  if (!value.startsWith("/uploads/raffles/")) return null;
  return path.join(raffleUploadsDir, path.basename(value));
}

function publicUploadPath(filename) {
  return `/uploads/raffles/${filename}`;
}

function localDateParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function countdownFor(drawAt, now = new Date()) {
  const draw = new Date(drawAt || 0);
  if (!Number.isFinite(draw.getTime()) || draw <= now) return { days: 0, label: "DRAW TODAY" };
  const currentDate = localDateParts(now).date;
  const drawDate = localDateParts(draw).date;
  const [cy, cm, cd] = currentDate.split("-").map(Number);
  const [dy, dm, dd] = drawDate.split("-").map(Number);
  const days = Math.max(0, Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(cy, cm - 1, cd)) / 86400000));
  return { days, label: days === 0 ? "DRAW TODAY" : `${days} DAY${days === 1 ? "" : "S"} LEFT` };
}

function formatDrawDate(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return "Draw time coming soon";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBirr(value) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(value || 0))} ETB`;
}

async function sourceImageBuffer(publicUrl) {
  const localPath = localUploadPath(publicUrl);
  if (!localPath || !fs.existsSync(localPath)) {
    throw Object.assign(new Error("The raffle cover image is not available on promotion-worker storage."), { code: "cover_image_missing" });
  }
  return fs.promises.readFile(localPath);
}

function cardTextSvg(raffle, label) {
  const title = String(raffle.itemName || "New MGNOT item").slice(0, 34);
  return Buffer.from(`
    <svg width="1536" height="1024" xmlns="http://www.w3.org/2000/svg">
      <defs><filter id="shadow"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-opacity="0.35"/></filter></defs>
      <rect x="70" y="72" width="700" height="880" rx="40" fill="#07182e" fill-opacity="0.80"/>
      <text x="120" y="170" fill="#f6c95b" font-size="42" font-weight="800" font-family="Arial, sans-serif">MGNOT</text>
      <text x="120" y="265" fill="#ffffff" font-size="62" font-weight="800" font-family="Arial, sans-serif">${escapeXml(title)}</text>
      <text x="120" y="390" fill="#f6c95b" font-size="70" font-weight="900" font-family="Arial, sans-serif">${escapeXml(label)}</text>
      <text x="120" y="505" fill="#ffffff" font-size="46" font-weight="700" font-family="Arial, sans-serif">Ticket: ${escapeXml(formatBirr(raffle.ticketPrice))}</text>
      <text x="120" y="580" fill="#d9e6f2" font-size="32" font-family="Arial, sans-serif">Draw: ${escapeXml(formatDrawDate(raffle.drawAt))}</text>
      <rect x="120" y="690" width="390" height="92" rx="46" fill="#f6c95b" filter="url(#shadow)"/>
      <text x="315" y="750" text-anchor="middle" fill="#07182e" font-size="34" font-weight="800" font-family="Arial, sans-serif">BUY TICKET</text>
      <text x="120" y="880" fill="#ffffff" font-size="27" font-family="Arial, sans-serif">Wish it. Get it.</text>
    </svg>`);
}

async function composePromotionCard({ background, raffle, label }) {
  const product = await sharp(await sourceImageBuffer(raffle.coverImageUrl))
    .rotate()
    .resize(610, 690, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer();
  const productCard = Buffer.from(`<svg width="680" height="780" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="680" height="780" rx="46" fill="#ffffff" fill-opacity="0.96"/></svg>`);
  const normalizedBackground = background
    ? await sharp(background).resize(1536, 1024, { fit: "cover" }).jpeg({ quality: 86 }).toBuffer()
    : await sharp({ create: { width: 1536, height: 1024, channels: 3, background: "#0b2745" } }).jpeg().toBuffer();

  return sharp(normalizedBackground)
    .composite([
      { input: productCard, left: 810, top: 122 },
      { input: product, left: 845, top: 165 },
      { input: cardTextSvg(raffle, label), left: 0, top: 0 },
    ])
    .jpeg({ quality: 86, progressive: true, mozjpeg: true })
    .toBuffer();
}

async function writeAsset(filename, buffer) {
  await fs.promises.mkdir(raffleUploadsDir, { recursive: true });
  const destination = path.join(raffleUploadsDir, path.basename(filename));
  await fs.promises.writeFile(destination, buffer);
  return publicUploadPath(path.basename(filename));
}

function defaultPromotionSettings() {
  return { enabled: false, dailySendTime: "09:00", timezone: TIMEZONE, updatedAt: null, updatedBy: null };
}

async function getPromotionSettings() {
  const snapshot = await settingsRef().get();
  return { ...defaultPromotionSettings(), ...(snapshot.exists ? snapshot.data() : {}) };
}

function normalizePromotionSettings(input, actor = "admin") {
  const dailySendTime = String(input.dailySendTime || "").trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailySendTime)) {
    throw Object.assign(new Error("Daily send time must use HH:mm in 24-hour format."), { status: 400 });
  }
  return {
    enabled: Boolean(input.enabled),
    dailySendTime,
    timezone: TIMEZONE,
    updatedAt: isoNow(),
    updatedBy: actor,
  };
}

async function savePromotionSettings(input, actor = "admin") {
  const settings = normalizePromotionSettings(input, actor);
  await settingsRef().set(settings);
  return settings;
}

async function enqueueJob({ type, raffleId, version, actor = "system" }) {
  const id = `${safeId(raffleId)}-${type}-v${Number(version || 1)}`;
  const ref = db.collection("promotion_jobs").doc(id);
  const current = await ref.get();
  if (!current.exists || ["failed", "cancelled"].includes((current.data() || {}).status)) {
    await ref.set({
      type,
      raffleId: String(raffleId),
      version: Number(version || 1),
      status: "queued",
      attempts: 0,
      nextAttemptAt: isoNow(),
      actor,
      createdAt: current.exists ? current.data().createdAt : isoNow(),
      updatedAt: isoNow(),
    });
  }
  return id;
}

async function enqueuePromotionGeneration(raffle, actor = "system") {
  const ref = campaignRef(raffle.id);
  const current = await ref.get();
  const version = Number(current.data()?.version || 0) + 1;
  const campaign = {
    raffleId: String(raffle.id),
    version,
    status: "queued",
    raffleSnapshot: Object.fromEntries(MATERIAL_FIELDS.map((key) => [key, raffle[key] ?? null])),
    copy: null,
    baseImageUrl: null,
    previewImageUrl: null,
    approvedAt: null,
    approvedBy: null,
    launchedAt: null,
    error: null,
    createdAt: current.exists ? current.data().createdAt : isoNow(),
    updatedAt: isoNow(),
  };
  await ref.set(campaign);
  await enqueueJob({ type: "generate", raffleId: raffle.id, version, actor });
  return campaign;
}

function materialPromotionChanged(before, after) {
  return MATERIAL_FIELDS.some((field) => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null));
}

async function getCampaign(raffleId) {
  const snapshot = await campaignRef(raffleId).get();
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

async function enqueueLaunchIfReady(raffle, actor = "system") {
  if (!raffle || raffle.status !== "open") return null;
  const campaign = await getCampaign(raffle.id);
  if (!campaign || campaign.status !== "approved" || campaign.launchedAt) return null;
  return enqueueJob({ type: "launch", raffleId: raffle.id, version: campaign.version, actor });
}

async function approveCampaign(raffle, input, actor) {
  const ref = campaignRef(raffle.id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw Object.assign(new Error("Generate a promotion before approving it."), { status: 404 });
  const campaign = snapshot.data() || {};
  if (campaign.status !== "review") throw Object.assign(new Error("This promotion is not ready for approval."), { status: 409 });
  const copy = {
    am: String(input.copyAm || campaign.copy?.am || "").trim().slice(0, 450),
    en: String(input.copyEn || campaign.copy?.en || "").trim().slice(0, 450),
  };
  if (!copy.am || !copy.en) throw Object.assign(new Error("Both Amharic and English copy are required."), { status: 400 });
  await ref.set({ status: "approved", copy, approvedAt: isoNow(), approvedBy: actor, updatedAt: isoNow(), error: null }, { merge: true });
  await enqueueLaunchIfReady(raffle, actor);
  return getCampaign(raffle.id);
}

async function rejectCampaign(raffleId, actor) {
  const ref = campaignRef(raffleId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw Object.assign(new Error("Promotion not found."), { status: 404 });
  await ref.set({ status: "rejected", rejectedAt: isoNow(), rejectedBy: actor, updatedAt: isoNow() }, { merge: true });
  return getCampaign(raffleId);
}

async function deletePromotionCampaign(raffleId) {
  const campaign = await getCampaign(raffleId);
  const jobs = await db.collection("promotion_jobs").where("raffleId", "==", String(raffleId)).get();
  const batch = db.batch();
  batch.delete(campaignRef(raffleId));
  jobs.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  await Promise.all([campaign?.baseImageUrl, campaign?.previewImageUrl]
    .map(localUploadPath)
    .filter(Boolean)
    .map((file) => fs.promises.unlink(file).catch(() => undefined)));
}

async function generateCampaignAssets(raffle, campaign, options = {}) {
  const ref = campaignRef(raffle.id);
  await ref.set({ status: "generating", updatedAt: isoNow(), error: null }, { merge: true });
  const [image, copy] = await Promise.all([
    generatePromotionBackground(raffle, options),
    generateBilingualCopy({ purpose: "new_product", raffle }, options),
  ]);
  const prefix = `promotion-${safeId(raffle.id)}-v${campaign.version}`;
  const baseImageUrl = await writeAsset(`${prefix}-base.jpg`, image.buffer);
  const preview = await composePromotionCard({ background: image.buffer, raffle, label: "NEW PRODUCT" });
  const previewImageUrl = await writeAsset(`${prefix}-preview.jpg`, preview);
  await ref.set({
    status: "review",
    baseImageUrl,
    previewImageUrl,
    copy: { am: copy.am, en: copy.en },
    openai: { imageRequestId: image.requestId, copyRequestId: copy.requestId, imageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2", copyModel: process.env.OPENAI_COPY_MODEL || "gpt-5.6-luna" },
    generatedAt: isoNow(),
    updatedAt: isoNow(),
    error: null,
  }, { merge: true });
  return getCampaign(raffle.id);
}

async function readCampaignBackground(campaign) {
  const localPath = localUploadPath(campaign.baseImageUrl);
  return localPath && fs.existsSync(localPath) ? fs.promises.readFile(localPath) : null;
}

function fallbackDailyCopy() {
  return {
    am: "የዛሬን የMGNOT ዕድሎች ይመልከቱ። የሚፈልጉትን ዕቃ መርጠው ትኬትዎን ይያዙ።",
    en: "See today’s MGNOT opportunities. Choose the item you want and secure your ticket.",
  };
}

function dailyCaption(copy, raffles) {
  const lines = [copy.am, "", copy.en, ""];
  raffles.slice(0, 6).forEach((raffle, index) => {
    const countdown = countdownFor(raffle.drawAt).label;
    lines.push(`${index === 0 ? "⭐" : "•"} ${raffle.itemName} — ${formatBirr(raffle.ticketPrice)} — ${countdown}`);
  });
  if (raffles.length > 6) lines.push(`+${raffles.length - 6} more item(s) in MGNOT`);
  return lines.join("\n").slice(0, 900);
}

function launchCaption(campaign, raffle) {
  return [campaign.copy?.am, "", campaign.copy?.en, "", `🎟 ${formatBirr(raffle.ticketPrice)}`, `🗓 ${formatDrawDate(raffle.drawAt)}`]
    .filter((value) => value !== undefined && value !== null)
    .join("\n")
    .slice(0, 900);
}

module.exports = {
  TIMEZONE,
  approveCampaign,
  campaignRef,
  composePromotionCard,
  countdownFor,
  dailyCaption,
  deletePromotionCampaign,
  defaultPromotionSettings,
  enqueueJob,
  enqueueLaunchIfReady,
  enqueuePromotionGeneration,
  fallbackDailyCopy,
  formatDrawDate,
  generateBilingualCopy,
  generateCampaignAssets,
  getCampaign,
  getPromotionSettings,
  launchCaption,
  localDateParts,
  materialPromotionChanged,
  normalizePromotionSettings,
  readCampaignBackground,
  rejectCampaign,
  savePromotionSettings,
};
