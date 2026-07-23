// server/src/bot/bot.js

const { Telegraf } = require('telegraf');

function webAppUrl() {
  const configuredUrl = String(
    process.env.WEB_APP_URL || process.env.FRONTEND_URL || ''
  ).trim();

  if (!configuredUrl) {
    throw new Error('WEB_APP_URL (or FRONTEND_URL) missing in env');
  }

  const parsedUrl = new URL(configuredUrl);
  if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
    throw new Error('WEB_APP_URL must be an HTTP(S) URL');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('WEB_APP_URL must use HTTPS for Telegram Web Apps');
  }

  return parsedUrl.toString();
}

async function registerTelegramUser(db, from) {
  if (!from?.id) {
    throw new Error('Telegram user ID missing from /start update');
  }

  const userRef = db.collection('users').doc(String(from.id));
  const userDoc = await userRef.get();
  const profile = {
    telegramId: from.id,
    username: from.username || '',
    firstName: from.first_name || '',
    lastName: from.last_name || '',
    lastSeen: new Date()
  };

  if (!userDoc.exists) {
    Object.assign(profile, {
      phone: '',
      balance: 0,
      roomIn: null,
      depositSum: 0,
      createdAt: new Date()
    });
  }

  await userRef.set(profile, { merge: true });
  return { isNewUser: !userDoc.exists, user: profile };
}

/**
 * Create and configure Telegram bot
 */
function createBot(db) {
  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN missing in env');
  }
  webAppUrl();

  const bot = new Telegraf(process.env.BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      await registerTelegramUser(db, ctx.from);
      const firstName = ctx.from?.first_name ? `, ${ctx.from.first_name}` : '';

      await ctx.reply(`Welcome${firstName}! 👋\nTap below to open MGNOT.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Open MGNOT', web_app: { url: webAppUrl() } }]
          ]
        }
      });
    } catch (err) {
      console.error('Bot /start error:', err);
      await ctx.reply(
        'We could not open MGNOT right now. Please try /start again shortly.'
      );
    }
  });

  // contact handler
  bot.on('contact', async (ctx) => {
    try {

      const contact = ctx.message.contact;

      // verify ownership
      if (contact.user_id !== ctx.from.id) {
        return ctx.reply(' Please share your own number.');
      }

      const userRef = db.collection('users').doc(String(ctx.from.id));
      const userDoc = await userRef.get();

      let userData;

      if (!userDoc.exists) {

        // FIRST TIME USER
        userData = {
          telegramId: ctx.from.id,
          phone: contact.phone_number,
          username: ctx.from.username || '',
          firstName: ctx.from.first_name || '',
          lastName: ctx.from.last_name || '',

          // NEW GAME FIELDS
          balance: 0,
          roomIn: null,
          depositSum: 0,

          createdAt: new Date(),
          lastSeen: new Date()
        };

      } else {

        // EXISTING USER
        userData = {
          phone: contact.phone_number,
          username: ctx.from.username || '',
          firstName: ctx.from.first_name || '',
          lastName: ctx.from.last_name || '',
          lastSeen: new Date()
        };

      }

      await userRef.set(userData, { merge: true });


      const configuredWebAppUrl = webAppUrl();

      await ctx.reply(' Registration complete.', {
        reply_markup: { remove_keyboard: true }
      });

      await ctx.reply(' Open the Web App', {
        reply_markup: {
          inline_keyboard: [
            [{ text: ' Open Web App', web_app: { url: configuredWebAppUrl } }]
          ]
        }
      });

    } catch (err) {

      console.error('Bot contact error:', err);

      ctx.reply(' Failed to save your data.');

    }
  });

  bot.action('withdraw_sent', async (ctx) => {
    try {
      await ctx.answerCbQuery('Marked as done');
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [{ text: 'Done', callback_data: 'withdraw_done' }]
        ]
      });
    } catch (err) {
      console.error('Withdraw button callback error:', err);
    }
  });

  bot.action('withdraw_done', async (ctx) => {
    await ctx.answerCbQuery('Already done');
  });

  return bot;
}

/**
 * Start bot safely
 */
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

  console.log(`Telegram bot @${bot.botInfo.username} started.`);
  return { launchPromise };
}

module.exports = {
  createBot,
  registerTelegramUser,
  startBot,
  webAppUrl
};
