const crypto = require("crypto");
const express = require("express");
const db = require("../config/postgres");
const { redis } = require("../config/redis");
const { verifyPayment } = require("./receiptService");
const { DEFAULT_RAFFLES, createInitialWinnerRaffles } = require("../data/raffles");
const {
  queueDrawReminderNotification,
  queueDrawResultNotification
} = require("../services/telegramMessaging");

const router = express.Router();
const RAFFLES_CACHE_KEY = "raffles:list";
const DRAW_REMINDER_MS = 10 * 60 * 1000;
const WINNER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const INITIAL_WINNERS_SEED_ID = "initial-raffle-winners-v1";
const SHOULD_SEED_DEFAULT_RAFFLES = process.env.SEED_DEFAULT_RAFFLES === "true";
const raffleCacheKey = (raffleId) => `raffle:${raffleId}`;

function publicRaffle(source = {}) {
  return {
    id: source.id,
    itemName: source.itemName || "Item raffle",
    shortDescription: source.shortDescription || "",
    description: source.description || "",
    condition: source.condition || "",
    estimatedValue: Number(source.estimatedValue || 0),
    ticketPrice: Number(source.ticketPrice || 0),
    ticketLimit: Number(source.ticketLimit || 0),
    status: source.status || "open",
    coverImageUrl: source.coverImageUrl || "",
    galleryImageUrls: Array.isArray(source.galleryImageUrls) ? source.galleryImageUrls : [],
    specifications: Array.isArray(source.specifications) ? source.specifications : [],
    provider: source.provider || source.owner || null,
    reservedCount: Number(source.reservedCount || 0),
    assignedCount: Number(source.assignedCount || 0),
    availableCount: Math.max(0, Number(source.ticketLimit || 0) - Number(source.reservedCount || 0)),
    winningNumber: source.winningNumber ? Number(source.winningNumber) : null,
    winner: source.winner || null,
    drawAt: source.drawAt || source.endsAt || null,
    drawnAt: source.drawnAt || null,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null
  };
}

async function ensureRafflesSeeded() {
  if (!SHOULD_SEED_DEFAULT_RAFFLES) return;
  const refs = DEFAULT_RAFFLES.map((raffle) => db.collection("raffles").doc(raffle.id));
  const docs = await Promise.all(refs.map((ref) => ref.get()));
  const batch = db.batch();
  let changed = false;

  docs.forEach((doc, index) => {
    if (doc.exists) {
      const seeded = DEFAULT_RAFFLES[index];
      const current = doc.data() || {};
      const patch = {};
      if (seeded.status === "completed" && seeded.winner?.phone && !current.winner?.phone) {
        patch.winner = { ...(current.winner || seeded.winner), phone: seeded.winner.phone };
      }
      if (seeded.drawAt && current.drawScheduleVersion !== seeded.drawScheduleVersion) {
        patch.drawAt = seeded.drawAt;
        patch.drawScheduleVersion = seeded.drawScheduleVersion;
      }
      if (seeded.provider && !current.provider) patch.provider = seeded.provider;
      if (Object.keys(patch).length) {
        batch.set(refs[index], { ...patch, updatedAt: db.FieldValue.serverTimestamp() }, { merge: true });
        changed = true;
      }
      return;
    }
    batch.set(refs[index], {
      ...DEFAULT_RAFFLES[index],
      createdAt: db.FieldValue.serverTimestamp(),
      updatedAt: db.FieldValue.serverTimestamp()
    });
    changed = true;
  });

  if (changed) {
    await batch.commit();
    if (redis.isOpen) await redis.del(RAFFLES_CACHE_KEY);
  }
}

async function ensureInitialWinnersSeeded() {
  const markerRef = db.collection("system").doc(INITIAL_WINNERS_SEED_ID);
  const marker = await markerRef.get();
  if (marker.exists) return false;

  const winners = createInitialWinnerRaffles();
  const refs = winners.map((raffle) => db.collection("raffles").doc(raffle.id));
  const existing = await Promise.all(refs.map((ref) => ref.get()));
  const batch = db.batch();

  existing.forEach((doc, index) => {
    if (doc.exists) return;
    batch.set(refs[index], {
      ...winners[index],
      createdAt: db.FieldValue.serverTimestamp(),
      updatedAt: db.FieldValue.serverTimestamp()
    });
  });
  batch.set(markerRef, {
    version: 1,
    winnerIds: winners.map((raffle) => raffle.id),
    seededAt: db.FieldValue.serverTimestamp()
  });
  await batch.commit();
  if (redis.isOpen) await redis.del(RAFFLES_CACHE_KEY);
  return true;
}

function isRecentWinner(raffle, now = Date.now()) {
  if (raffle?.status !== "completed" || !raffle.winningNumber || !raffle.winner) return false;
  const drawnAt = new Date(raffle.drawnAt || 0).getTime();
  return Number.isFinite(drawnAt) && drawnAt > 0 && now - drawnAt < WINNER_RETENTION_MS;
}

async function getRaffles() {
  if (redis.isOpen) {
    const cached = await redis.get(RAFFLES_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  }
  const snapshot = await db.collection("raffles").get();
  const raffles = snapshot.docs.map((doc) => publicRaffle({ id: doc.id, ...doc.data() }));
  if (redis.isOpen) await redis.set(RAFFLES_CACHE_KEY, JSON.stringify(raffles), { EX: 30 });
  return raffles;
}

async function getRaffle(raffleId) {
  if (redis.isOpen) {
    const cached = await redis.get(raffleCacheKey(raffleId));
    if (cached) return JSON.parse(cached);
  }
  const doc = await db.collection("raffles").doc(String(raffleId)).get();
  if (!doc.exists) return null;
  const raffle = publicRaffle({ id: doc.id, ...doc.data() });
  if (redis.isOpen) await redis.set(raffleCacheKey(raffleId), JSON.stringify(raffle), { EX: 30 });
  return raffle;
}

async function invalidateRaffle(raffleId) {
  if (redis.isOpen) await redis.del([RAFFLES_CACHE_KEY, raffleCacheKey(raffleId)]);
}

async function finalizeDueRaffles(req) {
  const snapshot = await db.collection("raffles").get();
  const now = Date.now();
  const reminders = snapshot.docs.filter((doc) => {
    const raffle = doc.data() || {};
    const drawTime = new Date(raffle.drawAt || 0).getTime();
    return ["open", "sold_out"].includes(raffle.status) &&
      drawTime > now &&
      drawTime - now <= DRAW_REMINDER_MS &&
      !raffle.drawReminder?.queuedAt;
  });

  for (const raffleDoc of reminders) {
    const raffleRef = db.collection("raffles").doc(raffleDoc.id);
    let claimed = false;
    await db.runTransaction(async (tx) => {
      const lockedRaffle = await tx.get(raffleRef);
      if (!lockedRaffle.exists || (lockedRaffle.data() || {}).drawReminder?.queuedAt) return;
      await tx.update(raffleRef, { drawReminder: { queuedAt: new Date().toISOString() } });
      claimed = true;
    });
    if (!claimed) continue;
    queueDrawReminderNotification(raffleDoc.id).catch((error) => {
      console.error(`Draw reminder failed for raffle ${raffleDoc.id}:`, error);
    });
  }

  const due = snapshot.docs.filter((doc) => {
    const raffle = doc.data() || {};
    const drawTime = new Date(raffle.drawAt || 0).getTime();
    return ["open", "sold_out"].includes(raffle.status) && drawTime > 0 && now >= drawTime;
  });

  for (const raffleDoc of due) {
    const raffleId = raffleDoc.id;
    const raffleRef = db.collection("raffles").doc(raffleId);
    const ticketsSnapshot = await raffleRef.collection("tickets").get();
    if (!ticketsSnapshot.docs.length) continue;
    const winningTicketDoc = ticketsSnapshot.docs[crypto.randomInt(ticketsSnapshot.docs.length)];
    const winningTicket = winningTicketDoc.data() || {};
    const purchaseRef = raffleRef.collection("purchases").doc(String(winningTicket.purchaseId));
    let completed = false;

    await db.runTransaction(async (tx) => {
      const [lockedRaffle, purchaseDoc] = await Promise.all([tx.get(raffleRef), tx.get(purchaseRef)]);
      if (!lockedRaffle.exists || !purchaseDoc.exists) return;
      const raffle = lockedRaffle.data() || {};
      const drawTime = new Date(raffle.drawAt || 0).getTime();
      if (raffle.status === "completed" || Date.now() < drawTime) return;
      const purchase = purchaseDoc.data() || {};
      tx.update(raffleRef, {
        status: "completed",
        winningNumber: Number(winningTicket.number || winningTicketDoc.id),
        winner: {
          userId: purchase.userId || winningTicket.userId || null,
          displayName: purchase.displayName || "Winner",
          username: purchase.username || null,
          phone: purchase.phone || null,
          photo: purchase.photo || null
        },
        drawnAt: new Date().toISOString(),
        updatedAt: db.FieldValue.serverTimestamp()
      });
      completed = true;
    });

    if (completed) {
      await invalidateRaffle(raffleId);
      await broadcast(req, raffleId, "draw_completed");
      queueDrawResultNotification(raffleId).catch((error) => {
        console.error(`Draw notification failed for raffle ${raffleId}:`, error);
      });
    }
  }
}

function extractTransactionId(serviceResponse, input) {
  const inputMatch = String(input || "").match(/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]+)/i);
  if (inputMatch) return inputMatch[1].toUpperCase();
  if (/^[A-Z0-9]{10}$/i.test(String(input || "").trim())) return String(input).trim().toUpperCase();
  const sources = [serviceResponse, serviceResponse?.data, serviceResponse?.result, serviceResponse?.receipt];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const value = source.transactionId || source.transaction_id || source.txId || source.trxId || source.reference || source.receiptId;
    if (value) return String(value).trim();
  }
  return null;
}

function extractAmount(serviceResponse, fallback) {
  const sources = [serviceResponse, serviceResponse?.data, serviceResponse?.result, serviceResponse?.receipt];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const value = Number(source.amount || source.paidAmount || source.verifiedAmount || source.totalAmount);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return Number(fallback || 0);
}

function verifyTelegramInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash");
  if (!suppliedHash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Math.floor(Date.now() / 1000) - authDate) > 86400) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (suppliedHash.length !== expectedHash.length || !crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(expectedHash))) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return user?.id ? String(user.id) : null;
  } catch (_) {
    return null;
  }
}

function authenticatedUserId(req, optional = false) {
  const verified = verifyTelegramInitData(req.get("x-telegram-init-data"));
  if (verified) return verified;
  const allowTestIdentity = process.env.NODE_ENV !== "production" || process.env.ALLOW_TEST_TELEGRAM_ID === "true";
  const fallback = req.body?.userId || req.query?.userId;
  if (allowTestIdentity && fallback) return String(fallback);
  if (optional) return null;
  const error = new Error("Open this app from Telegram to continue.");
  error.status = 401;
  throw error;
}

async function getTakenNumbers(raffleId) {
  const snapshot = await db.collection("raffles").doc(String(raffleId)).collection("tickets").get();
  return snapshot.docs
    .map((doc) => Number((doc.data() || {}).number || doc.id))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
}

async function broadcast(req, raffleId, reason = "updated", extra = {}) {
  const io = req.app.get("io");
  if (!io) return;
  try {
    const id = String(raffleId);
    const [raffle, takenNumbers] = await Promise.all([getRaffle(id), getTakenNumbers(id)]);
    io.emit("raffle_updated", {
      raffleId: id,
      reason,
      raffle,
      takenNumbers,
      at: new Date().toISOString(),
      ...extra
    });
  } catch (error) {
    console.error("raffle broadcast failed:", error);
    req.app.get("io")?.emit("raffle_updated", { raffleId: String(raffleId), reason, at: new Date().toISOString(), ...extra });
  }
}

router.get("/raffles", async (req, res) => {
  try {
    await ensureRafflesSeeded();
    await finalizeDueRaffles(req);
    const raffles = await getRaffles();
    return res.json({ success: true, raffles });
  } catch (error) {
    console.error("GET /api/raffles:", error);
    return res.status(500).json({ success: false, error: "Failed to load raffles." });
  }
});

router.get("/raffles/:raffleId", async (req, res) => {
  try {
    const raffle = await getRaffle(req.params.raffleId);
    if (!raffle) return res.status(404).json({ success: false, error: "Raffle not found." });
    return res.json({ success: true, raffle });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to load raffle." });
  }
});

router.get("/raffles/:raffleId/numbers", async (req, res) => {
  try {
    const raffle = await getRaffle(req.params.raffleId);
    if (!raffle) return res.status(404).json({ success: false, error: "Raffle not found." });
    const userId = authenticatedUserId(req, true);
    const snapshot = await db.collection("raffles").doc(raffle.id).collection("tickets").get();
    const taken = {};
    snapshot.docs.forEach((doc) => {
      const ticket = doc.data() || {};
      taken[Number(ticket.number || doc.id)] = userId && String(ticket.userId) === userId ? "yours" : "taken";
    });
    const numbers = Array.from({ length: raffle.ticketLimit }, (_, index) => ({
      number: index + 1,
      status: taken[index + 1] || "available"
    }));
    return res.json({ success: true, raffle, numbers });
  } catch (error) {
    console.error("GET /api/raffles/:raffleId/numbers:", error);
    return res.status(error.status || 500).json({ success: false, error: error.message || "Failed to load numbers." });
  }
});

router.get("/users/me/raffle-tickets", async (req, res) => {
  try {
    const userId = authenticatedUserId(req);
    const retentionMs = 24 * 60 * 60 * 1000;
    await ensureRafflesSeeded();
    const raffles = await getRaffles();
    const purchases = [];
    for (const raffle of raffles) {
      const snapshot = await db.collection("raffles").doc(raffle.id).collection("purchases").where("userId", "==", userId).get();
      snapshot.docs.forEach((doc) => {
        const purchase = doc.data() || {};
        const viewedAt = new Date(purchase.resultViewedAt || 0).getTime();
        if (raffle.status === "completed" && viewedAt > 0 && Date.now() - viewedAt >= retentionMs) return;
        const resultStatus = raffle.status === "completed"
          ? Number(purchase.ticketNumber) === Number(raffle.winningNumber) ? "winner" : "not_winner"
          : null;
        purchases.push({ id: doc.id, raffle, ...purchase, resultStatus });
      });
    }
    purchases.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return res.json({ success: true, purchases });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message || "Failed to load tickets." });
  }
});

router.post("/raffles/:raffleId/result-viewed", async (req, res) => {
  try {
    const userId = authenticatedUserId(req);
    const raffle = await getRaffle(req.params.raffleId);
    if (!raffle) return res.status(404).json({ success: false, error: "Raffle not found." });
    if (raffle.status !== "completed") {
      return res.status(409).json({ success: false, error: "The draw result is not available yet." });
    }
    const purchases = await db.collection("raffles").doc(raffle.id).collection("purchases").where("userId", "==", userId).get();
    const batch = db.batch();
    let changed = 0;
    purchases.docs.forEach((doc) => {
      if (!(doc.data() || {}).resultViewedAt) {
        batch.update(doc.ref, { resultViewedAt: db.FieldValue.serverTimestamp() });
        changed += 1;
      }
    });
    if (changed) await batch.commit();
    return res.json({ success: true, viewedAt: new Date().toISOString(), updated: changed });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message || "Could not record result view." });
  }
});

router.post("/raffles/:raffleId/payments/validate", async (req, res) => {
  try {
    const userId = authenticatedUserId(req);
    const receipt = String(req.body?.receiptTextOrLink || "").trim();
    const submittedPhone = String(req.body?.phone || "").trim();
    if (!receipt) return res.status(400).json({ success: false, error: "Receipt message or transaction link is required." });
    const raffleId = String(req.params.raffleId);
    const raffle = await getRaffle(raffleId);
    if (!raffle) return res.status(404).json({ success: false, error: "Raffle not found." });
    if (raffle.status !== "open" || raffle.availableCount <= 0) return res.status(409).json({ success: false, error: "This raffle is no longer accepting payments." });
    if (raffle.drawAt && Date.now() >= new Date(raffle.drawAt).getTime()) return res.status(409).json({ success: false, error: "This raffle is now in the draw." });

    const userRef = db.collection("users").doc(userId);
    const existingUserDoc = await userRef.get();
    if (!existingUserDoc.exists) return res.status(404).json({ success: false, error: "User not found." });
    const existingUser = existingUserDoc.data() || {};
    if (!existingUser.phone && !/^\+?[\d\s-]{9,18}$/.test(submittedPhone)) {
      return res.status(400).json({ success: false, error: "A valid phone number is required." });
    }

    const serviceResponse = await verifyPayment(receipt, raffle.ticketPrice);
    if (!serviceResponse?.valid) return res.status(400).json({ success: false, error: serviceResponse?.message || "Telebirr payment could not be verified." });
    const transactionId = extractTransactionId(serviceResponse, receipt);
    if (!transactionId) return res.status(400).json({ success: false, error: "The payment transaction ID could not be found." });
    const paidAmount = extractAmount(serviceResponse, raffle.ticketPrice);
    if (paidAmount < raffle.ticketPrice) return res.status(400).json({ success: false, error: `Verified amount must be at least ${raffle.ticketPrice}.` });

    const raffleRef = db.collection("raffles").doc(raffleId);
    const purchaseRef = raffleRef.collection("purchases").doc(transactionId);
    const transactionRef = db.collection("transactions").doc(transactionId);
    let purchase;

    await db.runTransaction(async (tx) => {
      const lockedRaffle = await tx.get(raffleRef);
      const [usedTransaction, existingPurchase, userDoc] = await Promise.all([
        tx.get(transactionRef), tx.get(purchaseRef), tx.get(userRef)
      ]);
      if (!lockedRaffle.exists) throw Object.assign(new Error("Raffle not found."), { status: 404 });
      if (!userDoc.exists) throw Object.assign(new Error("User not found."), { status: 404 });
      if (usedTransaction.exists || existingPurchase.exists) throw Object.assign(new Error("This Telebirr transaction has already been used."), { status: 409 });
      const raffleData = publicRaffle({ id: raffleId, ...lockedRaffle.data() });
      if (raffleData.status !== "open" || raffleData.reservedCount >= raffleData.ticketLimit) throw Object.assign(new Error("This raffle is sold out."), { status: 409 });
      const user = userDoc.data() || {};
      const phone = String(user.phone || submittedPhone).trim();
      if (!phone) throw Object.assign(new Error("A valid phone number is required."), { status: 400 });
      purchase = {
        purchaseId: transactionId,
        raffleId,
        userId,
        displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "Telegram User",
        username: user.username || null,
        phone,
        photo: user.photo || null,
        payment: { transactionId, amount: paidAmount, method: "telebirr" },
        status: "pending_number",
        ticketNumber: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (!user.phone) tx.set(userRef, { phone, updatedAt: db.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(purchaseRef, purchase);
      tx.set(transactionRef, { transactionId, raffleId, userId, amount: paidAmount, purpose: "raffle_ticket", createdAt: db.FieldValue.serverTimestamp() });
      const nextReservedCount = raffleData.reservedCount + 1;
      tx.update(raffleRef, {
        reservedCount: nextReservedCount,
        status: nextReservedCount >= raffleData.ticketLimit ? "sold_out" : "open",
        updatedAt: db.FieldValue.serverTimestamp()
      });
    });

    await invalidateRaffle(raffleId);
    await broadcast(req, raffleId, "payment_validated", {
      purchaseId: purchase?.purchaseId || purchase?.id || null,
      userId: purchase?.userId || null
    });
    return res.json({ success: true, purchase, transactionId, paidAmount });
  } catch (error) {
    console.error("POST /api/raffles/:raffleId/payments/validate:", error);
    return res.status(error.status || 500).json({ success: false, error: error.message || "Failed to validate payment." });
  }
});

router.post("/raffles/:raffleId/purchases/:purchaseId/number", async (req, res) => {
  try {
    const userId = authenticatedUserId(req);
    const raffleId = String(req.params.raffleId);
    const purchaseId = String(req.params.purchaseId);
    const number = Number(req.body?.number);
    if (!Number.isInteger(number)) return res.status(400).json({ success: false, error: "Choose a valid whole number." });

    const raffleRef = db.collection("raffles").doc(raffleId);
    const purchaseRef = raffleRef.collection("purchases").doc(purchaseId);
    const ticketRef = raffleRef.collection("tickets").doc(String(number));
    let savedPurchase;

    await db.runTransaction(async (tx) => {
      const raffleDoc = await tx.get(raffleRef);
      if (!raffleDoc.exists) throw Object.assign(new Error("Raffle not found."), { status: 404 });
      const [purchaseDoc, ticketDoc] = await Promise.all([tx.get(purchaseRef), tx.get(ticketRef)]);
      const raffle = publicRaffle({ id: raffleId, ...raffleDoc.data() });
      if (number < 1 || number > raffle.ticketLimit) throw Object.assign(new Error(`Choose a number from 1 to ${raffle.ticketLimit}.`), { status: 400 });
      if (!purchaseDoc.exists) throw Object.assign(new Error("Paid ticket entitlement not found."), { status: 404 });
      const purchase = purchaseDoc.data() || {};
      if (String(purchase.userId) !== userId) throw Object.assign(new Error("This paid ticket belongs to another user."), { status: 403 });
      if (purchase.status === "assigned") throw Object.assign(new Error("A number has already been saved for this payment."), { status: 409 });
      if (ticketDoc.exists) throw Object.assign(new Error("That number was just taken. Choose another available number."), { status: 409 });
      savedPurchase = { ...purchase, status: "assigned", ticketNumber: number, assignedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      tx.set(purchaseRef, savedPurchase);
      tx.set(ticketRef, { number, raffleId, purchaseId, userId, assignedAt: db.FieldValue.serverTimestamp() });
      tx.update(raffleRef, { assignedCount: db.FieldValue.increment(1), updatedAt: db.FieldValue.serverTimestamp() });
    });

    await invalidateRaffle(raffleId);
    await broadcast(req, raffleId, "number_assigned", {
      number,
      purchaseId,
      userId
    });
    return res.json({ success: true, purchase: savedPurchase });
  } catch (error) {
    console.error("POST /api/raffles/:raffleId/purchases/:purchaseId/number:", error);
    return res.status(error.status || 500).json({ success: false, error: error.message || "Failed to save ticket number." });
  }
});

router.get("/raffle-winners", async (req, res) => {
  try {
    await ensureRafflesSeeded();
    await ensureInitialWinnersSeeded();
    await finalizeDueRaffles(req);
    const raffles = await getRaffles();
    const winners = raffles
      .filter((raffle) => isRecentWinner(raffle))
      .sort((a, b) => String(b.drawnAt).localeCompare(String(a.drawnAt)));
    return res.json({ success: true, winners });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to load past winners." });
  }
});

module.exports = {
  router,
  ensureRafflesSeeded,
  ensureInitialWinnersSeeded,
  finalizeDueRaffles,
  getRaffle,
  getRaffles,
  invalidateRaffle,
  publicRaffle,
  broadcast,
  verifyTelegramInitData,
  isRecentWinner
};
