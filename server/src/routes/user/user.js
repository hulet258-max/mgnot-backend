// server/src/routes/user.js

const express = require("express");
const router = express.Router();
const db = require("../../config/postgres");
const { verifyTelegramInitData } = require("../../api/raffles");

function normalizePhone(value) {
  const phone = String(value || "").trim().replace(/\s+/g, " ");
  const digitCount = phone.replace(/\D/g, "").length;
  if (!/^\+?[\d\s-]+$/.test(phone) || digitCount < 9 || digitCount > 15) {
    return null;
  }
  return phone;
}

function authenticatedUserId(req) {
  const verifiedId = verifyTelegramInitData(req.get("x-telegram-init-data"));
  if (verifiedId) return verifiedId;

  const allowTestIdentity =
    process.env.NODE_ENV !== "production" ||
    process.env.ALLOW_TEST_TELEGRAM_ID === "true";
  if (allowTestIdentity && req.body?.telegramId) {
    return String(req.body.telegramId);
  }

  const error = new Error("Open this app from Telegram to update your phone number.");
  error.status = 401;
  throw error;
}

router.post("/telegram-user", async (req, res) => {
  try {
    const { telegramId } = req.body;

    if (!telegramId) {
      return res.status(400).json({ success: false, error: "telegramId missing" });
    }

    const doc = await db
      .collection("users")
      .doc(String(telegramId))
      .get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    res.json({ success: true, user: doc.data() });
  } catch (err) {
    console.error("❌ /api/telegram-user error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

router.put("/telegram-user/phone", async (req, res) => {
  try {
    const telegramId = authenticatedUserId(req);
    const phone = normalizePhone(req.body?.phone);

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: "Enter a valid phone number with 9 to 15 digits.",
      });
    }

    const userRef = db.collection("users").doc(telegramId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    await userRef.set(
      { phone, updatedAt: db.FieldValue.serverTimestamp() },
      { merge: true }
    );

    return res.json({ success: true, phone });
  } catch (err) {
    console.error("Phone update error:", err);
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || "Could not update phone number.",
    });
  }
});

module.exports = router;
module.exports._internals = { normalizePhone };
