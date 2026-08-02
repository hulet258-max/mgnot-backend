// server/src/bot/bot.js

const { Telegraf } = require("telegraf");

const MENU_LABELS = Object.freeze({
  buy: "🎟 ትኬት ይግዙ | Buy Ticket",
  tickets: "🎫 የእኔ ትኬቶች | My Tickets",
  draws: "🏆 ዕጣና አሸናፊዎች | Draws",
  help: "ℹ️ እገዛ | Help",
});

const RETAINED_TICKET_LIMIT = 10;
const RECENT_WINNER_LIMIT = 3;

function configuredHttpsUrl(value, missingMessage, label) {
  const configuredUrl = String(value || "").trim();
  if (!configuredUrl) {
    if (missingMessage) throw new Error(missingMessage);
    return null;
  }

  const parsedUrl = new URL(configuredUrl);
  if (!["https:", "http:"].includes(parsedUrl.protocol)) {
    throw new Error(`${label} must be an HTTP(S) URL`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  return parsedUrl;
}

function webAppUrl(route = "") {
  const parsedUrl = configuredHttpsUrl(
    process.env.WEB_APP_URL || process.env.FRONTEND_URL,
    "WEB_APP_URL (or FRONTEND_URL) missing in env",
    "WEB_APP_URL"
  );

  const cleanRoute = String(route || "").replace(/^\/+|\/+$/g, "");
  if (cleanRoute) {
    const basePath = parsedUrl.pathname.replace(/\/+$/, "");
    parsedUrl.pathname = `${basePath}/${cleanRoute}`.replace(/\/{2,}/g, "/");
  }
  return parsedUrl.toString();
}

function supportUrl() {
  const parsedUrl = configuredHttpsUrl(
    process.env.SUPPORT_URL,
    null,
    "SUPPORT_URL"
  );
  return parsedUrl?.toString() || null;
}

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_LABELS.buy, web_app: { url: webAppUrl() } }],
      [{ text: MENU_LABELS.tickets }, { text: MENU_LABELS.draws }],
      [{ text: MENU_LABELS.help }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Choose an option | አማራጭ ይምረጡ",
  };
}

function inlineWebAppButton(text, route = "") {
  return { inline_keyboard: [[{ text, web_app: { url: webAppUrl(route) } }]] };
}

function formatDrawTime(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "To be announced | በቅርቡ";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Addis_Ababa",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function ticketStatus(purchase, raffle) {
  if (raffle.status === "completed") {
    return Number(purchase.ticketNumber) === Number(raffle.winningNumber)
      ? "🏆 Winner | አሸናፊ"
      : "Not selected | አላሸነፈም";
  }
  if (purchase.status === "assigned") return "Active | በዕጣው ውስጥ";
  return "Choose a number | ቁጥር ይምረጡ";
}

async function loadUserTickets(db, userId) {
  const raffleSnapshot = await db.collection("raffles").get();
  const purchases = [];

  for (const raffleDoc of raffleSnapshot.docs) {
    const raffle = { id: raffleDoc.id, ...(raffleDoc.data() || {}) };
    const purchaseSnapshot = await raffleDoc.ref
      .collection("purchases")
      .where("userId", "==", String(userId))
      .get();
    purchaseSnapshot.docs.forEach((purchaseDoc) => {
      purchases.push({
        id: purchaseDoc.id,
        raffle,
        ...(purchaseDoc.data() || {}),
      });
    });
  }

  return purchases
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, RETAINED_TICKET_LIMIT);
}

function ticketsMessage(purchases) {
  if (!purchases.length) {
    return "🎫 እስካሁን ምንም ትኬት የለዎትም።\nYou do not have any tickets yet.";
  }

  const lines = ["🎫 የእርስዎ ትኬቶች | Your tickets"];
  purchases.forEach((purchase, index) => {
    const raffle = purchase.raffle || {};
    const number = purchase.status === "assigned" && purchase.ticketNumber
      ? `#${purchase.ticketNumber}`
      : "Not selected | አልተመረጠም";
    lines.push(
      "",
      `${index + 1}. ${raffle.itemName || "Item raffle"}`,
      `Ticket | ትኬት: ${number}`,
      `Status | ሁኔታ: ${ticketStatus(purchase, raffle)}`
    );
  });
  return lines.join("\n");
}

async function loadDraws(db) {
  const snapshot = await db.collection("raffles").get();
  const raffles = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  const upcoming = raffles
    .filter((raffle) => ["open", "sold_out"].includes(raffle.status))
    .sort((a, b) => new Date(a.drawAt || 8640000000000000) - new Date(b.drawAt || 8640000000000000))[0] || null;
  const winners = raffles
    .filter((raffle) => raffle.status === "completed" && raffle.winningNumber && raffle.winner)
    .sort((a, b) => String(b.drawnAt || "").localeCompare(String(a.drawnAt || "")))
    .slice(0, RECENT_WINNER_LIMIT);
  return { upcoming, winners };
}

function drawsMessage({ upcoming, winners }) {
  const lines = ["🏆 ዕጣና አሸናፊዎች | Draws & winners"];

  if (upcoming) {
    lines.push(
      "",
      "⏰ Next draw | ቀጣይ ዕጣ",
      `${upcoming.itemName || "Item raffle"}`,
      formatDrawTime(upcoming.drawAt)
    );
  } else {
    lines.push("", "No upcoming draw right now. | በአሁኑ ጊዜ ቀጣይ ዕጣ የለም።");
  }

  if (winners.length) {
    lines.push("", "Recent winners | የቅርብ ጊዜ አሸናፊዎች");
    winners.forEach((raffle) => {
      const winnerName = raffle.winner?.displayName || raffle.winner?.username || "Winner";
      lines.push(`• ${raffle.itemName}: #${raffle.winningNumber} — ${winnerName}`);
    });
  } else {
    lines.push("", "No completed draws yet. | ገና የተጠናቀቀ ዕጣ የለም።");
  }

  return lines.join("\n");
}

function helpMessage() {
  return [
    "ℹ️ ትኬት እንዴት እንደሚገዙ | How to buy a ticket",
    "",
    "1. Buy Ticket የሚለውን ይጫኑ። | Tap Buy Ticket.",
    "2. የሚፈልጉትን ዕቃና ክፍት ቁጥር ይምረጡ። | Choose an item and available number.",
    "3. ትክክለኛውን ዋጋ በቴሌብር ይክፈሉ። | Pay the exact price with Telebirr.",
    "4. መልዕክቱን፣ ሊንኩን ወይም ስክሪንሾቱን ያስገቡ። | Submit the message, link, or screenshot.",
  ].join("\n");
}

async function registerTelegramUser(db, from) {
  if (!from?.id) throw new Error("Telegram user ID missing from /start update");

  const userRef = db.collection("users").doc(String(from.id));
  const userDoc = await userRef.get();
  const profile = {
    telegramId: from.id,
    username: from.username || "",
    firstName: from.first_name || "",
    lastName: from.last_name || "",
    lastSeen: new Date(),
  };

  if (!userDoc.exists) {
    Object.assign(profile, {
      phone: "",
      balance: 0,
      roomIn: null,
      depositSum: 0,
      createdAt: new Date(),
    });
  }

  await userRef.set(profile, { merge: true });
  return { isNewUser: !userDoc.exists, user: profile };
}

function isPrivateChat(ctx) {
  return ctx.chat?.type === "private";
}

async function privateChatRequired(ctx) {
  if (isPrivateChat(ctx)) return true;
  await ctx.reply("Please use this feature in a private chat with MGNOT. | እባክዎ ይህን አገልግሎት በግል ቻት ይጠቀሙ።");
  return false;
}

function createBot(db) {
  if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing in env");
  webAppUrl();
  supportUrl();

  const bot = new Telegraf(process.env.BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      if (!(await privateChatRequired(ctx))) return;
      await registerTelegramUser(db, ctx.from);
      const firstName = ctx.from?.first_name ? `${ctx.from.first_name}, ` : "";
      await ctx.reply(
        `${firstName}እንኳን ደህና መጡ! 👋\nWelcome to MGNOT. Use the buttons below to buy a ticket, check your tickets, view draws, or get help.`,
        { reply_markup: mainKeyboard() }
      );
      await ctx.reply("MGNOTን ይክፈቱ | Open MGNOT", {
        reply_markup: inlineWebAppButton("🎟 Buy Ticket | ትኬት ይግዙ"),
      });
    } catch (error) {
      console.error("Bot /start error:", error);
      await ctx.reply("MGNOTን አሁን መክፈት አልተቻለም። እባክዎ ቆይተው ይሞክሩ።\nWe could not open MGNOT. Please try again shortly.");
    }
  });

  const showTickets = async (ctx) => {
    try {
      if (!(await privateChatRequired(ctx))) return;
      const purchases = await loadUserTickets(db, ctx.from.id);
      await ctx.reply(ticketsMessage(purchases), {
        reply_markup: inlineWebAppButton("🎫 Open My Tickets | ትኬቶቼን ክፈት", "tickets"),
      });
    } catch (error) {
      console.error("Bot tickets error:", error);
      await ctx.reply("ትኬቶችዎን መጫን አልተቻለም። እንደገና ይሞክሩ።\nCould not load your tickets. Please try again.");
    }
  };

  const showDraws = async (ctx) => {
    try {
      if (!(await privateChatRequired(ctx))) return;
      await ctx.reply(drawsMessage(await loadDraws(db)), {
        reply_markup: inlineWebAppButton("🏆 Open Draw | ዕጣውን ክፈት", "draw"),
      });
    } catch (error) {
      console.error("Bot draws error:", error);
      await ctx.reply("የዕጣ መረጃውን መጫን አልተቻለም። እንደገና ይሞክሩ።\nCould not load draw information. Please try again.");
    }
  };

  const showHelp = async (ctx) => {
    try {
      if (!(await privateChatRequired(ctx))) return;
      const buttons = [[{ text: "🎟 Buy Ticket | ትኬት ይግዙ", web_app: { url: webAppUrl() } }]];
      const configuredSupportUrl = supportUrl();
      if (configuredSupportUrl) {
        buttons.push([{ text: "💬 Contact Support | ድጋፍ", url: configuredSupportUrl }]);
      }
      await ctx.reply(helpMessage(), { reply_markup: { inline_keyboard: buttons } });
    } catch (error) {
      console.error("Bot help error:", error);
      await ctx.reply("እገዛን መጫን አልተቻለም።\nCould not load help. Please try again.");
    }
  };

  bot.command("tickets", showTickets);
  bot.hears(MENU_LABELS.tickets, showTickets);
  bot.command("draws", showDraws);
  bot.hears(MENU_LABELS.draws, showDraws);
  bot.command("help", showHelp);
  bot.hears(MENU_LABELS.help, showHelp);

  bot.on("contact", async (ctx) => {
    try {
      if (!(await privateChatRequired(ctx))) return;
      const contact = ctx.message.contact;
      if (contact.user_id !== ctx.from.id) return ctx.reply("Please share your own number. | እባክዎ የራስዎን ቁጥር ያጋሩ።");

      const userRef = db.collection("users").doc(String(ctx.from.id));
      const userDoc = await userRef.get();
      const userData = userDoc.exists ? {
        phone: contact.phone_number,
        username: ctx.from.username || "",
        firstName: ctx.from.first_name || "",
        lastName: ctx.from.last_name || "",
        lastSeen: new Date(),
      } : {
        telegramId: ctx.from.id,
        phone: contact.phone_number,
        username: ctx.from.username || "",
        firstName: ctx.from.first_name || "",
        lastName: ctx.from.last_name || "",
        balance: 0,
        roomIn: null,
        depositSum: 0,
        createdAt: new Date(),
        lastSeen: new Date(),
      };

      await userRef.set(userData, { merge: true });
      await ctx.reply("Registration complete. | ምዝገባው ተጠናቋል።", { reply_markup: mainKeyboard() });
      await ctx.reply("Open the Web App | ዌብ መተግበሪያውን ይክፈቱ", {
        reply_markup: inlineWebAppButton("Open MGNOT | MGNOTን ይክፈቱ"),
      });
    } catch (error) {
      console.error("Bot contact error:", error);
      await ctx.reply("Failed to save your data. | መረጃዎን ማስቀመጥ አልተቻለም።");
    }
  });

  bot.action("withdraw_sent", async (ctx) => {
    try {
      await ctx.answerCbQuery("Marked as done");
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: "Done", callback_data: "withdraw_done" }]],
      });
    } catch (error) {
      console.error("Withdraw button callback error:", error);
    }
  });

  bot.action("withdraw_done", async (ctx) => ctx.answerCbQuery("Already done"));
  return bot;
}

async function startBot(bot) {
  let markReady;
  let markFailed;
  const readyPromise = new Promise((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });

  const launchPromise = bot.launch({}, markReady);
  launchPromise.catch(markFailed);
  await readyPromise;
  await bot.telegram.setMyCommands([
    { command: "start", description: "Open the MGNOT menu" },
    { command: "tickets", description: "View my tickets" },
    { command: "draws", description: "View draws and winners" },
    { command: "help", description: "Buying and payment help" },
  ]).catch((error) => console.warn("Could not register Telegram bot commands:", error.message));

  console.log(`Telegram bot @${bot.botInfo.username} started.`);
  return { launchPromise };
}

module.exports = {
  MENU_LABELS,
  createBot,
  drawsMessage,
  helpMessage,
  loadDraws,
  loadUserTickets,
  mainKeyboard,
  registerTelegramUser,
  startBot,
  supportUrl,
  ticketsMessage,
  webAppUrl,
};
