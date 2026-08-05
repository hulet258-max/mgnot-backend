const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  MENU_LABELS,
  createBot,
  drawsMessage,
  helpMessage,
  loadDraws,
  loadUserTickets,
  registerTelegramUser,
  startMessage,
  supportUrl,
  ticketsMessage,
  webAppUrl,
} = require("../src/bot/bot");
const { maskPhone } = require("../src/services/telegramMessaging");

function memoryDb(initialUser) {
  let stored = initialUser ? { ...initialUser } : null;

  return {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return {
                exists: Boolean(stored),
                data: () => (stored ? { ...stored } : undefined),
              };
            },
            async set(data, options) {
              stored = options?.merge ? { ...(stored || {}), ...data } : { ...data };
            },
          };
        },
      };
    },
    read: () => stored,
  };
}

function raffleDb(raffles) {
  const docs = raffles.map((raffle) => {
    const { purchases = [], ...data } = raffle;
    return {
      id: raffle.id,
      data: () => ({ ...data }),
      ref: {
        collection(name) {
          assert.equal(name, "purchases");
          return {
            where(field, operator, userId) {
              assert.deepEqual([field, operator], ["userId", "=="]);
              return {
                async get() {
                  return {
                    docs: purchases
                      .filter((purchase) => String(purchase.userId) === String(userId))
                      .map((purchase, index) => ({
                        id: purchase.id || `purchase-${index}`,
                        data: () => ({ ...purchase }),
                      })),
                  };
                },
              };
            },
          };
        },
      },
    };
  });

  return {
    collection(name) {
      assert.equal(name, "raffles");
      return { get: async () => ({ docs }) };
    },
  };
}

async function withBotEnvironment(run, overrides = {}) {
  const previous = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    WEB_APP_URL: process.env.WEB_APP_URL,
    FRONTEND_URL: process.env.FRONTEND_URL,
    SUPPORT_URL: process.env.SUPPORT_URL,
  };
  process.env.BOT_TOKEN = "test-token";
  process.env.WEB_APP_URL = "https://frontend.example.com/app";
  delete process.env.FRONTEND_URL;
  delete process.env.SUPPORT_URL;
  Object.entries(overrides).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });

  try {
    return await run();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

function preparedBot(db, calls) {
  const bot = createBot(db);
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "MGNOT",
    username: "mgnot_test_bot",
  };
  bot.context.telegram = {
    sendPhoto: async (chatId, photo, payload) => {
      calls.push({ type: "photo", chatId, photo, ...payload });
      return { message_id: calls.length };
    },
    sendMessage: async (chatId, text, payload) => {
      calls.push({ type: "message", chatId, text, ...payload });
      return { message_id: calls.length };
    },
  };
  return bot;
}

function messageUpdate(text, updateId = 1, chatType = "private") {
  const update = {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: chatType },
      from: { id: 42, is_bot: false, first_name: "Demo" },
      text,
    },
  };
  if (text.startsWith("/")) {
    update.message.entities = [{ offset: 0, length: text.length, type: "bot_command" }];
  }
  return update;
}

test("/start registration creates defaults without requiring a phone", async () => {
  const db = memoryDb();
  const result = await registerTelegramUser(db, {
    id: 42,
    username: "demo",
    first_name: "Demo",
  });

  assert.equal(result.isNewUser, true);
  assert.deepEqual(
    {
      telegramId: db.read().telegramId,
      username: db.read().username,
      phone: db.read().phone,
      balance: db.read().balance,
      roomIn: db.read().roomIn,
      depositSum: db.read().depositSum,
    },
    {
      telegramId: 42,
      username: "demo",
      phone: "",
      balance: 0,
      roomIn: null,
      depositSum: 0,
    }
  );
  assert.ok(db.read().createdAt instanceof Date);
});

test("repeat /start refreshes profile without resetting account values", async () => {
  const db = memoryDb({
    telegramId: 42,
    username: "old_name",
    phone: "+251900000000",
    balance: 175,
    depositSum: 200,
    createdAt: "original",
  });

  const result = await registerTelegramUser(db, {
    id: 42,
    username: "new_name",
    first_name: "New",
  });

  assert.equal(result.isNewUser, false);
  assert.equal(db.read().username, "new_name");
  assert.equal(db.read().balance, 175);
  assert.equal(db.read().depositSum, 200);
  assert.equal(db.read().phone, "+251900000000");
  assert.equal(db.read().createdAt, "original");
});

test("/start sends the image, short instructions, and inline Web App action together", async () => {
  await withBotEnvironment(async () => {
    const calls = [];
    const bot = preparedBot(memoryDb(), calls);
    await bot.handleUpdate(messageUpdate("/start"));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "photo");
    assert.equal(path.basename(calls[0].photo.source), "intro.png");
    assert.match(calls[0].caption, /^Demo, እንኳን ደህና መጡ!/);
    assert.equal(calls[0].caption, startMessage("Demo, "));
    assert.ok(calls[0].caption.length <= 1024);
    assert.doesNotMatch(calls[0].caption, /How to buy|Before paying|English/);
    assert.equal(calls[0].reply_markup.inline_keyboard[0][0].web_app.url, "https://frontend.example.com/app");
  });
});

test("/start still sends instructions and buttons when the intro photo fails", async () => {
  await withBotEnvironment(async () => {
    const calls = [];
    const bot = preparedBot(memoryDb(), calls);
    bot.context.telegram.sendPhoto = async () => { throw new Error("photo unavailable"); };

    await bot.handleUpdate(messageUpdate("/start"));

    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /^Demo, እንኳን ደህና መጡ!/);
    assert.equal(calls[0].text, startMessage("Demo, "));
    assert.equal(calls[0].reply_markup.inline_keyboard[0][0].web_app.url, "https://frontend.example.com/app");
  });
});

test("Buy Ticket keyboard button sends instructions with an inline Web App action", async () => {
  await withBotEnvironment(async () => {
    const calls = [];
    const bot = preparedBot(memoryDb(), calls);

    await bot.handleUpdate(messageUpdate(MENU_LABELS.buy));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, helpMessage());
    assert.equal(calls[0].reply_markup.inline_keyboard[0][0].web_app.url, "https://frontend.example.com/app");
  });
});

test("Web App routes preserve a configured base path and unsafe URLs are rejected", async () => {
  await withBotEnvironment(async () => {
    assert.equal(webAppUrl(), "https://frontend.example.com/app");
    assert.equal(webAppUrl("tickets"), "https://frontend.example.com/app/tickets");
    assert.equal(webAppUrl("/draw/"), "https://frontend.example.com/app/draw");

    process.env.WEB_APP_URL = "javascript:alert(1)";
    assert.throws(() => webAppUrl(), /HTTP\(S\)/);
    process.env.WEB_APP_URL = "http://frontend.example.com";
    assert.throws(() => webAppUrl(), /HTTPS/);
  });
});

test("frontend URL falls back to FRONTEND_URL", async () => {
  await withBotEnvironment(async () => {
    delete process.env.WEB_APP_URL;
    process.env.FRONTEND_URL = "https://frontend.example.com";
    assert.equal(webAppUrl(), "https://frontend.example.com/");
  });
});

test("support URL is optional and requires HTTPS when configured", async () => {
  await withBotEnvironment(async () => {
    assert.equal(supportUrl(), null);
    process.env.SUPPORT_URL = "https://t.me/mgnot_support";
    assert.equal(supportUrl(), "https://t.me/mgnot_support");
    process.env.SUPPORT_URL = "tg://resolve?domain=mgnot_support";
    assert.throws(() => supportUrl(), /HTTP\(S\)/);
  });
});

test("ticket lookup derives status without exposing another user's purchases", async () => {
  const db = raffleDb([
    {
      id: "phone",
      itemName: "Phone",
      status: "open",
      purchases: [
        { userId: "42", status: "assigned", ticketNumber: 7, createdAt: "2026-08-02" },
        { userId: "99", status: "assigned", ticketNumber: 8, createdAt: "2026-08-03" },
      ],
    },
    {
      id: "laptop",
      itemName: "Laptop",
      status: "completed",
      winningNumber: 11,
      purchases: [{ userId: "42", status: "assigned", ticketNumber: 11, createdAt: "2026-08-01" }],
    },
    {
      id: "tv",
      itemName: "TV",
      status: "open",
      purchases: [{ userId: "42", status: "pending_number", createdAt: "2026-07-31" }],
    },
  ]);

  const purchases = await loadUserTickets(db, 42);
  const text = ticketsMessage(purchases);
  assert.equal(purchases.length, 3);
  assert.match(text, /Phone[\s\S]*#7[\s\S]*Active/);
  assert.match(text, /Laptop[\s\S]*🏆 Winner/);
  assert.match(text, /TV[\s\S]*Choose a number/);
  assert.doesNotMatch(text, /#8/);
  assert.match(ticketsMessage([]), /You do not have any tickets yet/);
});

test("ticket keyboard button and /tickets command use the same handler", async () => {
  await withBotEnvironment(async () => {
    const db = raffleDb([{
      id: "phone",
      itemName: "Phone",
      status: "open",
      purchases: [{ userId: "42", status: "assigned", ticketNumber: 7 }],
    }]);
    const calls = [];
    const bot = preparedBot(db, calls);

    await bot.handleUpdate(messageUpdate(MENU_LABELS.tickets, 1));
    await bot.handleUpdate(messageUpdate("/tickets", 2));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].text, calls[1].text);
    assert.equal(calls[0].reply_markup.inline_keyboard[0][0].web_app.url, "https://frontend.example.com/app/tickets");
  });
});

test("draw and help keyboard buttons match their commands and Help includes support", async () => {
  await withBotEnvironment(async () => {
    process.env.SUPPORT_URL = "https://t.me/mgnot_support";
    const db = raffleDb([{
      id: "phone",
      itemName: "Phone",
      status: "completed",
      winningNumber: 7,
      winner: { displayName: "Demo Winner" },
      drawnAt: "2026-08-01T12:00:00Z",
    }]);
    const calls = [];
    const bot = preparedBot(db, calls);

    await bot.handleUpdate(messageUpdate(MENU_LABELS.draws, 1));
    await bot.handleUpdate(messageUpdate("/draws", 2));
    await bot.handleUpdate(messageUpdate(MENU_LABELS.help, 3));
    await bot.handleUpdate(messageUpdate("/help", 4));

    assert.equal(calls.length, 4);
    assert.equal(calls[0].text, calls[1].text);
    assert.equal(calls[0].reply_markup.inline_keyboard[0][0].web_app.url, "https://frontend.example.com/app/draw");
    assert.equal(calls[2].text, calls[3].text);
    assert.equal(calls[2].reply_markup.inline_keyboard[1][0].url, "https://t.me/mgnot_support");
  });
});

test("draw summary sorts the upcoming draw and limits recent winners", async () => {
  const db = raffleDb([
    { id: "later", itemName: "Later", status: "open", drawAt: "2026-08-04T12:00:00Z" },
    { id: "next", itemName: "Next", status: "sold_out", drawAt: "2026-08-03T12:00:00Z" },
    ...[1, 2, 3, 4].map((number) => ({
      id: `winner-${number}`,
      itemName: `Prize ${number}`,
      status: "completed",
      winningNumber: number,
      winner: { displayName: `Winner ${number}`, phone: `+25190000000${number}` },
      drawnAt: `2026-07-${20 + number}T12:00:00Z`,
    })),
  ]);

  const summary = await loadDraws(db);
  const text = drawsMessage(summary);
  assert.equal(summary.upcoming.id, "next");
  assert.deepEqual(summary.winners.map((winner) => winner.id), ["winner-4", "winner-3", "winner-2"]);
  assert.match(text, /Next/);
  assert.match(text, /Prize 4: #4 — Winner 4/);
  assert.doesNotMatch(text, /251900000004/);
  assert.doesNotMatch(text, /Prize 1/);
});

test("draw and ticket empty states are bilingual", () => {
  assert.match(drawsMessage({ upcoming: null, winners: [] }), /No upcoming draw right now/);
  assert.match(drawsMessage({ upcoming: null, winners: [] }), /ገና የተጠናቀቀ ዕጣ የለም/);
  assert.match(ticketsMessage([]), /እስካሁን ምንም ትኬት የለዎትም/);
  assert.match(helpMessage(), /ትክክለኛ የትኬት ዋጋ/);
  assert.match(helpMessage(), /አጋር ሱቅ/);
  assert.match(helpMessage(), /Your trust matters to us/);
});

test("account-specific commands reject group chats", async () => {
  await withBotEnvironment(async () => {
    const calls = [];
    const bot = preparedBot({ collection: () => { throw new Error("must not query"); } }, calls);
    await bot.handleUpdate(messageUpdate("/tickets", 1, "group"));
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /private chat/);
  });
});

test("ticket database failures return a safe retry message", async () => {
  await withBotEnvironment(async () => {
    const calls = [];
    const bot = preparedBot({
      collection() {
        return { get: async () => { throw new Error("database password leaked"); } };
      },
    }, calls);
    await bot.handleUpdate(messageUpdate("/tickets"));
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /Could not load your tickets/);
    assert.doesNotMatch(calls[0].text, /password/);
  });
});

test("winner notifications obscure the final two phone digits", () => {
  assert.equal(maskPhone("+251 91 234 5678"), "+251 91 234 56••");
  assert.equal(maskPhone("12"), "••");
  assert.equal(maskPhone(""), "Not provided");
});
