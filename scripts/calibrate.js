// Tune league.clock_scale so simulated scrimmage plays per team match the real season average.
// Usage: node scripts/calibrate.js site/data/model.json
const fs = require("fs");
const Sim = require("../site/js/sim.js");
const path = process.argv[2] || "site/data/model.json";
const model = JSON.parse(fs.readFileSync(path));
const teams = Object.keys(model.teams);
function playsPerTeam() {
  let n = 0, k = 0, pts = 0;
  for (let i = 0; i < 1200; i++) {
    const a = teams[i % teams.length], h = teams[(i * 7 + 3) % teams.length];
    if (a === h) continue;
    const r = Sim.simulateGame(model, { away: a, home: h, seed: 1000 + i });
    n += r.tstats.away.plays + r.tstats.home.plays; k += 2; pts += r.score.away + r.score.home;
  }
  lastPts = pts / k;
  return n / k;
}
let lastPts = 0;
const target = model.league.target_plays_per_team, tpts = model.league.target_pts_per_team;
for (let it = 0; it < 8; it++) {
  const p = playsPerTeam();
  console.log(`clock ${model.league.clock_scale.toFixed(3)} yds ${model.league.yds_scale.toFixed(3)} -> ${p.toFixed(2)} plays/team (target ${target.toFixed(2)}), ${lastPts.toFixed(2)} pts/team (target ${tpts.toFixed(2)})`);
  if (Math.abs(p - target) < 0.3 && Math.abs(lastPts - tpts) < 0.3) break;
  model.league.clock_scale *= Math.pow(p / target, 1.6);
  model.league.yds_scale *= Math.pow(tpts / lastPts, 0.35);
}
fs.writeFileSync(path, JSON.stringify(model));
