const express = require("express");
const db = require("../config/postgres");
const { redis } = require("../config/redis");
const { DEFAULT_POOLS } = require("../data/pools");
const { groups, matchDays } = require("../data/tournament");
const { verifyPayment } = require("./receiptService");

const router = express.Router();

const POOLS_CACHE_KEY = "pools:list";
const SHOULD_SEED_DEFAULT_POOLS = process.env.SEED_DEFAULT_POOLS === "true";
const poolCacheKey = (poolId) => `pool:${poolId}`;
const predictionsCacheKey = (poolId, userId) => `pool:${poolId}:predictions:${userId}`;
const leaderboardCacheKey = (poolId) => `pool:${poolId}:leaderboard`;

const normalizePool = (pool) => ({
  id: pool.id,
  amount: Number(pool.amount || 0),
  prize: Number(pool.prize || 0),
  capacity: Number(pool.capacity || 0),
  status: pool.status || "Open",
  rules: Array.isArray(pool.rules) ? pool.rules : [],
  progression: pool.progression || "",
  points: pool.points || "",
  rewards: pool.rewards || "",
  participants: Number(pool.participants || 0),
  joinedUsers: Number(pool.joinedUsers || 0),
  joinedUserIds: Array.isArray(pool.joinedUserIds) ? pool.joinedUserIds : [],
  joinedUserPoolKeys: Array.isArray(pool.joinedUserPoolKeys) ? pool.joinedUserPoolKeys : [],
  createdAt: pool.createdAt || null,
  updatedAt: pool.updatedAt || null,
});

function extractTransactionId(serviceResponse) {
  const sources = [
    serviceResponse,
    serviceResponse?.data,
    serviceResponse?.result,
    serviceResponse?.receipt,
  ];

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    const candidate = source.transactionId
      || source.transaction_id
      || source.txId
      || source.tx_id
      || source.trxId
      || source.trx_id
      || source.reference
      || source.receiptId;

    if (candidate && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }

  return null;
}

function extractReceiptCode(input) {
  if (!input) return null;
  const normalizedInput = String(input).trim();
  const urlMatch = normalizedInput.match(/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Z0-9]{10}$/.test(normalizedInput)) return normalizedInput;
  return null;
}

function extractAmount(serviceResponse, expectedAmount) {
  const sources = [
    serviceResponse,
    serviceResponse?.data,
    serviceResponse?.result,
    serviceResponse?.receipt,
  ];

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    const parsed = Number(source.amount || source.paidAmount || source.verifiedAmount || source.totalAmount);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const fallback = Number(expectedAmount);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

const computePredictionSummary = (groupPredictionsLocked, matchPredictions) => {
  const matchCount = Object.keys(matchPredictions || {}).length;
  const points = Object.values(matchPredictions || {}).reduce((sum, prediction) => {
    return sum + Number(prediction?.pointsEarned || 0);
  }, 0);

  return {
    matchCount,
    points,
  };
};

const invalidatePoolCache = async (poolId, userId) => {
  if (!redis.isOpen) return;
  const keys = [POOLS_CACHE_KEY, poolCacheKey(poolId), leaderboardCacheKey(poolId)];
  if (userId) {
    keys.push(predictionsCacheKey(poolId, userId));
  }
  await redis.del(keys);
};

const ensurePoolsSeeded = async () => {
  if (!SHOULD_SEED_DEFAULT_POOLS) return;
  const poolRefs = DEFAULT_POOLS.map((pool) => db.collection("pools").doc(pool.id));
  const poolDocs = await Promise.all(poolRefs.map((ref) => ref.get()));

  const batch = db.batch();
  let hasWrites = false;

  poolDocs.forEach((docSnap, index) => {
    if (docSnap.exists) return;

    const pool = normalizePool(DEFAULT_POOLS[index]);
    batch.set(poolRefs[index], {
      ...pool,
      participants: 0,
      joinedUsers: 0,
      createdAt: db.FieldValue.serverTimestamp(),
      updatedAt: db.FieldValue.serverTimestamp(),
    });
    hasWrites = true;
  });

  if (hasWrites) {
    await batch.commit();
    if (redis.isOpen) {
      await redis.del(POOLS_CACHE_KEY);
    }
  }
};

const getPoolsList = async () => {
  if (redis.isOpen) {
    const cached = await redis.get(POOLS_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  }

  const snapshot = await db.collection("pools").get();
  const pools = snapshot.docs
    .map((doc) => normalizePool({ id: doc.id, ...doc.data() }))
    .sort((a, b) => a.amount - b.amount);

  if (redis.isOpen) {
    await redis.set(POOLS_CACHE_KEY, JSON.stringify(pools), { EX: 60 });
  }

  return pools;
};

const getPoolById = async (poolId) => {
  if (redis.isOpen) {
    const cached = await redis.get(poolCacheKey(poolId));
    if (cached) return JSON.parse(cached);
  }

  const poolDoc = await db.collection("pools").doc(String(poolId)).get();
  if (!poolDoc.exists) return null;

  const pool = normalizePool({ id: poolDoc.id, ...poolDoc.data() });

  if (redis.isOpen) {
    await redis.set(poolCacheKey(poolId), JSON.stringify(pool), { EX: 60 });
  }

  return pool;
};

const getPredictionDocRef = (poolId, userId) => {
  return db
    .collection("pools")
    .doc(String(poolId))
    .collection("predictions")
    .doc(String(userId));
};

const getMemberDocRef = (poolId, userId) => {
  return db
    .collection("pools")
    .doc(String(poolId))
    .collection("members")
    .doc(String(userId));
};

const getAllGroupIds = () => groups.map((group) => group.id);

const normalizeLockedGroupIds = (predictionDoc = {}) => {
  const lockedGroupIds = new Set(
    Array.isArray(predictionDoc.lockedGroupIds)
      ? predictionDoc.lockedGroupIds.map((groupId) => String(groupId))
      : []
  );

  if (predictionDoc.groupPredictionsLocked) {
    getAllGroupIds().forEach((groupId) => lockedGroupIds.add(groupId));
  }

  return [...lockedGroupIds];
};

const normalizeSavedGroupIds = (predictionDoc = {}) => {
  const savedGroupIds = new Set(
    Array.isArray(predictionDoc.savedGroupIds)
      ? predictionDoc.savedGroupIds.map((groupId) => String(groupId))
      : []
  );

  normalizeLockedGroupIds(predictionDoc).forEach((groupId) => savedGroupIds.add(groupId));

  if (!predictionDoc.savedGroupIds && predictionDoc.groupPredictions && typeof predictionDoc.groupPredictions === "object") {
    Object.keys(predictionDoc.groupPredictions).forEach((groupId) => savedGroupIds.add(groupId));
  }

  return [...savedGroupIds];
};

const isGroupLocked = (predictionDoc = {}, groupId) => {
  return Boolean(predictionDoc.groupPredictionsLocked) || normalizeLockedGroupIds(predictionDoc).includes(String(groupId));
};

const assertGroupExists = (groupId) => groups.some((group) => group.id === groupId);

const getGroupPointEngine = async () => {
  const doc = await db.collection("engines").doc("group-points").get();
  return doc.exists ? doc.data()?.points || {} : {};
};

const calculateGroupPossiblePoints = (groupId, order = [], pointEngine = {}) => {
  const group = groups.find((item) => item.id === groupId);
  const teams = Array.isArray(order) ? order.slice(0, 2) : [];
  const teamPoints = teams.map((teamId) => {
    const team = group?.teams.find((item) => item.id === teamId);
    const points = Number(pointEngine[groupId]?.teams?.[teamId]?.points || 3);
    return {
      teamId,
      teamName: team?.name || teamId,
      points,
    };
  });

  return {
    groupId,
    points: teamPoints.reduce((sum, item) => sum + item.points, 0),
    teams: teamPoints,
  };
};

const calculateAllGroupPossiblePoints = (groupPredictions = {}, pointEngine = {}) => {
  return groups.reduce((acc, group) => {
    acc[group.id] = calculateGroupPossiblePoints(group.id, groupPredictions[group.id] || [], pointEngine);
    return acc;
  }, {});
};

const sumGroupPossiblePoints = (groupPossiblePoints = {}) => {
  return Object.values(groupPossiblePoints).reduce((sum, item) => sum + Number(item?.points || 0), 0);
};

const findMatchById = (matchId) => {
  for (const day of matchDays) {
    const match = day.matches.find((item) => item.id === matchId);
    if (match) return match;
  }

  return null;
};

const isMatchPredictionEditable = (match) => {
  if (!match || match.status !== "open") return false;
  const editLockTime = new Date(match.kickoff).getTime() - (5 * 60 * 1000);
  return Date.now() < editLockTime;
};

const getMatchPossiblePoints = async (matchId, outcome) => {
  if (!outcome) return 0;
  const oddsDoc = await db.collection("engines").doc("match-odds").get();
  const odds = oddsDoc.exists ? oddsDoc.data()?.odds || {} : {};
  return Number(odds[matchId]?.[outcome]?.points || 0);
};

const includeMatchPossiblePoints = async (predictionDoc = {}) => {
  const matchPredictions = predictionDoc.matchPredictions || {};
  const missingPoints = Object.values(matchPredictions).some((prediction) => prediction.possiblePoints === undefined);
  if (!missingPoints) return predictionDoc;

  const oddsDoc = await db.collection("engines").doc("match-odds").get();
  const odds = oddsDoc.exists ? oddsDoc.data()?.odds || {} : {};
  const enrichedMatchPredictions = Object.entries(matchPredictions).reduce((acc, [matchId, prediction]) => {
    acc[matchId] = {
      ...prediction,
      possiblePoints: prediction.possiblePoints === undefined
        ? Number(odds[matchId]?.[prediction.outcome]?.points || 0)
        : prediction.possiblePoints,
    };
    return acc;
  }, {});

  return {
    ...predictionDoc,
    matchPredictions: enrichedMatchPredictions,
  };
};

const broadcastPoolUpdate = (req, poolId, {
  userId = null,
  reason = "updated",
  joined,
} = {}) => {
  const io = req.app.get("io");
  if (!io) return;
  const payload = {
    poolId: String(poolId),
    reason,
    at: new Date().toISOString(),
  };
  if (userId !== null && userId !== undefined) payload.userId = String(userId);
  if (joined !== undefined) payload.joined = Boolean(joined);
  io.emit("pool_updated", payload);
};

const joinPoolTransaction = async ({ poolId, userId, skipBalanceCheck = false, payment = null }) => {
  const poolRef = db.collection("pools").doc(poolId);
  const userRef = db.collection("users").doc(String(userId));
  const memberRef = getMemberDocRef(poolId, userId);
  let joinResult = { alreadyMember: false, pool: null };

  await db.runTransaction(async (tx) => {
    const [poolDoc, userDoc, memberDoc] = await Promise.all([
      tx.get(poolRef),
      tx.get(userRef),
      tx.get(memberRef),
    ]);

    if (!poolDoc.exists) throw new Error("POOL_NOT_FOUND");
    if (!userDoc.exists) throw new Error("USER_NOT_FOUND");

    const pool = normalizePool({ id: poolDoc.id, ...poolDoc.data() });
    const userData = userDoc.data() || {};

    if (memberDoc.exists) {
      joinResult.alreadyMember = true;
      joinResult.pool = pool;
      return;
    }

    if (pool.participants >= pool.capacity) throw new Error("POOL_FULL");

    const balance = Number(userData.balance || 0);
    if (!skipBalanceCheck && balance < pool.amount) throw new Error("INSUFFICIENT_BALANCE");

    const displayName = [userData.firstName, userData.lastName].filter(Boolean).join(" ").trim();
    const memberPayload = {
      userId: String(userId),
      poolId,
      userPoolKey: `${userId}:${poolId}`,
      username: userData.username || null,
      displayName: displayName || userData.username || "Telegram Player",
      photo: userData.photo || null,
      joinedAt: db.FieldValue.serverTimestamp(),
    };

    if (payment) {
      memberPayload.payment = payment;
    }

    tx.set(memberRef, memberPayload);

    tx.update(userRef, {
      ...(skipBalanceCheck ? {} : { balance: db.FieldValue.increment(-pool.amount) }),
      activePoolId: poolId,
      joinedPoolIds: db.FieldValue.arrayUnion(poolId),
      activePoolJoinedAt: db.FieldValue.serverTimestamp(),
    });

    tx.update(poolRef, {
      participants: db.FieldValue.increment(1),
      joinedUsers: db.FieldValue.increment(1),
      joinedUserIds: db.FieldValue.arrayUnion(String(userId)),
      joinedUserPoolKeys: db.FieldValue.arrayUnion(`${userId}:${poolId}`),
      updatedAt: db.FieldValue.serverTimestamp(),
    });

    joinResult.pool = pool;
  });

  await invalidatePoolCache(poolId, userId);
  return joinResult;
};

router.get("/pools", async (req, res) => {
  try {
    await ensurePoolsSeeded();
    const pools = await getPoolsList();
    return res.json({ success: true, pools });
  } catch (error) {
    console.error("/api/pools error:", error);
    return res.status(500).json({ success: false, error: "Failed to load pools." });
  }
});

router.get("/pools/:poolId", async (req, res) => {
  try {
    const pool = await getPoolById(req.params.poolId);
    if (!pool) {
      return res.status(404).json({ success: false, error: "Pool not found." });
    }

    return res.json({ success: true, pool });
  } catch (error) {
    console.error("/api/pools/:poolId error:", error);
    return res.status(500).json({ success: false, error: "Failed to load pool." });
  }
});

router.get("/user-pool", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, error: "userId is required." });
    }

    const userDoc = await db.collection("users").doc(String(userId)).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    const userData = userDoc.data() || {};
    const joinedPoolIds = Array.isArray(userData.joinedPoolIds) ? [...userData.joinedPoolIds] : [];
    const pools = await getPoolsList();
    const joinedPools = [];

    for (const pool of pools) {
      const memberDoc = await getMemberDocRef(pool.id, userId).get();
      if (memberDoc.exists) {
        const memberData = memberDoc.data() || {};
        joinedPools.push({
          poolId: pool.id,
          joinedAt: memberData.joinedAt || null,
        });
        if (!joinedPoolIds.includes(pool.id)) {
          joinedPoolIds.push(pool.id);
        }
      }
    }

    return res.json({
      success: true,
      poolId: userData.activePoolId || null,
      joinedAt: userData.activePoolJoinedAt || null,
      joinedPoolIds,
      joinedPools,
    });
  } catch (error) {
    console.error("/api/user-pool error:", error);
    return res.status(500).json({ success: false, error: "Failed to load user pool." });
  }
});

router.post("/pools/:poolId/join", async (req, res) => {
  try {
    const { userId } = req.body;
    const poolId = String(req.params.poolId);

    if (!userId) {
      return res.status(400).json({ success: false, error: "userId is required." });
    }

    const joinResult = await joinPoolTransaction({ poolId, userId });
    broadcastPoolUpdate(req, poolId, {
      userId,
      reason: "member_joined",
      joined: !joinResult.alreadyMember,
    });

    return res.json({
      success: true,
      poolId,
      pool: joinResult.pool,
      alreadyMember: joinResult.alreadyMember,
    });
  } catch (error) {
    if (error.message === "POOL_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "Pool not found." });
    }
    if (error.message === "USER_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "User not found." });
    }
    if (error.message === "POOL_FULL") {
      return res.status(400).json({ success: false, error: "Pool is full." });
    }
    if (error.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ success: false, error: "Insufficient balance." });
    }
    console.error("/api/pools/:poolId/join error:", error);
    return res.status(500).json({ success: false, error: "Failed to join pool." });
  }
});

router.post("/pools/:poolId/join-payment", async (req, res) => {
  try {
    const poolId = String(req.params.poolId);
    const { userId, receiptTextOrLink } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: "userId is required." });
    }

    if (!receiptTextOrLink || !String(receiptTextOrLink).trim()) {
      return res.status(400).json({ success: false, error: "Receipt message or transaction link is required." });
    }

    const pool = await getPoolById(poolId);
    if (!pool) {
      return res.status(404).json({ success: false, error: "Pool not found." });
    }

    const serviceResponse = await verifyPayment(String(receiptTextOrLink).trim(), pool.amount);
    if (!serviceResponse?.valid) {
      return res.status(400).json({
        success: false,
        error: serviceResponse?.message || "Telebirr payment could not be verified.",
        serviceResponse,
      });
    }

    const transactionId = extractReceiptCode(receiptTextOrLink) || extractTransactionId(serviceResponse);
    if (!transactionId) {
      return res.status(400).json({ success: false, error: "Payment was verified, but transaction id was not found." });
    }

    const transactionRef = db.collection("transactions").doc(String(transactionId));
    const transactionDoc = await transactionRef.get();
    if (transactionDoc.exists) {
      return res.status(409).json({ success: false, error: "This Telebirr transaction has already been used." });
    }

    const paidAmount = extractAmount(serviceResponse, pool.amount);
    if (!paidAmount || paidAmount < pool.amount) {
      return res.status(400).json({
        success: false,
        error: `Verified amount must be at least ${pool.amount}.`,
      });
    }

    const joinResult = await joinPoolTransaction({
      poolId,
      userId,
      skipBalanceCheck: true,
      payment: {
        transactionId: String(transactionId),
        amount: paidAmount,
        method: "telebirr",
      },
    });
    broadcastPoolUpdate(req, poolId, {
      userId,
      reason: "member_joined",
      joined: !joinResult.alreadyMember,
    });

    await transactionRef.set({
      transactionId: String(transactionId),
      userId: String(userId),
      poolId,
      amount: paidAmount,
      purpose: "pool_join",
      serviceResponse,
      createdAt: db.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      poolId,
      pool: joinResult.pool,
      alreadyMember: joinResult.alreadyMember,
      transactionId: String(transactionId),
      paidAmount,
    });
  } catch (error) {
    if (error.message === "POOL_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "Pool not found." });
    }
    if (error.message === "USER_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "User not found." });
    }
    if (error.message === "POOL_FULL") {
      return res.status(400).json({ success: false, error: "Pool is full." });
    }
    console.error("/api/pools/:poolId/join-payment error:", error);
    return res.status(500).json({ success: false, error: "Failed to validate payment and join pool." });
  }
});

router.get("/pools/:poolId/predictions/:userId", async (req, res) => {
  try {
    const { poolId, userId } = req.params;
    if (!userId) {
      return res.status(400).json({ success: false, error: "userId is required." });
    }

    if (redis.isOpen) {
      const cached = await redis.get(predictionsCacheKey(poolId, userId));
      if (cached) {
        const predictions = await includeMatchPossiblePoints(JSON.parse(cached));
        return res.json({ success: true, exists: true, predictions });
      }
    }

    const doc = await getPredictionDocRef(poolId, userId).get();
    if (!doc.exists) {
      return res.json({ success: true, exists: false, predictions: null });
    }

    const predictions = await includeMatchPossiblePoints(doc.data());

    if (redis.isOpen) {
      await redis.set(predictionsCacheKey(poolId, userId), JSON.stringify(predictions), { EX: 60 });
    }

    return res.json({ success: true, exists: true, predictions });
  } catch (error) {
    console.error("/api/pools/:poolId/predictions/:userId error:", error);
    return res.status(500).json({ success: false, error: "Failed to load predictions." });
  }
});

router.post("/pools/:poolId/group-predictions", async (req, res) => {
  try {
    const { poolId } = req.params;
    const { userId, groupPredictions } = req.body;

    if (!userId || !groupPredictions) {
      return res.status(400).json({ success: false, error: "userId and groupPredictions are required." });
    }

    const memberDoc = await getMemberDocRef(poolId, userId).get();
    if (!memberDoc.exists) {
      return res.status(403).json({ success: false, error: "Join the pool before saving predictions." });
    }

    const predictionsRef = getPredictionDocRef(poolId, userId);
    const predictionsDoc = await predictionsRef.get();
    const existing = predictionsDoc.exists ? predictionsDoc.data() : {};

    const lockedGroupIds = normalizeLockedGroupIds(existing);
    const lockedGroupIdSet = new Set(lockedGroupIds);
    const requestedLockedGroups = Object.keys(groupPredictions || {}).filter((groupId) => lockedGroupIdSet.has(groupId));

    if (existing.groupPredictionsLocked || requestedLockedGroups.length) {
      return res.status(400).json({ success: false, error: "One or more group predictions are locked." });
    }

    const summary = computePredictionSummary(Boolean(existing.groupPredictionsLocked), existing.matchPredictions || {});
    const nextGroupPredictions = {
      ...(existing.groupPredictions || {}),
      ...groupPredictions,
    };
    const savedGroupIds = new Set(normalizeSavedGroupIds(existing));
    Object.keys(groupPredictions || {}).forEach((groupId) => savedGroupIds.add(groupId));

    const payload = {
      userId: String(userId),
      groupPredictions: nextGroupPredictions,
      lockedGroupIds,
      savedGroupIds: [...savedGroupIds],
      groupPredictionsLocked: Boolean(existing.groupPredictionsLocked),
      matchPredictions: existing.matchPredictions || {},
      matchCount: summary.matchCount,
      points: summary.points,
      updatedAt: db.FieldValue.serverTimestamp(),
    };

    if (!predictionsDoc.exists) {
      payload.createdAt = db.FieldValue.serverTimestamp();
    }

    await predictionsRef.set(payload, { merge: true });

    await invalidatePoolCache(poolId, userId);
    broadcastPoolUpdate(req, poolId, { userId, reason: "group_predictions_saved" });

    return res.json({ success: true, predictions: payload });
  } catch (error) {
    console.error("/api/pools/:poolId/group-predictions error:", error);
    return res.status(500).json({ success: false, error: "Failed to save group predictions." });
  }
});

router.post("/pools/:poolId/group-predictions/lock", async (req, res) => {
  try {
    const { poolId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: "userId is required." });
    }

    const memberDoc = await getMemberDocRef(poolId, userId).get();
    if (!memberDoc.exists) {
      return res.status(403).json({ success: false, error: "Join the pool before locking predictions." });
    }

    const predictionsRef = getPredictionDocRef(poolId, userId);
    const predictionsDoc = await predictionsRef.get();
    const existing = predictionsDoc.exists ? predictionsDoc.data() : {};

    const allGroupIds = getAllGroupIds();
    const groupPointEngine = await getGroupPointEngine();
    const groupPossiblePoints = calculateAllGroupPossiblePoints(existing.groupPredictions || {}, groupPointEngine);
    const summary = computePredictionSummary(true, existing.matchPredictions || {});

    await predictionsRef.set(
      {
        userId: String(userId),
        groupPredictions: existing.groupPredictions || {},
        lockedGroupIds: allGroupIds,
        savedGroupIds: allGroupIds,
        groupPossiblePoints,
        totalGroupPossiblePoints: sumGroupPossiblePoints(groupPossiblePoints),
        groupPredictionsLocked: true,
        matchPredictions: existing.matchPredictions || {},
        matchCount: summary.matchCount,
        points: summary.points,
        lockedAt: db.FieldValue.serverTimestamp(),
        updatedAt: db.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await invalidatePoolCache(poolId, userId);
    broadcastPoolUpdate(req, poolId, { userId, reason: "group_predictions_locked" });

    return res.json({ success: true, locked: true });
  } catch (error) {
    console.error("/api/pools/:poolId/group-predictions/lock error:", error);
    return res.status(500).json({ success: false, error: "Failed to lock group predictions." });
  }
});

router.post("/pools/:poolId/group-predictions/:groupId", async (req, res) => {
  try {
    const { poolId, groupId } = req.params;
    const { userId, groupOrder } = req.body;

    if (!userId || !Array.isArray(groupOrder)) {
      return res.status(400).json({ success: false, error: "userId and groupOrder are required." });
    }

    if (!assertGroupExists(groupId)) {
      return res.status(404).json({ success: false, error: "Group not found." });
    }

    const memberDoc = await getMemberDocRef(poolId, userId).get();
    if (!memberDoc.exists) {
      return res.status(403).json({ success: false, error: "Join the pool before saving predictions." });
    }

    const predictionsRef = getPredictionDocRef(poolId, userId);
    const predictionsDoc = await predictionsRef.get();
    const existing = predictionsDoc.exists ? predictionsDoc.data() : {};

    if (isGroupLocked(existing, groupId)) {
      return res.status(400).json({ success: false, error: "This group prediction is locked." });
    }

    const summary = computePredictionSummary(Boolean(existing.groupPredictionsLocked), existing.matchPredictions || {});
    const groupPredictions = {
      ...(existing.groupPredictions || {}),
      [groupId]: groupOrder,
    };
    const savedGroupIds = normalizeSavedGroupIds(existing);
    if (!savedGroupIds.includes(groupId)) {
      savedGroupIds.push(groupId);
    }

    const payload = {
      userId: String(userId),
      groupPredictions,
      lockedGroupIds: normalizeLockedGroupIds(existing),
      savedGroupIds,
      groupPredictionsLocked: Boolean(existing.groupPredictionsLocked),
      matchPredictions: existing.matchPredictions || {},
      matchCount: summary.matchCount,
      points: summary.points,
      updatedAt: db.FieldValue.serverTimestamp(),
    };

    if (!predictionsDoc.exists) {
      payload.createdAt = db.FieldValue.serverTimestamp();
    }

    await predictionsRef.set(payload, { merge: true });
    await invalidatePoolCache(poolId, userId);
    broadcastPoolUpdate(req, poolId, {
      userId,
      reason: "group_prediction_saved",
    });

    return res.json({ success: true, predictions: payload });
  } catch (error) {
    console.error("/api/pools/:poolId/group-predictions/:groupId error:", error);
    return res.status(500).json({ success: false, error: "Failed to save group prediction." });
  }
});

router.post("/pools/:poolId/group-predictions/:groupId/lock", async (req, res) => {
  try {
    const { poolId, groupId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: "userId is required." });
    }

    if (!assertGroupExists(groupId)) {
      return res.status(404).json({ success: false, error: "Group not found." });
    }

    const memberDoc = await getMemberDocRef(poolId, userId).get();
    if (!memberDoc.exists) {
      return res.status(403).json({ success: false, error: "Join the pool before locking predictions." });
    }

    const predictionsRef = getPredictionDocRef(poolId, userId);
    const predictionsDoc = await predictionsRef.get();
    const existing = predictionsDoc.exists ? predictionsDoc.data() : {};
    const lockedGroupIds = normalizeLockedGroupIds(existing);
    const nextLockedGroupIds = lockedGroupIds.includes(groupId) ? lockedGroupIds : [...lockedGroupIds, groupId];
    const savedGroupIds = normalizeSavedGroupIds(existing);
    const nextSavedGroupIds = savedGroupIds.includes(groupId) ? savedGroupIds : [...savedGroupIds, groupId];
    const groupPointEngine = await getGroupPointEngine();
    const nextGroupPossiblePoints = {
      ...(existing.groupPossiblePoints || {}),
      [groupId]: calculateGroupPossiblePoints(groupId, existing.groupPredictions?.[groupId] || [], groupPointEngine),
    };
    const summary = computePredictionSummary(Boolean(existing.groupPredictionsLocked), existing.matchPredictions || {});
    const allGroupsLocked = getAllGroupIds().every((id) => nextLockedGroupIds.includes(id));

    await predictionsRef.set(
      {
        userId: String(userId),
        groupPredictions: existing.groupPredictions || {},
        lockedGroupIds: nextLockedGroupIds,
        savedGroupIds: nextSavedGroupIds,
        groupPossiblePoints: nextGroupPossiblePoints,
        totalGroupPossiblePoints: sumGroupPossiblePoints(nextGroupPossiblePoints),
        groupPredictionsLocked: allGroupsLocked,
        matchPredictions: existing.matchPredictions || {},
        matchCount: summary.matchCount,
        points: summary.points,
        [`groupLockedAt.${groupId}`]: db.FieldValue.serverTimestamp(),
        updatedAt: db.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await invalidatePoolCache(poolId, userId);
    broadcastPoolUpdate(req, poolId, {
      userId,
      reason: "group_prediction_locked",
    });

    return res.json({
      success: true,
      locked: true,
      lockedGroupIds: nextLockedGroupIds,
      savedGroupIds: nextSavedGroupIds,
      groupPossiblePoints: nextGroupPossiblePoints,
      totalGroupPossiblePoints: sumGroupPossiblePoints(nextGroupPossiblePoints),
    });
  } catch (error) {
    console.error("/api/pools/:poolId/group-predictions/:groupId/lock error:", error);
    return res.status(500).json({ success: false, error: "Failed to lock group prediction." });
  }
});

router.post("/pools/:poolId/match-predictions", async (req, res) => {
  try {
    const { poolId } = req.params;
    const { userId, matchId, prediction } = req.body;

    if (!userId || !matchId || !prediction) {
      return res.status(400).json({ success: false, error: "userId, matchId, and prediction are required." });
    }

    const match = findMatchById(matchId);
    if (!match) {
      return res.status(404).json({ success: false, error: "Match not found." });
    }

    if (!isMatchPredictionEditable(match)) {
      return res.status(400).json({
        success: false,
        error: "Match predictions lock 5 minutes before kickoff.",
      });
    }

    const memberDoc = await getMemberDocRef(poolId, userId).get();
    if (!memberDoc.exists) {
      return res.status(403).json({ success: false, error: "Join the pool before saving predictions." });
    }

    const predictionsRef = getPredictionDocRef(poolId, userId);
    const possiblePoints = await getMatchPossiblePoints(matchId, prediction.outcome);
    let savedPrediction = null;

    await db.runTransaction(async (tx) => {
      // Lock a row guaranteed to exist so simultaneous first saves serialize per pool member.
      await tx.get(getMemberDocRef(poolId, userId));
      const predictionsDoc = await tx.get(predictionsRef);
      const existing = predictionsDoc.exists ? predictionsDoc.data() : {};
      const existingMatchPredictions = existing.matchPredictions || {};

      if (existingMatchPredictions[matchId]) {
        throw new Error("MATCH_PREDICTION_ALREADY_SAVED");
      }

      const matchPredictions = {
        ...existingMatchPredictions,
        [matchId]: {
          ...prediction,
          matchId,
          possiblePoints,
          savedAt: new Date().toISOString(),
        },
      };

      const summary = computePredictionSummary(Boolean(existing.groupPredictionsLocked), matchPredictions);

      tx.set(
        predictionsRef,
        {
          userId: String(userId),
          groupPredictions: existing.groupPredictions || {},
          groupPredictionsLocked: Boolean(existing.groupPredictionsLocked),
          matchPredictions,
          matchCount: summary.matchCount,
          points: summary.points,
          updatedAt: db.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      savedPrediction = matchPredictions[matchId];
    });

    await invalidatePoolCache(poolId, userId);
    broadcastPoolUpdate(req, poolId, {
      userId,
      reason: "match_prediction_saved",
    });

    return res.json({ success: true, matchId, prediction: savedPrediction });
  } catch (error) {
    if (error.message === "MATCH_PREDICTION_ALREADY_SAVED") {
      return res.status(409).json({
        success: false,
        error: "This match bet has already been saved for this pool and cannot be edited.",
      });
    }
    console.error("/api/pools/:poolId/match-predictions error:", error);
    return res.status(500).json({ success: false, error: "Failed to save match prediction." });
  }
});

router.get("/pools/:poolId/leaderboard", async (req, res) => {
  try {
    const { poolId } = req.params;

    if (redis.isOpen) {
      const cached = await redis.get(leaderboardCacheKey(poolId));
      if (cached) {
        return res.json({ success: true, leaderboard: JSON.parse(cached) });
      }
    }

    const membersSnapshot = await db
      .collection("pools")
      .doc(String(poolId))
      .collection("members")
      .get();

    const memberDocs = membersSnapshot.docs;
    const predictionRefs = memberDocs.map((doc) => getPredictionDocRef(poolId, doc.id));
    const predictionDocs = predictionRefs.length ? await Promise.all(predictionRefs.map((ref) => ref.get())) : [];

    const leaderboard = memberDocs.map((memberDoc, index) => {
      const memberData = memberDoc.data() || {};
      const predictionDoc = predictionDocs[index];
      const predictionData = predictionDoc?.exists ? predictionDoc.data() : {};

      return {
        userId: memberDoc.id,
        username: memberData.username || memberData.displayName || "Player",
        displayName: memberData.displayName || memberData.username || "Player",
        photo: memberData.photo || null,
        points: Number(predictionData.points || 0),
        accuracy: Number(predictionData.accuracy || 0),
        streak: Number(predictionData.streak || 0),
      };
    });

    const ranked = leaderboard
      .sort((a, b) => b.points - a.points)
      .map((row, index) => ({
        ...row,
        rank: index + 1,
        movement: "stable",
      }));

    if (redis.isOpen) {
      await redis.set(leaderboardCacheKey(poolId), JSON.stringify(ranked), { EX: 30 });
    }

    return res.json({ success: true, leaderboard: ranked });
  } catch (error) {
    console.error("/api/pools/:poolId/leaderboard error:", error);
    return res.status(500).json({ success: false, error: "Failed to load leaderboard." });
  }
});

module.exports = {
  router,
  ensurePoolsSeeded,
};
