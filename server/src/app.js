const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "config", ".env") });
require("dotenv").config({ path: path.join(__dirname, "bot", ".env") });

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");

const db = require("./config/postgres");
const {
  redis,
  connectRedis,
  createSocketAdapterClients,
  closeRedisClients,
} = require("./config/redis");
const { removeSocketPresence, setSocketPresence } = require("./realtime/presence");
const { uploadsRoot } = require("./config/uploads");

const userRoutes = require("./routes/user/user");
const { router: raffleRoutes } = require("./api/raffles");
const adminRaffleRoutes = require("./api/adminRaffles");
const screenshotRecRoutes = require("./api/screenshotrec");

const app = express();
const PORT = process.env.PORT || 8000;
let socketAdapterClients = [];

const allowedOrigins = [
  process.env.CORS_ORIGIN,
  process.env.WEB_APP_URL,
  process.env.FRONTEND_URL,
]
  .filter(Boolean)
  .join(",")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

console.log("Allowed frontend origins:", allowedOrigins.length ? allowedOrigins : "any");

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
}));
app.use(express.json({ limit: "2mb" }));

app.use("/uploads", express.static(uploadsRoot, {
  maxAge: "7d",
  fallthrough: true,
  immutable: true,
}));

app.use("/api", userRoutes);
app.use("/api", raffleRoutes);
app.use("/api/admin", adminRaffleRoutes);
app.use("/api", screenshotRecRoutes);

app.get("/health", async (req, res) => {
  try {
    if (
      socketAdapterClients.length !== 2 ||
      socketAdapterClients.some((client) => !client.isReady)
    ) {
      throw new Error("Socket.IO Redis adapter is not ready.");
    }

    await Promise.all([
      db.query("SELECT 1"),
      redis.ping(),
      socketAdapterClients[0].ping(),
    ]);
    res.json({
      status: "ok",
      postgres: "connected",
      redis: "connected",
      time: new Date(),
    });
  } catch (err) {
    console.error("Health check error:", err);
    res.status(500).json({
      status: "error",
      postgres: "unknown",
      redis: redis.isOpen ? "error" : "disconnected",
      error: err.message,
    });
  }
});

async function startApp() {
  let server;
  let io;

  try {
    await connectRedis();
    await db.init();

    server = http.createServer(app);
    io = new Server(server, {
      cors: {
        origin: allowedOrigins.length ? allowedOrigins : "*",
        methods: ["GET", "POST"],
      },
    });

    const { pubClient, subClient } = await createSocketAdapterClients();
    socketAdapterClients = [pubClient, subClient];
    io.adapter(createAdapter(pubClient, subClient));
    app.set("io", io);

    io.on("connection", (socket) => {
      console.log("New client connected:", socket.id);
      // A client may have missed broadcasts while it was offline. Tell every
      // newly connected/reconnected frontend to reconcile its API-backed state.
      socket.emit("sync_required", {
        reason: "connected",
        at: new Date().toISOString(),
      });

      socket.on("auth_user", async (telegramId) => {
        if (!telegramId) return;

        try {
          await setSocketPresence(telegramId, socket.id);
          console.log(`Saved socket mapping for user ${telegramId}.`);
        } catch (error) {
          console.error("Redis presence error:", error);
        }
      });

      socket.on("disconnect", async () => {
        console.log("Client disconnected:", socket.id);
        try {
          await removeSocketPresence(socket.id);
        } catch (error) {
          console.error("Redis presence cleanup error:", error);
        }
      });
    });

    server.listen(PORT, () => {
      console.log(`Backend API + Socket.IO listening on port ${PORT}`);
    });

    const shutdown = async (signal) => {
      console.log(`Received ${signal}; closing backend API.`);
      if (io) io.close();
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await closeRedisClients(socketAdapterClients);
      await db.close();
      process.exit(0);
    };

    process.once("SIGINT", () => shutdown("SIGINT").catch(console.error));
    process.once("SIGTERM", () => shutdown("SIGTERM").catch(console.error));
  } catch (err) {
    console.error("Application startup error:", err);
    await closeRedisClients(socketAdapterClients).catch(() => {});
    process.exit(1);
  }
}

startApp();
