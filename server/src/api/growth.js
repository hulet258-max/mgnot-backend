const express = require("express");
const db = require("../config/postgres");
const { matchDays, groups } = require("../data/tournament");

const router = express.Router();

const getPools = async () => {
  const snapshot = await db.collection("pools").get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .sort((a, b) => Number(a.amount || 0) - Number(b.amount || 0));
};

const getMemberRef = (poolId, userId) => db
  .collection("pools")
  .doc(String(poolId))
  .collection("members")
  .doc(String(userId));

const getPredictionRef = (poolId, userId) => db
  .collection("pools")
  .doc(String(poolId))
  .collection("predictions")
  .doc(String(userId));

const getOpenMatches = () => {
  const now = Date.now();
  return matchDays.flatMap((day) => day.matches.map((match) => ({ ...match, dayId: day.id, dayLabel: day.label })))
    .filter((match) => {
      if (String(match.status || "").toLowerCase() !== "open") return false;
      return now < new Date(match.kickoff).getTime() - (5 * 60 * 1000);
    })
    .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
};

const getLeaderboard = async (poolId) => {
  const membersSnapshot = await db
    .collection("pools")
    .doc(String(poolId))
    .collection("members")
    .get();

  const rows = await Promise.all(membersSnapshot.docs.map(async (memberDoc) => {
    const member = memberDoc.data() || {};
    const predictionDoc = await getPredictionRef(poolId, memberDoc.id).get();
    const prediction = predictionDoc.exists ? predictionDoc.data() || {} : {};
    return {
      userId: memberDoc.id,
      username: member.username || member.displayName || "Player",
      points: Number(prediction.points || 0),
    };
  }));

  return rows
    .sort((a, b) => b.points - a.points)
    .map((row, index, ranked) => {
      const nextRank = index > 0 ? ranked[index - 1] : null;
      return {
        ...row,
        rank: index + 1,
        pointsBehindNext: nextRank ? Math.max(0, Number(nextRank.points || 0) - Number(row.points || 0)) : 0,
      };
    });
};

const buildActions = ({ joinedPoolIds, lockedGroupCount, totalGroups, openMatches, savedOpenMatchCount }) => {
  if (!joinedPoolIds.length) {
    return [{
      id: "join-pool",
      label: "Join a pool",
      description: "Choose an entry tier and validate your Telebirr payment.",
      path: "/pools",
      priority: 1,
    }];
  }

  if (lockedGroupCount < totalGroups) {
    return [{
      id: "lock-groups",
      label: "Lock group predictions",
      description: `${totalGroups - lockedGroupCount} groups still need a final order.`,
      path: "/group-predictions",
      priority: 1,
    }];
  }

  if (openMatches.length && savedOpenMatchCount < openMatches.length) {
    return [{
      id: "save-matches",
      label: "Predict today matches",
      description: `${openMatches.length - savedOpenMatchCount} open matches still need picks.`,
      path: "/matches",
      priority: 1,
    }];
  }

  return [{
    id: "check-leaderboard",
    label: "Check leaderboard",
    description: "See your current rank and points gap.",
    path: "/leaderboard",
    priority: 2,
  }];
};

router.get("/user-growth-summary", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, error: "userId is required." });
    }

    const userDoc = await db.collection("users").doc(String(userId)).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    const user = userDoc.data() || {};
    const pools = await getPools();
    const joinedPoolIds = Array.isArray(user.joinedPoolIds) ? [...user.joinedPoolIds] : [];

    for (const pool of pools) {
      const memberDoc = await getMemberRef(pool.id, userId).get();
      if (memberDoc.exists && !joinedPoolIds.includes(pool.id)) {
        joinedPoolIds.push(pool.id);
      }
    }

    const activePoolId = user.activePoolId || joinedPoolIds[0] || null;
    const openMatches = getOpenMatches();
    let predictionDoc = {};
    let currentRank = null;
    let pointsBehindNext = 0;

    if (activePoolId) {
      const predictionSnap = await getPredictionRef(activePoolId, userId).get();
      predictionDoc = predictionSnap.exists ? predictionSnap.data() || {} : {};
      const leaderboard = await getLeaderboard(activePoolId);
      const userRank = leaderboard.find((row) => String(row.userId) === String(userId));
      currentRank = userRank?.rank || null;
      pointsBehindNext = Number(userRank?.pointsBehindNext || 0);
    }

    const lockedGroupIds = predictionDoc.groupPredictionsLocked
      ? groups.map((group) => group.id)
      : Array.isArray(predictionDoc.lockedGroupIds) ? predictionDoc.lockedGroupIds : [];
    const matchPredictions = predictionDoc.matchPredictions || {};
    const savedOpenMatchCount = openMatches.filter((match) => matchPredictions[match.id]).length;
    const nextLockTime = openMatches[0]
      ? new Date(new Date(openMatches[0].kickoff).getTime() - (5 * 60 * 1000)).toISOString()
      : null;

    const actions = buildActions({
      joinedPoolIds,
      lockedGroupCount: lockedGroupIds.length,
      totalGroups: groups.length,
      openMatches,
      savedOpenMatchCount,
    });

    return res.json({
      success: true,
      summary: {
        activePoolId,
        joinedPoolIds,
        joinedPoolCount: joinedPoolIds.length,
        lockedGroupCount: lockedGroupIds.length,
        totalGroups: groups.length,
        groupCompletion: groups.length ? Math.round((lockedGroupIds.length / groups.length) * 100) : 0,
        openMatchCount: openMatches.length,
        savedOpenMatchCount,
        nextLockTime,
        currentRank,
        points: Number(predictionDoc.points || 0),
        pointsBehindNext,
        actions,
      },
    });
  } catch (error) {
    console.error("/api/user-growth-summary error:", error);
    return res.status(500).json({ success: false, error: "Failed to load growth summary." });
  }
});

router.post("/events", async (req, res) => {
  try {
    const { userId, eventName, metadata } = req.body || {};
    if (!eventName) {
      return res.status(400).json({ success: false, error: "eventName is required." });
    }

    const safeMetadata = metadata && typeof metadata === "object" ? { ...metadata } : {};
    delete safeMetadata.receiptTextOrLink;
    delete safeMetadata.serviceResponse;

    await db.collection("events").add({
      userId: userId ? String(userId) : null,
      eventName: String(eventName),
      metadata: safeMetadata,
      createdAt: db.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("/api/events error:", error);
    return res.status(500).json({ success: false, error: "Failed to record event." });
  }
});

module.exports = router;
