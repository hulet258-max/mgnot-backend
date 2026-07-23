const DEFAULT_POOLS = [
  {
    id: "pool-5",
    amount: 5,
    prize: 2400,
    capacity: 500,
    status: "Open",
    rules: [
      "One entry per Telegram account.",
      "Group predictions lock before the first tournament kickoff.",
      "Daily predictions lock at kickoff for each match.",
    ],
    progression: "Top 40% advance from group-stage pool ranking.",
    points: "Outcome 3 pts, exact score 7 pts, bonus events 1-3 pts.",
    rewards: "Top 20 paid positions with the winner receiving 25% of the pool.",
  },
  {
    id: "pool-10",
    amount: 10,
    prize: 6800,
    capacity: 700,
    status: "Filling Fast",
    rules: [
      "Predictions must be submitted from the connected Telegram account.",
      "Late match predictions are read-only after kickoff.",
      "Ties are resolved by exact-score count, then streak length.",
    ],
    progression: "Top 35% remain in reward contention after group stage.",
    points: "Outcome 3 pts, exact score 7 pts, group rank bonus up to 12 pts.",
    rewards: "Top 30 paid positions with qualification bonuses.",
  },
  {
    id: "pool-25",
    amount: 25,
    prize: 18750,
    capacity: 750,
    status: "Hot",
    rules: [
      "All predictions are final after submission or kickoff lock.",
      "Users can view every saved prediction from My Predictions.",
      "Suspicious duplicate accounts may be removed from rewards.",
    ],
    progression: "Top 30% qualify for knockout-stage rewards.",
    points: "Higher bonus weighting for exact score and first-goal picks.",
    rewards: "Top 50 paid positions with 30% allocated to the winner.",
  },
];

module.exports = {
  DEFAULT_POOLS,
};
