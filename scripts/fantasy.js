// Weekly fantasy projections: simulate every unplayed game of the target week and store each
// player's fantasy-point distribution (21 quantiles) for PPR, half-PPR and standard scoring.
//   node scripts/fantasy.js site/data/model.json site/data/fantasy.json [sims]
const fs = require("fs");
const Sim = require("../site/js/sim.js");
const [modelPath, outPath, nArg] = process.argv.slice(2);
const N = +nArg || 3000;
const model = JSON.parse(fs.readFileSync(modelPath));
const FMTS = ["ppr", "half", "std"];
const Q = Array.from({ length: 21 }, (_, i) => i / 20);
const quant = (arr) => { const s = Float64Array.from(arr).sort(); return Q.map((q) => +s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))].toFixed(1)); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// this week's remaining games plus next week's (so the board isn't empty on Monday night)
const weeks = [model.target_week, model.target_week + 1];
const games = model.schedule.filter((g) => weeks.includes(g.week) && g.home_score == null && model.teams[g.away] && model.teams[g.home]);
const players = [];
for (const g of games) {
  const week = g.week;
  const weather = g.weather && g.weather.features ? g.weather.features : null;
  const agg = Sim.simulateMany(model, { away: g.away, home: g.home, seed: 9001, weather }, N);
  const n = agg.n;
  const stat = (p, k, i) => (p.stats[k] ? p.stats[k][i] : 0);
  const teamSum = (team, k) => { const out = new Array(n).fill(0); for (const id in agg.players) { const p = agg.players[id]; if (p.team === team && p.stats[k]) for (let i = 0; i < n; i++) out[i] += p.stats[k][i]; } return out; };
  const kickers = new Set([model.teams[g.away].kicker.id, model.teams[g.home].kicker.id]);
  for (const id in agg.players) {
    const p = agg.players[id], side = p.team === g.home ? "home" : "away", opp = side === "home" ? g.away : g.home;
    const entry = { id, week, name: p.name, team: p.team, pos: kickers.has(id) ? "K" : p.pos, opp, home: side === "home", game: `${g.away}@${g.home}`, q: {}, mean: {} };
    for (const f of FMTS) {
      const pts = new Array(n);
      for (let i = 0; i < n; i++) {
        const line = {}; for (const k in p.stats) line[k] = p.stats[k][i];
        pts[i] = entry.pos === "K" ? Sim.kickerPoints(line) : Sim.fantasyPoints(line, f);
      }
      entry.q[f] = quant(pts); entry.mean[f] = +mean(pts).toFixed(2);
    }
    if (entry.mean.ppr < 0.5 && entry.pos !== "K") continue;
    const mp = model.teams[p.team].players.find((x) => x.id === id);
    if (mp && mp.status) entry.status = mp.status;
    players.push(entry);
  }
  // team defenses
  for (const [side, team, opp] of [["home", g.home, g.away], ["away", g.away, g.home]]) {
    const oppPts = side === "home" ? agg.away : agg.home;
    const sacks = teamSum(opp, "sk"), ints = teamSum(opp, "pint"), fl = teamSum(opp, "fl");
    const pts = oppPts.map((pa, i) => Sim.dstPoints({ pa, sacks: sacks[i], ints: ints[i], fumrec: fl[i] }));
    const q = quant(pts), m = +mean(pts).toFixed(2);
    players.push({ id: team + "-DST", week, name: team + " D/ST", team, pos: "DST", opp, home: side === "home", game: `${g.away}@${g.home}`,
      q: { ppr: q, half: q, std: q }, mean: { ppr: m, half: m, std: m } });
  }
}
fs.writeFileSync(outPath, JSON.stringify({ weeks, season: model.season, generated: model.generated, sims: N, games: games.map((g) => ({ week: g.week, game: `${g.away}@${g.home}`, date: g.date, time: g.time, weather: g.weather || null })), players }));
console.log(`fantasy: weeks ${weeks.join("+")}, ${games.length} games, ${players.length} player-games projected`);
