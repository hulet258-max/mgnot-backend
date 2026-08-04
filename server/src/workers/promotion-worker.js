const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "config", ".env") });
require("dotenv").config({ path: path.join(__dirname, "..", "bot", ".env") });

const db = require("../config/postgres");
const { raffleUploadsDir } = require("../config/uploads");
const { queuePromotionBroadcast } = require("../services/telegramMessaging");
const {
  campaignRef,
  composePromotionCard,
  countdownFor,
  dailyCaption,
  fallbackDailyCopy,
  generateBilingualCopy,
  generateCampaignAssets,
  getPromotionSettings,
  launchCaption,
  localDateParts,
  readCampaignBackground,
} = require("../services/promotions");

const POLL_MS = Number(process.env.PROMOTION_POLL_MS || 30000);
const isoNow = () => new Date().toISOString();

async function raffleById(raffleId) {
  const snapshot = await db.collection("raffles").doc(String(raffleId)).get();
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

async function allRecipients() {
  const snapshot = await db.collection("users").get();
  return [...new Set(snapshot.docs.map((doc) => String((doc.data() || {}).telegramId || doc.id)).filter(Boolean))];
}

async function pendingRecipients(runRef, recipients) {
  const delivered = await runRef.collection("deliveries").get();
  const sent = new Set(delivered.docs.filter((doc) => doc.data()?.status === "sent").map((doc) => doc.id));
  return recipients.filter((recipient) => !sent.has(String(recipient)));
}

function deliveryRecorder(runRef) {
  return (recipient, result) => runRef.collection("deliveries").doc(String(recipient)).set({
    telegramId: String(recipient),
    ...result,
    updatedAt: isoNow(),
  }, { merge: true });
}

async function claimJob(jobDoc) {
  return db.runTransaction(async (tx) => {
    const locked = await tx.get(jobDoc.ref);
    if (!locked.exists) return null;
    const job = locked.data() || {};
    if (!['queued', 'retry'].includes(job.status)) return null;
    if (new Date(job.nextAttemptAt || 0).getTime() > Date.now()) return null;
    await tx.update(jobDoc.ref, { status: "processing", startedAt: isoNow(), updatedAt: isoNow() });
    return { id: jobDoc.id, ...job };
  });
}

async function failJob(jobRef, job, error) {
  const attempts = Number(job.attempts || 0) + 1;
  const retry = Boolean(error.transient) && attempts < 3;
  await jobRef.set({
    status: retry ? "retry" : "failed",
    attempts,
    nextAttemptAt: retry ? new Date(Date.now() + (2 ** attempts) * 30000).toISOString() : null,
    error: { code: error.code || "promotion_error", message: error.message, requestId: error.requestId || null },
    updatedAt: isoNow(),
    completedAt: retry ? null : isoNow(),
  }, { merge: true });
  if (job.type === "generate" && !retry) {
    await campaignRef(job.raffleId).set({
      status: "failed",
      error: { code: error.code || "promotion_error", message: error.message, requestId: error.requestId || null },
      updatedAt: isoNow(),
    }, { merge: true });
  }
}

async function processGenerateJob(job, jobRef) {
  const [raffle, campaignDoc] = await Promise.all([raffleById(job.raffleId), campaignRef(job.raffleId).get()]);
  if (!raffle || !campaignDoc.exists || Number(campaignDoc.data()?.version) !== Number(job.version)) {
    await jobRef.set({ status: "cancelled", completedAt: isoNow(), updatedAt: isoNow() }, { merge: true });
    return;
  }
  await generateCampaignAssets(raffle, { id: campaignDoc.id, ...campaignDoc.data() });
  await jobRef.set({ status: "completed", completedAt: isoNow(), updatedAt: isoNow() }, { merge: true });
}

async function processLaunchJob(job, jobRef) {
  const [raffle, campaignDoc] = await Promise.all([raffleById(job.raffleId), campaignRef(job.raffleId).get()]);
  const campaign = campaignDoc.exists ? { id: campaignDoc.id, ...campaignDoc.data() } : null;
  if (!raffle || !campaign || campaign.status !== "approved" || Number(campaign.version) !== Number(job.version)) {
    await jobRef.set({ status: "cancelled", completedAt: isoNow(), updatedAt: isoNow() }, { merge: true });
    return;
  }
  if (campaign.launchedAt) {
    await jobRef.set({ status: "completed", completedAt: isoNow(), updatedAt: isoNow() }, { merge: true });
    return;
  }
  const previewPath = path.join(raffleUploadsDir, path.basename(String(campaign.previewImageUrl || "")));
  const recipients = await pendingRecipients(jobRef, await allRecipients());
  const result = await queuePromotionBroadcast({
    recipients,
    message: launchCaption(campaign, raffle),
    photo: fs.existsSync(previewPath) ? previewPath : null,
    raffleId: raffle.id,
    buttonLabel: "Buy ticket | ትኬት ይግዙ",
    onRecipientResult: deliveryRecorder(jobRef),
  });
  await campaignRef(raffle.id).set({ launchedAt: isoNow(), launchResult: result, updatedAt: isoNow() }, { merge: true });
  await jobRef.set({ status: "completed", ...result, completedAt: isoNow(), updatedAt: isoNow() }, { merge: true });
}

async function processQueuedJobs() {
  const snapshot = await db.collection("promotion_jobs").get();
  const candidates = snapshot.docs
    .filter((doc) => ["queued", "retry"].includes(doc.data()?.status))
    .sort((a, b) => String(a.data()?.createdAt || "").localeCompare(String(b.data()?.createdAt || "")));
  for (const jobDoc of candidates) {
    const job = await claimJob(jobDoc);
    if (!job) continue;
    try {
      if (job.type === "generate") await processGenerateJob(job, jobDoc.ref);
      else if (job.type === "launch") await processLaunchJob(job, jobDoc.ref);
      else await jobDoc.ref.set({ status: "failed", error: { code: "unknown_job", message: "Unknown promotion job type." }, completedAt: isoNow() }, { merge: true });
    } catch (error) {
      console.error(`Promotion job ${job.id} failed:`, error);
      await failJob(jobDoc.ref, job, error);
    }
  }
}

async function eligibleDailyCampaigns(localDate) {
  const campaigns = await db.collection("promotion_campaigns").get();
  const result = [];
  for (const doc of campaigns.docs) {
    const campaign = { id: doc.id, ...doc.data() };
    if (campaign.status !== "approved" || !campaign.launchedAt || localDateParts(new Date(campaign.launchedAt)).date === localDate) continue;
    const raffle = await raffleById(campaign.raffleId);
    if (!raffle || !["open", "sold_out"].includes(raffle.status) || new Date(raffle.drawAt || 0) <= new Date()) continue;
    result.push({ campaign, raffle });
  }
  return result.sort((a, b) => new Date(a.raffle.drawAt) - new Date(b.raffle.drawAt));
}

async function claimDailyRun(runRef, localDate) {
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(runRef);
    if (snapshot.exists && ["processing", "completed", "skipped"].includes(snapshot.data()?.status)) return false;
    await tx.set(runRef, { type: "daily_digest", localDate, timezone: "Africa/Nairobi", status: "processing", startedAt: isoNow(), updatedAt: isoNow() });
    return true;
  });
}

async function processDailySchedule() {
  const settings = await getPromotionSettings();
  if (!settings.enabled) return;
  const clock = localDateParts();
  const [hour, minute] = settings.dailySendTime.split(":").map(Number);
  if (clock.minutes < hour * 60 + minute) return;
  const runRef = db.collection("promotion_runs").doc(`daily-${clock.date}`);
  if (!(await claimDailyRun(runRef, clock.date))) return;

  try {
    const eligible = await eligibleDailyCampaigns(clock.date);
    if (!eligible.length) {
      await runRef.set({ status: "skipped", reason: "no_eligible_campaigns", completedAt: isoNow(), updatedAt: isoNow() }, { merge: true });
      return;
    }
    const raffles = eligible.map((entry) => entry.raffle);
    let copy;
    try {
      copy = await generateBilingualCopy({ purpose: "daily_digest", raffles });
    } catch (error) {
      console.warn("Daily promotion copy fell back to template:", error.message);
      copy = fallbackDailyCopy();
    }
    const featured = eligible[0];
    const background = await readCampaignBackground(featured.campaign);
    const card = await composePromotionCard({ background, raffle: featured.raffle, label: countdownFor(featured.raffle.drawAt).label });
    const recipients = await pendingRecipients(runRef, await allRecipients());
    const result = await queuePromotionBroadcast({
      recipients,
      message: dailyCaption(copy, raffles),
      photo: card,
      raffleId: featured.raffle.id,
      buttonLabel: "View today’s items | የዛሬን ዕቃዎች ይመልከቱ",
      onRecipientResult: deliveryRecorder(runRef),
    });
    await runRef.set({ status: "completed", featuredRaffleId: featured.raffle.id, raffleIds: raffles.map((raffle) => raffle.id), ...result, completedAt: isoNow(), updatedAt: isoNow() }, { merge: true });
  } catch (error) {
    console.error("Daily promotion run failed:", error);
    await runRef.set({ status: "failed", error: { code: error.code || "daily_run_error", message: error.message }, completedAt: isoNow(), updatedAt: isoNow() }, { merge: true });
  }
}

async function startWorker() {
  await db.init();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processQueuedJobs();
      await processDailySchedule();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => tick().catch((error) => console.error("Promotion worker tick failed:", error)), POLL_MS);
  timer.unref?.();
  await tick();
  console.log("Promotion worker started.");

  const shutdown = async (signal) => {
    console.log(`Received ${signal}; closing promotion worker.`);
    clearInterval(timer);
    await db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT").catch(console.error));
  process.once("SIGTERM", () => shutdown("SIGTERM").catch(console.error));
}

if (require.main === module) {
  startWorker().catch((error) => {
    console.error("Promotion worker startup error:", error);
    process.exit(1);
  });
}

module.exports = { eligibleDailyCampaigns, processDailySchedule, processQueuedJobs, startWorker };
