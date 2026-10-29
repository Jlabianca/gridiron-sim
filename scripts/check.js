// Quick realism check: simulate every pairing of a sample of games, print league-level averages.
const fs = require("fs");
const Sim = require("../site/js/sim.js");
const model = JSON.parse(fs.readFileSync(process.argv[2] || "site/data/model.json"));
const g = Sim.simulateGame(model, { away: "CAR", home: "GB", seed: 42, log: true });
console.log("CAR @ GB seed 42:", g.score, "OT", g.ot, "drives", g.drives.length, "plays", g.plays.length);
for (const p of g.plays.slice(0, 12)) console.log(` Q${p.q} ${p.clock} ${p.down || ""}&${p.togo || ""} yl${p.yl} | ${p.desc}`);
console.log(g.drives.map((d) => d.team[0] + ":" + d.result).join(" "));
const teams = Object.keys(model.teams);
let pts = [], plays = [], yds = [], tos = [], passA = [], rushA = [], fga = [], drv = [];
const t0 = Date.now();
for (let i = 0; i < 3000; i++) {
  const a = teams[i % 32], h = teams[(i * 7 + 3) % 32];
  if (a === h) continue;
  const r = Sim.simulateGame(model, { away: a, home: h, seed: i });
  pts.push(r.score.away, r.score.home);
  for (const s of ["away", "home"]) { plays.push(r.tstats[s].plays); yds.push(r.tstats[s].yds); tos.push(r.tstats[s].to); }
  let pa = 0, ra = 0, fg = 0;
  for (const id in r.box) { pa += r.box[id].pa; ra += r.box[id].ra; fg += r.box[id].fga; }
  passA.push(pa / 2); rushA.push(ra / 2); fga.push(fg / 2); drv.push(r.drives.length / 2);
}
const m = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
const sd = (a) => { const mu = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / a.length).toFixed(2); };
console.log(`${pts.length / 2} games in ${Date.now() - t0}ms`);
console.log({ pts: m(pts), ptsSD: sd(pts), plays: m(plays), yds: m(yds), to: m(tos), passAtt: m(passA), rushAtt: m(rushA), fga: m(fga), drives: m(drv) });
