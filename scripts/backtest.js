// Backtest: for each week, use a model built only from earlier games, simulate that week's games,
// and compare with actual results and the closing market lines.
// Usage: node scripts/backtest.js 5 6 7   (expects backtest/model_w<N>.json, backtest/actual_players.json)
const fs = require("fs");
const Sim = require("../site/js/sim.js");
const weeks = process.argv.slice(2).map(Number);
const actualP = fs.existsSync("backtest/actual_players.json") ? JSON.parse(fs.readFileSync("backtest/actual_players.json")) : {};
const N = 2000;
const rows = [], props = [];
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const w of weeks) {
  const model = JSON.parse(fs.readFileSync(`backtest/model_w${w}.json`));
  for (const g of model.schedule.filter((g) => g.week === w && g.home_score != null)) {
    const agg = Sim.simulateMany(model, { away: g.away, home: g.home, seed: 7 }, N);
    const margin = agg.home.map((h, i) => h - agg.away[i]);
    const total = agg.home.map((h, i) => h + agg.away[i]);
    const simMargin = margin.reduce((a, b) => a + b, 0) / N;
    const simTotal = total.reduce((a, b) => a + b, 0) / N;
    const actM = g.home_score - g.away_score, actT = g.home_score + g.away_score;
    rows.push({ w, game: `${g.away}@${g.home}`, simMargin, mkt: g.spread, actM, simTotal, mktT: g.total, actT, pHome: agg.wins.home / N });
    for (const id in agg.players) {
      const p = agg.players[id], a = (actualP[w] || {})[id];
      if (!a) continue;
      for (const k of ["ry", "recy", "py"]) if (a[k] != null && med(p.stats[k]) > (k === "py" ? 100 : 15)) props.push({ k, name: p.short, sim: med(p.stats[k]), act: a[k] });
    }
  }
}
const mae = (f) => (rows.reduce((s, r) => s + Math.abs(f(r)), 0) / rows.length).toFixed(2);
const corr = (xs, ys) => { const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n; let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; } return (sxy / Math.sqrt(sx * sy)).toFixed(3); };
console.log(`games: ${rows.length}`);
console.log(`margin MAE  sim ${mae((r) => r.simMargin - r.actM)}  market ${mae((r) => r.mkt - r.actM)}   corr(sim, market) ${corr(rows.map((r) => r.simMargin), rows.map((r) => r.mkt))}`);
console.log(`total  MAE  sim ${mae((r) => r.simTotal - r.actT)}  market ${mae((r) => r.mktT - r.actT)}   mean sim total ${(rows.reduce((s, r) => s + r.simTotal, 0) / rows.length).toFixed(1)} vs market ${(rows.reduce((s, r) => s + r.mktT, 0) / rows.length).toFixed(1)} vs actual ${(rows.reduce((s, r) => s + r.actT, 0) / rows.length).toFixed(1)}`);
const fav = rows.filter((r) => (r.pHome > 0.5) === (r.actM > 0)).length;
console.log(`straight-up winner hit rate: sim ${(fav / rows.length * 100).toFixed(0)}%  market ${(rows.filter((r) => (r.mkt > 0) === (r.actM > 0)).length / rows.length * 100).toFixed(0)}%`);
for (const k of ["ry", "recy", "py"]) {
  const ps = props.filter((p) => p.k === k);
  const m = ps.reduce((s, p) => s + Math.abs(p.sim - p.act), 0) / ps.length;
  const bias = ps.reduce((s, p) => s + (p.sim - p.act), 0) / ps.length;
  console.log(`${k}: ${ps.length} player-games, median-projection MAE ${m.toFixed(1)}, bias ${bias.toFixed(1)}, corr ${corr(ps.map((p) => p.sim), ps.map((p) => p.act))}`);
}
fs.writeFileSync("backtest/results.json", JSON.stringify({ rows, props }, null, 1));
