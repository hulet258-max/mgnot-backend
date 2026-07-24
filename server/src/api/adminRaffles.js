const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const db = require("../config/postgres");
const { raffleUploadsDir } = require("../config/uploads");
const { queueAdminBroadcast } = require("../services/telegramMessaging");
const {
  ensureRafflesSeeded,
  finalizeDueRaffles,
  getRaffle,
  getRaffles,
  invalidateRaffle,
  publicRaffle,
  broadcast
} = require("./raffles");

const router = express.Router();
const SESSION_SECONDS = 8 * 60 * 60;
const VALID_STATUSES = new Set(["draft", "open", "paused", "sold_out", "completed", "archived"]);
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

fs.mkdirSync(raffleUploadsDir, { recursive: true });

const mediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, raffleUploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || (
      file.mimetype === "image/png" ? ".png"
        : file.mimetype === "image/webp" ? ".webp"
          : file.mimetype === "image/gif" ? ".gif"
            : ".jpg"
    );
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
  }
});

const mediaUpload = multer({
  storage: mediaStorage,
  limits: { fileSize: 6 * 1024 * 1024, files: 13 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(Object.assign(new Error("Only JPG, PNG, WEBP or GIF images are allowed."), { status: 400 }));
    }
    return cb(null, true);
  }
});

function publicMediaPath(filename) {
  return `/uploads/raffles/${filename}`;
}

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

function issueToken(username) {
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    role: "platform_admin",
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.exp > Math.floor(Date.now() / 1000) ? session : null;
  } catch (_) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const session = readToken(String(req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!session) return res.status(401).json({ success: false, error: "Admin session is missing or expired." });
  req.admin = session;
  return next();
}

async function audit(req, action, entityId, detail = {}) {
  await db.collection("admin_audit").add({
    action,
    entityType: "raffle",
    entityId: String(entityId || ""),
    actor: req.admin?.sub || "system",
    detail,
    ip: req.ip || null,
    createdAt: new Date().toISOString()
  });
}

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function normalizeImages(value) {
  if (Array.isArray(value)) return value.map((entry) => cleanText(entry, 1000)).filter(Boolean).slice(0, 12);
  return String(value || "").split(/\r?\n|,/).map((entry) => cleanText(entry, 1000)).filter(Boolean).slice(0, 12);
}

function normalizeSpecs(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => ({
      label: cleanText(entry?.label, 80),
      value: cleanText(entry?.value, 160)
    })).filter((entry) => entry.label && entry.value).slice(0, 20);
  }
  return String(value || "").split(/\r?\n/).map((line) => {
    const [label, ...rest] = line.split(":");
    return { label: cleanText(label, 80), value: cleanText(rest.join(":"), 160) };
  }).filter((entry) => entry.label && entry.value).slice(0, 20);
}

function editableRaffle(body = {}, existing = {}) {
  const ticketLimit = Number(body.ticketLimit ?? existing.ticketLimit ?? 0);
  const ticketPrice = Number(body.ticketPrice ?? existing.ticketPrice ?? 0);
  const estimatedValue = Number(body.estimatedValue ?? existing.estimatedValue ?? 0);
  const drawAt = body.drawAt === null ? null : cleanText(body.drawAt ?? existing.drawAt, 80);
  const status = cleanText(body.status ?? existing.status ?? "draft", 20);
  if (!cleanText(body.itemName ?? existing.itemName, 140)) throw Object.assign(new Error("Item name is required."), { status: 400 });
  if (!Number.isInteger(ticketLimit) || ticketLimit < 1 || ticketLimit > 100000) throw Object.assign(new Error("Ticket limit must be a whole number between 1 and 100,000."), { status: 400 });
  if (!Number.isFinite(ticketPrice) || ticketPrice <= 0) throw Object.assign(new Error("Ticket price must be greater than zero."), { status: 400 });
  if (drawAt && !Number.isFinite(new Date(drawAt).getTime())) throw Object.assign(new Error("Draw date and time is invalid."), { status: 400 });
  if (!VALID_STATUSES.has(status)) throw Object.assign(new Error("Raffle status is invalid."), { status: 400 });
  if (Number(existing.reservedCount || 0) > ticketLimit) throw Object.assign(new Error("Ticket limit cannot be below tickets already paid for."), { status: 409 });

  return {
    itemName: cleanText(body.itemName ?? existing.itemName, 140),
    shortDescription: cleanText(body.shortDescription ?? existing.shortDescription, 240),
    description: cleanText(body.description ?? existing.description, 5000),
    condition: cleanText(body.condition ?? existing.condition, 80),
    estimatedValue: Math.max(0, estimatedValue),
    ticketPrice,
    ticketLimit,
    status,
    coverImageUrl: cleanText(body.coverImageUrl ?? existing.coverImageUrl, 1000),
    galleryImageUrls: normalizeImages(body.galleryImageUrls ?? existing.galleryImageUrls),
    specifications: normalizeSpecs(body.specifications ?? existing.specifications),
    provider: {
      name: cleanText(body.provider?.name ?? existing.provider?.name, 120),
      phone: cleanText(body.provider?.phone ?? existing.provider?.phone, 40),
      location: cleanText(body.provider?.location ?? existing.provider?.location, 180)
    },
    drawAt: drawAt ? new Date(drawAt).toISOString() : null
  };
}

async function raffleOperations(raffle) {
  const ref = db.collection("raffles").doc(raffle.id);
  const [purchaseSnapshot, ticketSnapshot] = await Promise.all([
    ref.collection("purchases").get(),
    ref.collection("tickets").get()
  ]);
  const purchases = purchaseSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const tickets = ticketSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => Number(a.number || a.id) - Number(b.number || b.id));
  const revenue = purchases.reduce((sum, entry) => sum + Number(entry.payment?.amount || 0), 0);
  return {
    ...raffle,
    purchases,
    tickets,
    metrics: {
      revenue,
      paid: purchases.length,
      assigned: purchases.filter((entry) => entry.status === "assigned").length,
      awaitingNumber: purchases.filter((entry) => entry.status === "pending_number").length,
      fillPercent: raffle.ticketLimit ? Math.round((purchases.length / raffle.ticketLimit) * 1000) / 10 : 0
    }
  };
}

router.post("/auth/login", (req, res) => {
  if (process.env.NODE_ENV === "production" && (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.ADMIN_SESSION_SECRET)) {
    return res.status(503).json({ success: false, error: "Admin credentials are not configured on the server." });
  }
  const expectedUser = process.env.ADMIN_USERNAME || "admin";
  const expectedPassword = process.env.ADMIN_PASSWORD || "change-me";
  const username = cleanText(req.body?.username, 100);
  const password = String(req.body?.password || "");
  if (!safeEqual(username, expectedUser) || !safeEqual(password, expectedPassword)) {
    return res.status(401).json({ success: false, error: "Invalid admin username or password." });
  }
  return res.json({ success: true, token: issueToken(username), expiresIn: SESSION_SECONDS });
});

router.post("/auth/logout", requireAdmin, (_req, res) => res.json({ success: true }));
router.use(requireAdmin);

router.post(
  "/raffle-control/media",
  (req, res, next) => {
    mediaUpload.fields([
      { name: "cover", maxCount: 1 },
      { name: "gallery", maxCount: 12 }
    ])(req, res, (error) => {
      if (!error) return next();
      const status = error.status || (error.code === "LIMIT_FILE_SIZE" ? 400 : 400);
      return res.status(status).json({
        success: false,
        error: error.code === "LIMIT_FILE_SIZE"
          ? "Each image must be 6 MB or smaller."
          : error.message || "Could not upload images."
      });
    });
  },
  async (req, res) => {
    try {
      const coverFile = req.files?.cover?.[0] || null;
      const galleryFiles = req.files?.gallery || [];
      if (!coverFile && !galleryFiles.length) {
        return res.status(400).json({ success: false, error: "Choose at least one image from your device." });
      }
      const coverImageUrl = coverFile ? publicMediaPath(coverFile.filename) : null;
      const galleryImageUrls = galleryFiles.map((file) => publicMediaPath(file.filename));
      await audit(req, "media.uploaded", "raffle-media", {
        cover: Boolean(coverImageUrl),
        galleryCount: galleryImageUrls.length
      });
      return res.status(201).json({
        success: true,
        coverImageUrl,
        galleryImageUrls
      });
    } catch (error) {
      console.error("POST /api/admin/raffle-control/media:", error);
      return res.status(500).json({ success: false, error: "Could not upload images." });
    }
  }
);

router.get("/raffle-control/overview", async (req, res) => {
  try {
    await ensureRafflesSeeded();
    await finalizeDueRaffles(req);
    const raffles = await getRaffles();
    const operations = await Promise.all(raffles.map(raffleOperations));
    const purchases = operations.flatMap((raffle) => raffle.purchases.map((purchase) => ({
      ...purchase,
      raffleId: raffle.id,
      itemName: raffle.itemName,
      ticketPrice: raffle.ticketPrice
    })));
    const now = Date.now();
    const metrics = {
      totalItems: raffles.length,
      liveItems: raffles.filter((entry) => ["open", "sold_out"].includes(entry.status)).length,
      dueWithin24Hours: raffles.filter((entry) => {
        const time = new Date(entry.drawAt || 0).getTime();
        return time > now && time - now <= 86400000 && ["open", "sold_out"].includes(entry.status);
      }).length,
      paidTickets: purchases.length,
      assignedTickets: purchases.filter((entry) => entry.status === "assigned").length,
      awaitingNumber: purchases.filter((entry) => entry.status === "pending_number").length,
      revenue: purchases.reduce((sum, entry) => sum + Number(entry.payment?.amount || 0), 0),
      completedDraws: raffles.filter((entry) => entry.status === "completed").length
    };
    return res.json({ success: true, metrics, raffles: operations.map(({ purchases: _p, tickets: _t, ...entry }) => entry), purchases: purchases.slice(0, 250) });
  } catch (error) {
    console.error("GET /api/admin/raffle-control/overview:", error);
    return res.status(500).json({ success: false, error: "Could not load raffle control data." });
  }
});

router.get("/raffle-control/raffles/:raffleId", async (req, res) => {
  try {
    const raffle = await getRaffle(req.params.raffleId);
    if (!raffle) return res.status(404).json({ success: false, error: "Raffle not found." });
    return res.json({ success: true, raffle: await raffleOperations(raffle) });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Could not load raffle operations." });
  }
});

router.post("/raffle-control/raffles", async (req, res) => {
  try {
    const values = editableRaffle(req.body);
    const id = cleanText(req.body?.id, 80).replace(/[^a-zA-Z0-9_-]/g, "") || crypto.randomUUID();
    const ref = db.collection("raffles").doc(id);
    if ((await ref.get()).exists) return res.status(409).json({ success: false, error: "A raffle with this ID already exists." });
    const raffle = {
      ...values,
      reservedCount: 0,
      assignedCount: 0,
      winningNumber: null,
      winner: null,
      drawnAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await ref.set(raffle);
    await invalidateRaffle(id);
    await audit(req, "raffle.created", id, { itemName: raffle.itemName, status: raffle.status });
    await broadcast(req, id, "raffle_created");
    return res.status(201).json({ success: true, raffle: publicRaffle({ id, ...raffle }) });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message || "Could not create raffle." });
  }
});

router.patch("/raffle-control/raffles/:raffleId", async (req, res) => {
  try {
    const id = String(req.params.raffleId);
    const ref = db.collection("raffles").doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, error: "Raffle not found." });
    const existing = snapshot.data() || {};
    if (existing.status === "completed" && req.body?.status && req.body.status !== "completed" && req.body.status !== "archived") {
      return res.status(409).json({ success: false, error: "A completed draw cannot be reopened." });
    }
    const patch = editableRaffle(req.body, existing);
    await ref.set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
    await invalidateRaffle(id);
    await audit(req, "raffle.updated", id, {
      changedFields: Object.keys(req.body || {}),
      previousStatus: existing.status,
      nextStatus: patch.status
    });
    await broadcast(req, id, "raffle_updated", {
      previousStatus: existing.status,
      nextStatus: patch.status
    });
    return res.json({ success: true, raffle: await getRaffle(id) });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message || "Could not update raffle." });
  }
});

router.delete("/raffle-control/raffles/:raffleId", async (req, res) => {
  try {
    const id = String(req.params.raffleId);
    const raffleRef = db.collection("raffles").doc(id);
    const raffleDoc = await raffleRef.get();
    if (!raffleDoc.exists) {
      return res.status(404).json({ success: false, error: "Raffle not found." });
    }

    const raffle = { id, ...raffleDoc.data() };
    const [operations, transactionSnapshot] = await Promise.all([
      raffleOperations(publicRaffle(raffle)),
      db.collection("transactions").where("raffleId", "==", id).get()
    ]);

    await db.runTransaction(async (tx) => {
      await tx.delete(raffleRef);
      for (const transactionDoc of transactionSnapshot.docs) {
        await tx.delete(transactionDoc.ref);
      }
    });

    await invalidateRaffle(id);
    await audit(req, "raffle.deleted", id, {
      itemName: raffle.itemName,
      status: raffle.status,
      purchasesDeleted: operations.purchases.length,
      ticketsDeleted: operations.tickets.length,
      transactionsDeleted: transactionSnapshot.size
    });
    req.app.get("io")?.emit("raffle_updated", {
      raffleId: id,
      reason: "raffle_deleted",
      deleted: true,
      at: new Date().toISOString()
    });

    return res.json({ success: true, deletedId: id });
  } catch (error) {
    console.error("DELETE /api/admin/raffle-control/raffles/:raffleId:", error);
    return res.status(500).json({ success: false, error: "Could not delete raffle item." });
  }
});

router.post("/raffle-control/raffles/:raffleId/run-draw", async (req, res) => {
  try {
    const id = String(req.params.raffleId);
    const before = await getRaffle(id);
    if (!before) return res.status(404).json({ success: false, error: "Raffle not found." });
    if (before.status === "completed") return res.status(409).json({ success: false, error: "This raffle was already drawn." });
    const eligibleAt = new Date(before.drawAt || 0).getTime();
    if (!before.drawAt || Date.now() < eligibleAt) {
      return res.status(409).json({ success: false, error: "The secure draw becomes available at the scheduled draw time." });
    }
    if (!before.assignedCount) return res.status(409).json({ success: false, error: "There are no assigned ticket numbers to draw." });
    await finalizeDueRaffles(req);
    const raffle = await getRaffle(id);
    if (raffle?.status !== "completed") return res.status(409).json({ success: false, error: "The draw could not be finalized. Verify assigned ticket records." });
    await audit(req, "draw.finalized", id, { winningNumber: raffle.winningNumber, winnerUserId: raffle.winner?.userId || null });
    await broadcast(req, id, "draw_completed", { winningNumber: raffle.winningNumber });
    return res.json({ success: true, raffle });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message || "Could not run draw." });
  }
});

router.get("/messaging/audience", async (_req, res) => {
  try {
    const [usersSnapshot, raffles] = await Promise.all([
      db.collection("users").get(),
      getRaffles()
    ]);
    const purchasesByUser = new Map();

    for (const raffle of raffles) {
      const purchases = await db.collection("raffles").doc(raffle.id).collection("purchases").get();
      purchases.docs.forEach((purchaseDoc) => {
        const userId = String((purchaseDoc.data() || {}).userId || "");
        if (!userId) return;
        if (!purchasesByUser.has(userId)) purchasesByUser.set(userId, new Set());
        purchasesByUser.get(userId).add(raffle.id);
      });
    }

    const users = usersSnapshot.docs.map((doc) => {
      const user = doc.data() || {};
      return {
        telegramId: String(user.telegramId || doc.id),
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        username: user.username || "",
        phone: user.phone || "",
        joinedAt: user.createdAt || null,
        purchasedRaffleIds: [...(purchasesByUser.get(String(user.telegramId || doc.id)) || [])]
      };
    });
    return res.json({
      success: true,
      users,
      raffles: raffles.map((raffle) => ({
        id: raffle.id,
        itemName: raffle.itemName,
        status: raffle.status,
        coverImageUrl: raffle.coverImageUrl
      }))
    });
  } catch (error) {
    console.error("GET /api/admin/messaging/audience:", error);
    return res.status(500).json({ success: false, error: "Could not load messaging audience." });
  }
});

router.post("/messaging/send", async (req, res) => {
  try {
    const message = cleanText(req.body?.message, 900);
    const audience = cleanText(req.body?.audience, 30) || "all";
    const raffleId = cleanText(req.body?.raffleId, 160);
    const buttonLabel = cleanText(req.body?.buttonLabel, 40);
    if (!message) return res.status(400).json({ success: false, error: "Message text is required." });
    if (!["all", "bought", "not_bought"].includes(audience)) {
      return res.status(400).json({ success: false, error: "Audience filter is invalid." });
    }
    if (audience !== "all" && !raffleId) {
      return res.status(400).json({ success: false, error: "Choose an item for this audience filter." });
    }

    const usersSnapshot = await db.collection("users").get();
    const purchasedUserIds = new Set();
    let raffle = null;
    if (raffleId) {
      raffle = await getRaffle(raffleId);
      if (!raffle) return res.status(404).json({ success: false, error: "Selected raffle item was not found." });
      const purchases = await db.collection("raffles").doc(raffleId).collection("purchases").get();
      purchases.docs.forEach((doc) => purchasedUserIds.add(String((doc.data() || {}).userId || "")));
    }

    const recipients = usersSnapshot.docs
      .map((doc) => String((doc.data() || {}).telegramId || doc.id))
      .filter((userId) =>
        audience === "all" ||
        (audience === "bought" && purchasedUserIds.has(userId)) ||
        (audience === "not_bought" && !purchasedUserIds.has(userId))
      );
    const jobRef = await db.collection("broadcast_jobs").add({
      audience,
      raffleId: raffleId || null,
      message,
      recipientCount: recipients.length,
      status: "queued",
      actor: req.admin?.sub || "admin",
      createdAt: new Date().toISOString()
    });

    queueAdminBroadcast({ recipients, message, raffle, buttonLabel })
      .then((result) => jobRef.set({ status: "completed", ...result, completedAt: new Date().toISOString() }, { merge: true }))
      .catch((error) => jobRef.set({ status: "failed", error: error.message, completedAt: new Date().toISOString() }, { merge: true }));

    await audit(req, "message.queued", jobRef.id, {
      audience,
      raffleId: raffleId || null,
      recipients: recipients.length
    });
    return res.status(202).json({ success: true, jobId: jobRef.id, recipients: recipients.length });
  } catch (error) {
    console.error("POST /api/admin/messaging/send:", error);
    return res.status(500).json({ success: false, error: "Could not queue Telegram message." });
  }
});

router.get("/raffle-control/audit", async (_req, res) => {
  try {
    const snapshot = await db.collection("admin_audit").get();
    const entries = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 300);
    return res.json({ success: true, entries });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Could not load the admin audit trail." });
  }
});

module.exports = router;
