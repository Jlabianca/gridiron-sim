// Scorecard: snapshot the model's pre-game projections and attach final scores.
//
//   node scripts/scorecard.js site/data/model.json site/data/history.json [--backfill]
//
// For every unplayed game in the model's target week, it (re)writes the projection, so the
// stored number is the last one made before kickoff (the site rebuilds every morning).
// Games that already have a final score are frozen: only the result is added.
// --backfill: also snapshot target-week games that are already final (used with point-in-time
// models built by `build_data.py --week N`, which only see data from before week N).
const fs = require("fs");
const Sim = require("../site/js/sim.js");
const [modelPath, histPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const backfill = process.argv.includes("--backfill");
const N = 5000;
const model = JSON.parse(fs.readFileSync(modelPath));
const hist = fs.existsSync(histPath) ? JSON.parse(fs.readFileSync(histPath)) : { season: model.season, games: {} };
if (hist.season !== model.season) { hist.season = model.season; hist.games = {}; }

function project(g) {
  const weather = g.weather && g.weather.features ? g.weather.features : null;
  const agg = Sim.simulateMany(model, { away: g.away, home: g.home, seed: 2026, weather }, N);
  let ph = 0, cover = 0, push = 0, over = 0, m = 0, t = 0;
  for (let i = 0; i < agg.n; i++) {
    const mg = agg.home[i] - agg.away[i], tt = agg.home[i] + agg.away[i];
    m += mg; t += tt;
    if (mg > 0) ph++; else if (mg === 0) ph += 0.5;
    if (g.spread != null) { if (mg > g.spread) cover++; else if (mg === g.spread) push++; }
    if (g.total != null && tt > g.total) over++;
  }
  const one = Sim.simulateGame(model, { away: g.away, home: g.home, seed: 1, weather });
  const qbName = (side) => { const id = one.qb[side]; const p = model.teams[g[side]].players.find((x) => x.id === id); return p ? p.name : null; };
  const n = agg.n;
  return {
    p_home: +(ph / n).toFixed(4), margin: +(m / n).toFixed(2), total_proj: +(t / n).toFixed(2),
    p_home_cover: g.spread != null ? +(cover / (n - push || 1)).toFixed(4) : null,
    p_over: g.total != null ? +(over / n).toFixed(4) : null,
    qb_away: qbName("away"), qb_home: qbName("home"),
    weather: weather ? g.weather.source : (g.weather && g.weather.source) || null,
  };
}

let snapped = 0, graded = 0;
const now = new Date();
for (const g of model.schedule) {
  const h = hist.games[g.game_id];
  const final = g.home_score != null;
  const kickoff = new Date(`${g.date}T${(g.time && g.time.length >= 4 ? g.time : "13:00")}:00-05:00`);
  const canSnap = g.week === model.target_week && (backfill ? true : !final && kickoff > now);
  if (canSnap && (!h || !h.final || backfill)) {
    hist.games[g.game_id] = Object.assign({
      game_id: g.game_id, week: g.week, date: g.date, away: g.away, home: g.home,
      spread: g.spread, total: g.total, away_ml: g.away_ml, home_ml: g.home_ml,
      snapshot: model.generated, data_through_week: model.through_week, backfill: backfill || undefined,
    }, project(g));
    snapped++;
  }
  const e = hist.games[g.game_id];
  if (e && final && !e.final) {
    Object.assign(e, { final: true, away_score: g.away_score, home_score: g.home_score });
    graded++;
  }
}
hist.updated = model.generated;
fs.writeFileSync(histPath, JSON.stringify(hist));
console.log(`scorecard: ${snapped} projections saved, ${graded} games graded, ${Object.keys(hist.games).length} games in history`);
