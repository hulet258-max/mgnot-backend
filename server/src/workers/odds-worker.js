const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "config", ".env") });

const db = require("../config/postgres");
const { connectRedis, closeRedisClients } = require("../config/redis");
const { ensurePoolsSeeded } = require("../api/pools");
const {
  ensureTournamentDataSeeded,
  startMatchOddsEngine,
} = require("../api/tournamentData");

async function startWorker() {
  try {
    await connectRedis();
    await db.init();
    await ensurePoolsSeeded();
    await ensureTournamentDataSeeded();
    startMatchOddsEngine();
    console.log("Odds worker started.");

    const shutdown = async (signal) => {
      console.log(`Received ${signal}; closing odds worker.`);
      await closeRedisClients();
      await db.close();
      process.exit(0);
    };

    process.once("SIGINT", () => shutdown("SIGINT").catch(console.error));
    process.once("SIGTERM", () => shutdown("SIGTERM").catch(console.error));
  } catch (error) {
    console.error("Odds worker startup error:", error);
    await closeRedisClients().catch(() => {});
    process.exit(1);
  }
}

startWorker();
