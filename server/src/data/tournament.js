const tournamentInfo = {
  name: "World Cup Prediction Challenge",
  stageStatus: "Group stage setup",
  nextMatchIso: "2026-06-11T19:00:00Z",
  duration: "June 11 - July 19",
  activeUsers: 18420,
};

const groupSeeds = [
  ["Mexico", "South Africa", "Japan", "New Zealand"],
  ["United States", "Colombia", "Ghana", "Australia"],
  ["Brazil", "Denmark", "Morocco", "Korea Republic"],
  ["France", "Senegal", "Scotland", "Costa Rica"],
  ["England", "Uruguay", "Egypt", "Qatar"],
  ["Argentina", "Switzerland", "Nigeria", "Saudi Arabia"],
  ["Spain", "Croatia", "Cameroon", "Panama"],
  ["Portugal", "Netherlands", "Tunisia", "Jamaica"],
  ["Germany", "Ecuador", "Iran", "Honduras"],
  ["Belgium", "Serbia", "Algeria", "Norway"],
  ["Sweden", "Paraguay", "Uzbekistan", "Iraq"],
  ["Italy", "Chile", "Mali", "Canada"],
];

const groups = groupSeeds.map((teams, groupIndex) => {
  const letter = String.fromCharCode(65 + groupIndex);
  return {
    id: `group-${letter.toLowerCase()}`,
    name: `Group ${letter}`,
    teams: teams.map((name, teamIndex) => ({
      id: `${letter.toLowerCase()}-${teamIndex + 1}`,
      name,
      code: name
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 3)
        .toUpperCase(),
    })),
  };
});

const matchDays = [
  {
    id: "day-1",
    label: "Match Day 1",
    date: "2026-06-11",
    matches: [
      {
        id: "m-001",
        group: "Group A",
        homeTeam: "Mexico",
        homeCode: "MEX",
        awayTeam: "South Africa",
        awayCode: "RSA",
        kickoff: "2026-06-11T19:00:00Z",
        stadium: "Azteca Stadium",
        status: "open",
      },
      {
        id: "m-002",
        group: "Group A",
        homeTeam: "Japan",
        homeCode: "JPN",
        awayTeam: "New Zealand",
        awayCode: "NZL",
        kickoff: "2026-06-11T22:00:00Z",
        stadium: "Guadalajara Stadium",
        status: "open",
      },
      {
        id: "m-003",
        group: "Group B",
        homeTeam: "United States",
        homeCode: "USA",
        awayTeam: "Colombia",
        awayCode: "COL",
        kickoff: "2026-06-12T01:00:00Z",
        stadium: "Los Angeles Stadium",
        status: "open",
      },
    ],
  },
  {
    id: "day-2",
    label: "Match Day 2",
    date: "2026-06-12",
    matches: [
      {
        id: "m-004",
        group: "Group B",
        homeTeam: "Ghana",
        homeCode: "GHA",
        awayTeam: "Australia",
        awayCode: "AUS",
        kickoff: "2026-06-12T18:00:00Z",
        stadium: "Seattle Stadium",
        status: "open",
      },
      {
        id: "m-005",
        group: "Group C",
        homeTeam: "Brazil",
        homeCode: "BRA",
        awayTeam: "Denmark",
        awayCode: "DEN",
        kickoff: "2026-06-12T21:00:00Z",
        stadium: "Miami Stadium",
        status: "open",
      },
      {
        id: "m-006",
        group: "Group C",
        homeTeam: "Morocco",
        homeCode: "MAR",
        awayTeam: "Korea Republic",
        awayCode: "KOR",
        kickoff: "2026-06-13T00:00:00Z",
        stadium: "Atlanta Stadium",
        status: "open",
      },
    ],
  },
  {
    id: "day-3",
    label: "Match Day 3",
    date: "2026-06-13",
    matches: [
      {
        id: "m-007",
        group: "Group D",
        homeTeam: "France",
        homeCode: "FRA",
        awayTeam: "Senegal",
        awayCode: "SEN",
        kickoff: "2026-06-13T17:00:00Z",
        stadium: "Toronto Stadium",
        status: "open",
      },
      {
        id: "m-008",
        group: "Group D",
        homeTeam: "Scotland",
        homeCode: "SCO",
        awayTeam: "Costa Rica",
        awayCode: "CRC",
        kickoff: "2026-06-13T20:00:00Z",
        stadium: "Vancouver Stadium",
        status: "open",
      },
      {
        id: "m-009",
        group: "Group E",
        homeTeam: "England",
        homeCode: "ENG",
        awayTeam: "Uruguay",
        awayCode: "URU",
        kickoff: "2026-06-13T23:00:00Z",
        stadium: "New York New Jersey Stadium",
        status: "open",
      },
    ],
  },
];

const recentActivity = [
  "Saved three match predictions for Match Day 1.",
  "Group C advancing teams selected.",
  "Leaderboard refresh moved you into the qualification watch zone.",
  "Exact-score bonus remains available for every open match.",
];

module.exports = {
  tournamentInfo,
  groups,
  matchDays,
  recentActivity,
};
