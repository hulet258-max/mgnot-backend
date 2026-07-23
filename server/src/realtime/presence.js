const { redis } = require("../config/redis");

const userSocketKey = (userId) => `presence:user:${String(userId)}`;
const socketUserKey = (socketId) => `presence:socket:${String(socketId)}`;

async function setSocketPresence(userId, socketId) {
  if (!userId || !socketId || !redis.isOpen) return;

  const previousSocketId = await redis.get(userSocketKey(userId));
  const operations = [
    redis.set(userSocketKey(userId), String(socketId)),
    redis.set(socketUserKey(socketId), String(userId)),
  ];

  if (previousSocketId && previousSocketId !== String(socketId)) {
    operations.push(redis.del(socketUserKey(previousSocketId)));
  }

  await Promise.all(operations);
}

async function getSocketForUser(userId) {
  if (!userId || !redis.isOpen) return null;
  return redis.get(userSocketKey(userId));
}

async function getUserForSocket(socketId) {
  if (!socketId || !redis.isOpen) return null;
  return redis.get(socketUserKey(socketId));
}

async function removeSocketPresence(socketId) {
  if (!socketId || !redis.isOpen) return;

  const userId = await getUserForSocket(socketId);
  if (!userId) return;

  const currentSocketId = await getSocketForUser(userId);
  const operations = [redis.del(socketUserKey(socketId))];
  if (currentSocketId === String(socketId)) {
    operations.push(redis.del(userSocketKey(userId)));
  }
  await Promise.all(operations);
}

module.exports = {
  getSocketForUser,
  getUserForSocket,
  removeSocketPresence,
  setSocketPresence,
};
