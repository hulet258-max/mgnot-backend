const { createClient } = require("redis");

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redisPassword = process.env.REDIS_PASSWORD;

const redisOptions = {
  url: redisUrl,
};

if (redisPassword) {
  redisOptions.password = redisPassword;
}

const createRedisClient = (name) => {
  const client = createClient(redisOptions);
  client.on("error", (err) => {
    console.error(`Redis ${name} error:`, err);
  });
  return client;
};

const redis = createRedisClient("application");

async function connectRedis() {
  if (!redis.isOpen) {
    await redis.connect();
    const parsedUrl = new URL(redisUrl);
    console.log(`Redis connected to ${parsedUrl.hostname}:${parsedUrl.port || 6379}`);
  }
}

async function createSocketAdapterClients() {
  const pubClient = createRedisClient("socket-publisher");
  const subClient = createRedisClient("socket-subscriber");
  await Promise.all([pubClient.connect(), subClient.connect()]);
  return { pubClient, subClient };
}

async function closeRedisClients(clients = []) {
  const allClients = [redis, ...clients];
  await Promise.all(allClients.map(async (client) => {
    if (client && client.isOpen) {
      await client.quit();
    }
  }));
}

module.exports = {
  redis,
  connectRedis,
  createSocketAdapterClients,
  closeRedisClients,
};
