const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "src", "config", ".env") });

const db = require("../src/config/postgres");
const { redis, connectRedis } = require("../src/config/redis");

const CONFIRMATION_FLAG = "--confirm-reset";
const APP_KEY_PATTERNS = [
  "raffle:*",
  "raffles:*",
  "pool:*",
  "pools:*",
  "room:*",
  "rooms:*",
  "presence:*",
];

async function deleteRedisApplicationKeys() {
  await connectRedis();
  let deleted = 0;

  for (const pattern of APP_KEY_PATTERNS) {
    const keys = [];
    for await (const entry of redis.scanIterator({ MATCH: pattern, COUNT: 250 })) {
      const scannedKeys = Array.isArray(entry) ? entry : [entry];
      keys.push(...scannedKeys);
      if (keys.length >= 250) {
        deleted += await redis.del(keys.splice(0, keys.length));
      }
    }
    if (keys.length) deleted += await redis.del(keys);
  }

  return deleted;
}

async function main() {
  if (!process.argv.includes(CONFIRMATION_FLAG)) {
    throw new Error(`Refusing to reset data without ${CONFIRMATION_FLAG}.`);
  }

  await db.init();
  const targetResult = await db.query(`
    SELECT
      current_database() AS database,
      current_user AS "user",
      COALESCE(inet_server_addr()::text, 'local') AS host
  `);
  const target = targetResult.rows[0];
  if (target?.database !== db.REQUIRED_DATABASE) {
    throw new Error(
      `Refusing to reset PostgreSQL database "${target?.database || "unknown"}"; expected "${db.REQUIRED_DATABASE}".`
    );
  }
  const beforeResult = await db.query(`
    SELECT split_part(collection_path, '/', 1) AS collection, COUNT(*)::int AS documents
    FROM app_documents
    GROUP BY 1
    ORDER BY 1
  `);

  await db.query("TRUNCATE TABLE app_documents");
  const redisKeysDeleted = await deleteRedisApplicationKeys();

  console.log(JSON.stringify({
    target,
    removedCollections: beforeResult.rows,
    redisKeysDeleted,
    remainingDocuments: 0,
  }, null, 2));
}

main()
  .then(async () => {
    if (redis.isOpen) await redis.quit();
    await db.close();
  })
  .catch(async (error) => {
    console.error(error.message);
    if (redis.isOpen) await redis.quit().catch(() => {});
    await db.close().catch(() => {});
    process.exit(1);
  });
