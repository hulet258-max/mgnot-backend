const express = require("express");
const db = require("../config/postgres");
const { tournamentInfo, groups, matchDays, recentActivity } = require("../data/tournament");
const { ensurePoolsSeeded } = require("./pools");

const router = express.Router();
const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY || "";
const WORLD_CUP_LEAGUE_ID = process.env.API_FOOTBALL_WORLD_CUP_LEAGUE_ID || "1";
const WORLD_CUP_SEASON = process.env.API_FOOTBALL_WORLD_CUP_SEASON || "2026";
const ODDS_ENGINE_INTERVAL_MS = 10 * 60 * 1000;
const outcomes = ["home", "draw", "away"];
let generatedMatchOdds = {};
let generatedGroupPoints = {};
let oddsEngineTimer = null;
let oddsEngineRunning = false;

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
  createdAt: pool.createdAt || null,
  updatedAt: pool.updatedAt || null,
});

const docData = async (id, fallback) => {
  const ref = db.collection("tournament").doc(id);
  const snap = await ref.get();
  if (snap.exists) return snap.data().value;
  await ref.set({
    value: fallback,
    createdAt: db.FieldValue.serverTimestamp(),
    updatedAt: db.FieldValue.serverTimestamp(),
  });
  return fallback;
};

async function ensureTournamentDataSeeded() {
  await Promise.all([
    docData("info", tournamentInfo),
    docData("groups", groups),
    docData("match-days", matchDays),
    docData("recent-activity", recentActivity),
  ]);
}

async function getPools() {
  await ensurePoolsSeeded();
  const snapshot = await db.collection("pools").get();
  return snapshot.docs
    .map((doc) => normalizePool({ id: doc.id, ...doc.data() }))
    .sort((a, b) => a.amount - b.amount);
}

const normalizeTeamName = (value) => {
  return String(value || "")
    .toLowerCase()
    .replace(/\busa\b/g, "united states")
    .replace(/\bunited states of america\b/g, "united states")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
};

const getLocalMatches = () => matchDays.flatMap((day) => day.matches);

const pickMatchWinnerOdds = (fixtureOdds) => {
  const bookmaker = fixtureOdds.bookmakers?.[0];
  const bet = bookmaker?.bets?.find((item) => (
    String(item.name || "").toLowerCase() === "match winner" || Number(item.id) === 1
  ));
  const values = bet?.values || [];

  const getOdd = (labels) => {
    const entry = values.find((value) => labels.includes(String(value.value || "").toLowerCase()));
    return entry?.odd || null;
  };

  return {
    home: getOdd(["home", "1"]),
    draw: getOdd(["draw", "x"]),
    away: getOdd(["away", "2"]),
    bookmaker: bookmaker?.name || null,
  };
};

const mapProviderOddsToMatches = (providerOdds) => {
  const localMatches = getLocalMatches();
  const oddsByMatch = {};

  providerOdds.forEach((fixtureOdds) => {
    const fixture = fixtureOdds.fixture || {};
    const teams = fixtureOdds.teams || {};
    const homeName = normalizeTeamName(teams.home?.name || fixture.home || fixture.homeTeam);
    const awayName = normalizeTeamName(teams.away?.name || fixture.away || fixture.awayTeam);

    const localMatch = localMatches.find((match) => {
      return normalizeTeamName(match.homeTeam) === homeName && normalizeTeamName(match.awayTeam) === awayName;
    });

    if (!localMatch) return;
    oddsByMatch[localMatch.id] = pickMatchWinnerOdds(fixtureOdds);
  });

  return oddsByMatch;
};

const fetchOddsForDate = async (date) => {
  const params = new URLSearchParams({
    league: WORLD_CUP_LEAGUE_ID,
    season: WORLD_CUP_SEASON,
    date,
    bet: "1",
  });

  const response = await fetch(`${API_FOOTBALL_BASE_URL}/odds?${params.toString()}`, {
    headers: {
      "x-apisports-key": API_FOOTBALL_KEY,
    },
  });
  const data = await response.json();

  if (!response.ok || data.errors?.length) {
    throw new Error(data.message || "Failed to load odds.");
  }

  return data.response || [];
};

const getProviderOdds = async () => {
  const dates = Array.from(new Set(matchDays.map((day) => day.date)));
  const results = await Promise.all(dates.map((date) => fetchOddsForDate(date)));
  return mapProviderOddsToMatches(results.flat());
};

const emptyCounts = () => ({ home: 0, draw: 0, away: 0 });

const getPredictionCountsByMatch = async () => {
  const countsByMatch = getLocalMatches().reduce((acc, match) => {
    acc[match.id] = emptyCounts();
    return acc;
  }, {});

  const pools = await getPools();
  await Promise.all(pools.map(async (pool) => {
    const snapshot = await db
      .collection("pools")
      .doc(pool.id)
      .collection("predictions")
      .get();

    snapshot.docs.forEach((doc) => {
      const predictions = doc.data()?.matchPredictions || {};
      Object.values(predictions).forEach((prediction) => {
        const matchId = prediction?.matchId;
        const outcome = prediction?.outcome;
        if (countsByMatch[matchId] && outcomes.includes(outcome)) {
          countsByMatch[matchId][outcome] += 1;
        }
      });
    });
  }));

  return countsByMatch;
};

const calculateGeneratedPoints = ({ count, total, providerOdd }) => {
  if (!total) return 3;

  const scarcity = count > 0 ? total / count : total + 1;
  const crowdPoints = Math.round(3 * scarcity);
  const providerBoost = providerOdd > 0 ? Math.max(0, Math.round(Number(providerOdd) - 1)) : 0;
  return Math.max(1, Math.min(50, crowdPoints + providerBoost));
};

const calculateCrowdPoints = ({ count, total }) => {
  if (!total) return 3;
  const scarcity = count > 0 ? total / count : total + 1;
  return Math.max(1, Math.min(50, Math.round(3 * scarcity)));
};

const classifyOutcomes = (items) => {
  const byCount = [...items].sort((a, b) => b.count - a.count);
  const highestCount = byCount[0]?.count || 0;
  const lowestCount = byCount[byCount.length - 1]?.count || 0;

  return items.reduce((acc, item) => {
    let tag = "balanced";
    if (item.count === highestCount && highestCount !== lowestCount) tag = "favorite";
    if (item.count === lowestCount && highestCount !== lowestCount) tag = "underdog";
    acc[item.outcome] = { ...item, tag };
    return acc;
  }, {});
};

const getMatchOutcome = (match) => {
  const score = match.finalScore || match.score || match.result;
  const homeScore = Number(match.homeScore ?? match.finalHomeScore);
  const awayScore = Number(match.awayScore ?? match.finalAwayScore);

  if (Number.isFinite(homeScore) && Number.isFinite(awayScore)) {
    if (homeScore > awayScore) return "home";
    if (awayScore > homeScore) return "away";
    return "draw";
  }

  const scoreMatch = String(score || "").match(/(\d+)\s*[-:]\s*(\d+)/);
  if (!scoreMatch) return null;

  const parsedHome = Number(scoreMatch[1]);
  const parsedAway = Number(scoreMatch[2]);
  if (parsedHome > parsedAway) return "home";
  if (parsedAway > parsedHome) return "away";
  return "draw";
};

const isCompletedMatch = (match) => {
  const status = String(match.status || "").toLowerCase();
  return Boolean(getMatchOutcome(match)) && ["finished", "completed", "closed", "final"].includes(status);
};

const calculatePredictionPoints = (prediction, match, generatedOddsForMatch) => {
  const outcome = getMatchOutcome(match);
  if (!outcome || prediction?.outcome !== outcome) return 0;
  return Number(generatedOddsForMatch?.[outcome]?.points || 0);
};

const scoreCompletedMatches = async (generatedOdds) => {
  const completedMatches = getLocalMatches().filter(isCompletedMatch);
  if (!completedMatches.length) return;

  const pools = await getPools();
  await Promise.all(pools.map(async (pool) => {
    const snapshot = await db
      .collection("pools")
      .doc(pool.id)
      .collection("predictions")
      .get();

    await Promise.all(snapshot.docs.map(async (doc) => {
      const predictionDoc = doc.data() || {};
      const matchPredictions = predictionDoc.matchPredictions || {};
      let changed = false;

      const nextMatchPredictions = { ...matchPredictions };
      completedMatches.forEach((match) => {
        const prediction = nextMatchPredictions[match.id];
        if (!prediction) return;

        const nextPoints = calculatePredictionPoints(prediction, match, generatedOdds[match.id]);
        if (
          prediction.pointsEarned !== nextPoints ||
          prediction.scoredOutcome !== getMatchOutcome(match)
        ) {
          nextMatchPredictions[match.id] = {
            ...prediction,
            pointsEarned: nextPoints,
            scoredOutcome: getMatchOutcome(match),
            scoredAt: new Date().toISOString(),
          };
          changed = true;
        }
      });

      if (!changed) return;

      const points = Object.values(nextMatchPredictions).reduce((sum, prediction) => {
        return sum + Number(prediction?.pointsEarned || 0);
      }, 0);

      await doc.ref.set({
        ...predictionDoc,
        matchPredictions: nextMatchPredictions,
        points,
        matchCount: Object.keys(nextMatchPredictions).length,
        updatedAt: db.FieldValue.serverTimestamp(),
      }, { merge: true });
    }));
  }));
};

const buildGeneratedMatchOdds = async () => {
  let providerOdds = {};
  try {
    providerOdds = await getProviderOdds();
  } catch (error) {
    console.warn("Odds provider unavailable; using crowd engine only:", error.message);
  }

  const countsByMatch = await getPredictionCountsByMatch();
  const nextGeneratedOdds = {};

  getLocalMatches().forEach((match) => {
    const counts = countsByMatch[match.id] || emptyCounts();
    const total = outcomes.reduce((sum, outcome) => sum + counts[outcome], 0);
    const provider = providerOdds[match.id] || {};
    const items = outcomes.map((outcome) => {
      const providerOdd = Number(provider[outcome] || 0);
      return {
        outcome,
        count: counts[outcome],
        providerOdd,
        points: calculateGeneratedPoints({
          count: counts[outcome],
          total,
          providerOdd,
        }),
      };
    });

    nextGeneratedOdds[match.id] = {
      home: null,
      draw: null,
      away: null,
      totalPredictions: total,
      generatedAt: new Date().toISOString(),
      ...classifyOutcomes(items),
    };
  });

  generatedMatchOdds = nextGeneratedOdds;
  await db.collection("engines").doc("match-odds").set({
    odds: generatedMatchOdds,
    updatedAt: db.FieldValue.serverTimestamp(),
  });

  await scoreCompletedMatches(generatedMatchOdds);

  return generatedMatchOdds;
};

const buildGeneratedGroupPoints = async () => {
  const countsByGroup = groups.reduce((acc, group) => {
    acc[group.id] = group.teams.reduce((teamAcc, team) => {
      teamAcc[team.id] = 0;
      return teamAcc;
    }, {});
    return acc;
  }, {});

  const pools = await getPools();
  await Promise.all(pools.map(async (pool) => {
    const snapshot = await db
      .collection("pools")
      .doc(pool.id)
      .collection("predictions")
      .get();

    snapshot.docs.forEach((doc) => {
      const groupPredictions = doc.data()?.groupPredictions || {};
      Object.entries(groupPredictions).forEach(([groupId, order]) => {
        if (!countsByGroup[groupId] || !Array.isArray(order)) return;
        order.slice(0, 2).forEach((teamId) => {
          if (countsByGroup[groupId][teamId] !== undefined) {
            countsByGroup[groupId][teamId] += 1;
          }
        });
      });
    });
  }));

  generatedGroupPoints = groups.reduce((acc, group) => {
    const counts = countsByGroup[group.id] || {};
    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    const highestCount = Math.max(0, ...Object.values(counts).map(Number));
    const lowestCount = Math.min(...Object.values(counts).map(Number));

    acc[group.id] = {
      totalPredictions: total,
      generatedAt: new Date().toISOString(),
      teams: group.teams.reduce((teamAcc, team) => {
        const count = Number(counts[team.id] || 0);
        let tag = "balanced";
        if (highestCount !== lowestCount && count === highestCount) tag = "favored";
        if (highestCount !== lowestCount && count === lowestCount) tag = "underdog";

        teamAcc[team.id] = {
          teamId: team.id,
          teamName: team.name,
          count,
          tag,
          points: calculateCrowdPoints({ count, total }),
        };
        return teamAcc;
      }, {}),
    };
    return acc;
  }, {});

  await db.collection("engines").doc("group-points").set({
    points: generatedGroupPoints,
    updatedAt: db.FieldValue.serverTimestamp(),
  });

  return generatedGroupPoints;
};

const startMatchOddsEngine = () => {
  if (oddsEngineTimer) return;

  const run = async () => {
    if (oddsEngineRunning) return;
    oddsEngineRunning = true;
    try {
      await buildGeneratedMatchOdds();
      await buildGeneratedGroupPoints();
    } catch (error) {
      console.error("Match odds engine error:", error);
    } finally {
      oddsEngineRunning = false;
    }
  };

  run();
  oddsEngineTimer = setInterval(run, ODDS_ENGINE_INTERVAL_MS);
};

router.get("/match-odds", async (req, res) => {
  try {
    const doc = await db.collection("engines").doc("match-odds").get();
    generatedMatchOdds = doc.exists ? doc.data().odds || {} : {};

    return res.json({ success: true, odds: generatedMatchOdds });
  } catch (error) {
    console.error("/api/match-odds error:", error);
    return res.json({ success: true, odds: {}, warning: "Odds are not available yet." });
  }
});

router.get("/group-points", async (req, res) => {
  try {
    const doc = await db.collection("engines").doc("group-points").get();
    generatedGroupPoints = doc.exists ? doc.data().points || {} : {};

    return res.json({ success: true, points: generatedGroupPoints });
  } catch (error) {
    console.error("/api/group-points error:", error);
    return res.json({ success: true, points: {}, warning: "Group points are not available yet." });
  }
});

router.get("/tournament-data", async (req, res) => {
  try {
    await ensureTournamentDataSeeded();
    const [info, seededGroups, seededMatchDays, seededRecentActivity, pools] = await Promise.all([
      docData("info", tournamentInfo),
      docData("groups", groups),
      docData("match-days", matchDays),
      docData("recent-activity", recentActivity),
      getPools(),
    ]);

    return res.json({
      success: true,
      tournamentInfo: info,
      groups: seededGroups,
      matchDays: seededMatchDays,
      recentActivity: seededRecentActivity,
      pools,
    });
  } catch (error) {
    console.error("/api/tournament-data error:", error);
    return res.status(500).json({ success: false, error: "Failed to load tournament data." });
  }
});

module.exports = {
  router,
  ensureTournamentDataSeeded,
  buildGeneratedMatchOdds,
  buildGeneratedGroupPoints,
  startMatchOddsEngine,
};
