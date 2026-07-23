const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "config", ".env") });
require("dotenv").config({ path: path.join(__dirname, "..", "bot", ".env") });

const db = require("../config/postgres");
const { createBot, startBot } = require("../bot/bot");

async function startWorker() {
  try {
    await db.init();

    const bot = createBot(db);
    const shutdown = async (signal) => {
      console.log(`Received ${signal}; closing Telegram bot worker.`);
      bot.stop(signal);
      await db.close();
      process.exit(0);
    };

    process.once("SIGINT", () => shutdown("SIGINT").catch(console.error));
    process.once("SIGTERM", () => shutdown("SIGTERM").catch(console.error));

    const { launchPromise } = await startBot(bot);
    await launchPromise;
  } catch (error) {
    console.error("Telegram bot worker startup error:", error);
    process.exit(1);
  }
}

startWorker();
