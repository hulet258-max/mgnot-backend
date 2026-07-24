const fs = require("fs");
const path = require("path");
const { Input, Telegram } = require("telegraf");
const db = require("../config/postgres");
const { raffleUploadsDir } = require("../config/uploads");

const SEND_INTERVAL_MS = 50; // 20/second, safely below Telegram's ~30/second free limit.
let broadcastQueue = Promise.resolve();

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function webAppUrl(raffleId) {
  const base = String(process.env.WEB_APP_URL || process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return raffleId ? `${base}/?raffle=${encodeURIComponent(raffleId)}` : base;
}

function maskPhone(phone) {
  const characters = [...String(phone || "")];
  const digitIndexes = characters
    .map((character, index) => (/\d/.test(character) ? index : -1))
    .filter((index) => index >= 0)
    .slice(-2);
  digitIndexes.forEach((index) => { characters[index] = "•"; });
  return characters.join("") || "Not provided";
}

function itemPhoto(raffle) {
  const image = String(raffle?.coverImageUrl || "");
  if (/^https:\/\//i.test(image)) return image;
  if (image.startsWith("/uploads/raffles/")) {
    const localPath = path.join(raffleUploadsDir, path.basename(image));
    if (fs.existsSync(localPath)) return Input.fromLocalFile(localPath);
  }
  return null;
}

async function sendWithRetry(telegram, recipient, payload, attempt = 0) {
  try {
    if (payload.photo) {
      return await telegram.sendPhoto(recipient, payload.photo, {
        caption: payload.text,
        reply_markup: payload.reply_markup
      });
    }
    return await telegram.sendMessage(recipient, payload.text, {
      reply_markup: payload.reply_markup
    });
  } catch (error) {
    const retryAfter = Number(error?.response?.parameters?.retry_after || 0);
    if (error?.response?.error_code === 429 && retryAfter && attempt < 3) {
      await wait((retryAfter * 1000) + 250);
      return sendWithRetry(telegram, recipient, payload, attempt + 1);
    }
    throw error;
  }
}

function enqueueBroadcast(recipients, payloadFactory) {
  const task = async () => {
    if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN is not configured.");
    const telegram = new Telegram(process.env.BOT_TOKEN);
    const uniqueRecipients = [...new Set(recipients.map(String).filter(Boolean))];
    const result = { total: uniqueRecipients.length, sent: 0, failed: 0 };

    for (const recipient of uniqueRecipients) {
      try {
        await sendWithRetry(telegram, recipient, payloadFactory(recipient));
        result.sent += 1;
      } catch (error) {
        result.failed += 1;
        console.warn(`Telegram message to ${recipient} failed:`, error.message);
      }
      await wait(SEND_INTERVAL_MS);
    }
    return result;
  };

  broadcastQueue = broadcastQueue.then(task, task);
  return broadcastQueue;
}

async function queueDrawResultNotification(raffleId) {
  const raffleRef = db.collection("raffles").doc(String(raffleId));
  const [raffleDoc, purchases] = await Promise.all([
    raffleRef.get(),
    raffleRef.collection("purchases").get()
  ]);
  if (!raffleDoc.exists) return { total: 0, sent: 0, failed: 0 };
  const raffle = { id: String(raffleId), ...raffleDoc.data() };
  const recipients = purchases.docs.map((doc) => (doc.data() || {}).userId);
  const winnerName = raffle.winner?.displayName || raffle.winner?.username || "Winner";
  const text = [
    `🏆 The winner is known for ${raffle.itemName}!`,
    `Winning ticket: #${raffle.winningNumber}`,
    `Winner: ${winnerName}`,
    `Phone: ${maskPhone(raffle.winner?.phone)}`,
    "Open MGNOT to see the completed draw."
  ].join("\n");

  const result = await enqueueBroadcast(recipients, () => ({
    photo: itemPhoto(raffle),
    text,
    reply_markup: { inline_keyboard: [[{ text: "View draw", web_app: { url: webAppUrl(raffle.id) } }]] }
  }));
  await raffleRef.set({
    drawNotification: { ...result, sentAt: new Date().toISOString() }
  }, { merge: true });
  return result;
}

async function queueDrawReminderNotification(raffleId) {
  const raffleRef = db.collection("raffles").doc(String(raffleId));
  const [raffleDoc, purchases] = await Promise.all([
    raffleRef.get(),
    raffleRef.collection("purchases").get()
  ]);
  if (!raffleDoc.exists) return { total: 0, sent: 0, failed: 0 };
  const raffle = { id: String(raffleId), ...raffleDoc.data() };
  const recipients = purchases.docs.map((doc) => (doc.data() || {}).userId);
  const result = await enqueueBroadcast(recipients, () => ({
    photo: itemPhoto(raffle),
    text: `⏰ The draw for ${raffle.itemName} starts in 10 minutes.\nOpen MGNOT now to watch your ticket in the live draw.`,
    reply_markup: { inline_keyboard: [[{ text: "Watch live draw", web_app: { url: webAppUrl(raffle.id) } }]] }
  }));
  await raffleRef.set({
    drawReminder: { ...result, queuedAt: raffle.drawReminder?.queuedAt || new Date().toISOString(), sentAt: new Date().toISOString() }
  }, { merge: true });
  return result;
}

function queueAdminBroadcast({ recipients, message, raffle, buttonLabel }) {
  return enqueueBroadcast(recipients, () => ({
    photo: itemPhoto(raffle),
    text: message,
    reply_markup: {
      inline_keyboard: [[{
        text: buttonLabel || (raffle ? "Buy ticket" : "Open MGNOT"),
        web_app: { url: webAppUrl(raffle?.id) }
      }]]
    }
  }));
}

module.exports = {
  maskPhone,
  queueAdminBroadcast,
  queueDrawReminderNotification,
  queueDrawResultNotification
};
