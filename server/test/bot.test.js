const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createBot,
  registerTelegramUser,
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
              stored = options?.merge
                ? { ...(stored || {}), ...data }
                : { ...data };
            },
          };
        },
      };
    },
    read: () => stored,
  };
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

test("/start welcome includes the configured frontend as a Web App button", async () => {
  const previousToken = process.env.BOT_TOKEN;
  const previousWebAppUrl = process.env.WEB_APP_URL;
  process.env.BOT_TOKEN = "test-token";
  process.env.WEB_APP_URL = "https://frontend.example.com/app";

  try {
    const bot = createBot(memoryDb());
    bot.botInfo = {
      id: 1,
      is_bot: true,
      first_name: "MGNOT",
      username: "mgnot_test_bot",
    };

    const calls = [];
    bot.context.telegram = {
      sendMessage: async (chatId, text, payload) => {
        calls.push({ method: "sendMessage", payload: { chatId, text, ...payload } });
        return { message_id: 1 };
      },
    };

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Demo" },
        text: "/start",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    });

    const welcome = calls.find((call) => call.method === "sendMessage");
    assert.ok(welcome);
    assert.match(welcome.payload.text, /^Welcome, Demo!/);
    assert.equal(
      welcome.payload.reply_markup.inline_keyboard[0][0].web_app.url,
      "https://frontend.example.com/app"
    );
  } finally {
    if (previousToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = previousToken;
    if (previousWebAppUrl === undefined) delete process.env.WEB_APP_URL;
    else process.env.WEB_APP_URL = previousWebAppUrl;
  }
});

test("frontend URL falls back to FRONTEND_URL and rejects non-HTTP links", () => {
  const previousWebAppUrl = process.env.WEB_APP_URL;
  const previousFrontendUrl = process.env.FRONTEND_URL;

  try {
    delete process.env.WEB_APP_URL;
    process.env.FRONTEND_URL = "https://frontend.example.com";
    assert.equal(webAppUrl(), "https://frontend.example.com/");

    process.env.FRONTEND_URL = "javascript:alert(1)";
    assert.throws(() => webAppUrl(), /HTTP\(S\)/);

    process.env.FRONTEND_URL = "http://frontend.example.com";
    assert.throws(() => webAppUrl(), /HTTPS/);

    process.env.FRONTEND_URL = "http://localhost:3001";
    assert.throws(() => webAppUrl(), /HTTPS/);
  } finally {
    if (previousWebAppUrl === undefined) delete process.env.WEB_APP_URL;
    else process.env.WEB_APP_URL = previousWebAppUrl;
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontendUrl;
  }
});

test("winner notifications obscure the final two phone digits", () => {
  assert.equal(maskPhone("+251 91 234 5678"), "+251 91 234 56••");
  assert.equal(maskPhone("12"), "••");
  assert.equal(maskPhone(""), "Not provided");
});
