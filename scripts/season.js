// Season simulator + power ratings.
//   node scripts/season.js site/data/model.json site/data/season.json [simsPerGame] [seasons] [--ratings-only]
//
// 1. Every remaining regular-season game is simulated with the play-by-play engine; we keep the
//    final margins (from the home team's view).
// 2. Power ratings: offense/defense points per game vs an average team, fit to the simulated scores
//    of a round of games between every team and a spread of opponents.
// 3. The rest of the season is replayed many times by drawing one simulated result per game,
//    then standings, tiebreakers (simplified), the 14-team playoff bracket and draft order.
const fs = require("fs");
const Sim = require("../site/js/sim.js");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [modelPath, outPath] = args;
const PER_GAME = +args[2] || 1000, SEASONS = +args[3] || 10000;
const ratingsOnly = process.argv.includes("--ratings-only");
const model = JSON.parse(fs.readFileSync(modelPath));

const DIV = {
  "AFC East": ["BUF", "MIA", "NE", "NYJ"], "AFC North": ["BAL", "CIN", "CLE", "PIT"], "AFC South": ["HOU", "IND", "JAX", "TEN"], "AFC West": ["DEN", "KC", "LV", "LAC"],
  "NFC East": ["DAL", "NYG", "PHI", "WAS"], "NFC North": ["CHI", "DET", "GB", "MIN"], "NFC South": ["ATL", "CAR", "NO", "TB"], "NFC West": ["ARI", "LA", "SF", "SEA"],
};
const divOf = {}, confOf = {};
for (const d in DIV) for (const t of DIV[d]) { divOf[t] = d; confOf[t] = d.slice(0, 3); }
const TEAMS = Object.keys(divOf).filter((t) => model.teams[t]);
const rng = Sim.mulberry32(20261102);

// ---------- 1. power ratings: points scored/allowed vs an average opponent ----------
// every team plays 6 opponents spread across the league (home and away), 300 sims each
function ratings() {
  const rows = [];
  TEAMS.forEach((t, i) => {
    for (let k = 1; k <= 6; k++) {
      const o = TEAMS[(i + k * 5) % TEAMS.length]; if (o === t) continue;
      const r = Sim.winProb(model, { away: o, home: t, seed: 500 + i * 13 + k, neutral: true }, 300);
      rows.push({ home: t, away: o, hs: (r.total + r.margin) / 2, as: (r.total - r.margin) / 2 });
    }
  });
  // least squares: score(team vs opp) = mu + off[team] - def[opp]  (alternating updates)
  const off = Object.fromEntries(TEAMS.map((t) => [t, 0])), def = Object.fromEntries(TEAMS.map((t) => [t, 0]));
  const obs = []; for (const r of rows) { obs.push([r.home, r.away, r.hs]); obs.push([r.away, r.home, r.as]); }
  const mu = obs.reduce((a, o) => a + o[2], 0) / obs.length;
  for (let it = 0; it < 60; it++) {
    for (const t of TEAMS) { const m = obs.filter((o) => o[0] === t); off[t] = m.reduce((a, o) => a + (o[2] - mu + def[o[1]]), 0) / m.length; }
    for (const t of TEAMS) { const m = obs.filter((o) => o[1] === t); def[t] = m.reduce((a, o) => a + -(o[2] - mu - off[o[0]]), 0) / m.length; }
    const mo = TEAMS.reduce((a, t) => a + off[t], 0) / TEAMS.length, md = TEAMS.reduce((a, t) => a + def[t], 0) / TEAMS.length;
    for (const t of TEAMS) { off[t] -= mo; def[t] -= md; }
  }
  const out = {};
  for (const t of TEAMS) out[t] = { rating: +(off[t] + def[t]).toFixed(2), off: +off[t].toFixed(2), def: +def[t].toFixed(2) };
  return { teams: out, mu: +mu.toFixed(2) };
}
const R = ratings();
if (ratingsOnly) {
  fs.writeFileSync(outPath, JSON.stringify({ season: model.season, week: model.target_week, through_week: model.through_week, generated: model.generated, ratings: R.teams }));
  console.log("ratings written for week", model.target_week); process.exit(0);
}

// ---------- 2. remaining games ----------
const played = [], remaining = [];
for (const g of model.schedule) (g.home_score != null ? played : remaining).push(g);
const margins = remaining.map((g, gi) => {
  const w = g.weather && g.weather.features ? g.weather.features : null;
  const out = new Int16Array(PER_GAME);
  const base = 9000 + gi * 7777;
  for (let i = 0; i < PER_GAME; i++) {
    const r = Sim.simulateGame(model, { away: g.away, home: g.home, seed: base + i, weather: w, neutral: g.neutral });
    out[i] = r.score.home - r.score.away;
  }
  return out;
});
const pHomeGame = margins.map((m) => { let h = 0; for (const x of m) h += x > 0 ? 1 : x === 0 ? 0.5 : 0; return h / m.length; });

// playoff games: normal margin around the ratings difference (sd fitted to the sims)
const HFA = 1.6, SD = 13.5;
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const pWin = (home, away, neutral) => 0.5 * (1 + erf((R.teams[home].rating - R.teams[away].rating + (neutral ? 0 : HFA)) / (SD * Math.SQRT2)));

// ---------- 3. seasons ----------
const zero = () => Object.fromEntries(TEAMS.map((t) => [t, 0]));
const acc = { playoff: zero(), div: zero(), seed1: zero(), conf: zero(), sb: zero(), sbApp: zero(), pick1: zero(), top5: zero(), wins: zero() };
const seedDist = Object.fromEntries(TEAMS.map((t) => [t, new Array(8).fill(0)]));  // 0 = missed
const winDist = Object.fromEntries(TEAMS.map((t) => [t, new Array(18).fill(0)]));

function blankRec() { return { w: 0, l: 0, t: 0, dw: 0, dl: 0, dt: 0, cw: 0, cl: 0, ct: 0, pf: 0, pa: 0, h2h: {} }; }
function addResult(rec, home, away, hs, as) {
  const H = rec[home], A = rec[away], sameDiv = divOf[home] === divOf[away], sameConf = confOf[home] === confOf[away];
  H.pf += hs; H.pa += as; A.pf += as; A.pa += hs;
  const res = hs > as ? 1 : hs < as ? -1 : 0;
  const mark = (X, r, opp) => {
    if (r > 0) { X.w++; if (sameDiv) X.dw++; if (sameConf) X.cw++; } else if (r < 0) { X.l++; if (sameDiv) X.dl++; if (sameConf) X.cl++; } else { X.t++; if (sameDiv) X.dt++; if (sameConf) X.ct++; }
    X.h2h[opp] = (X.h2h[opp] || 0) + r;
  };
  mark(H, res, away); mark(A, -res, home);
}
// current standings from played games
const base = Object.fromEntries(TEAMS.map((t) => [t, blankRec()]));
for (const g of played) if (base[g.home] && base[g.away]) addResult(base, g.home, g.away, g.home_score, g.away_score);
const clone = (r) => Object.fromEntries(Object.entries(r).map(([t, x]) => [t, Object.assign({}, x, { h2h: Object.assign({}, x.h2h) })]));
const pct = (w, l, t) => (w + l + t ? (w + 0.5 * t) / (w + l + t) : 0);

// simplified NFL tiebreakers: win %, head-to-head (2 teams), division record, conference record, point differential, coin flip
function rank(teams, rec, inDivision) {
  const key = (t) => pct(rec[t].w, rec[t].l, rec[t].t);
  const arr = teams.map((t) => ({ t, k: key(t), r: rng() }));
  arr.sort((a, b) => b.k - a.k);
  const out = [];
  for (let i = 0; i < arr.length;) {
    let j = i; while (j < arr.length && arr[j].k === arr[i].k) j++;
    const grp = arr.slice(i, j).map((x) => x.t);
    grp.sort((a, b) => {
      if (grp.length === 2) { const h = rec[a].h2h[b] || 0; if (h) return -h; }
      if (inDivision) { const d = pct(rec[b].dw, rec[b].dl, rec[b].dt) - pct(rec[a].dw, rec[a].dl, rec[a].dt); if (d) return d; }
      const c = pct(rec[b].cw, rec[b].cl, rec[b].ct) - pct(rec[a].cw, rec[a].cl, rec[a].ct); if (c) return c;
      const pd = (rec[b].pf - rec[b].pa) - (rec[a].pf - rec[a].pa); if (pd) return pd;
      return rng() - 0.5;
    });
    out.push(...grp); i = j;
  }
  return out;
}
function playoffGame(home, away, neutral) { return rng() < pWin(home, away, neutral) ? home : away; }

for (let s = 0; s < SEASONS; s++) {
  const rec = clone(base);
  remaining.forEach((g, gi) => {
    if (!rec[g.home] || !rec[g.away]) return;
    const m = margins[gi][Math.floor(rng() * PER_GAME)];
    const tot = 44; // totals only feed point differential; split margin around a typical total
    addResult(rec, g.home, g.away, (tot + m) / 2, (tot - m) / 2);
  });
  for (const t of TEAMS) { acc.wins[t] += rec[t].w + 0.5 * rec[t].t; winDist[t][Math.min(17, rec[t].w)]++; }
  const champs = {};
  for (const conf of ["AFC", "NFC"]) {
    const divWinners = [];
    for (const d in DIV) if (d.startsWith(conf)) { const w = rank(DIV[d].filter((t) => rec[t]), rec, true)[0]; divWinners.push(w); acc.div[w]++; }
    const dSeeds = rank(divWinners, rec, false);
    const others = TEAMS.filter((t) => confOf[t] === conf && !divWinners.includes(t));
    const wc = rank(others, rec, false).slice(0, 3);
    const seeds = [...dSeeds, ...wc];
    seeds.forEach((t, i) => { acc.playoff[t]++; seedDist[t][i + 1]++; });
    for (const t of TEAMS) if (confOf[t] === conf && !seeds.includes(t)) seedDist[t][0]++;
    acc.seed1[seeds[0]]++;
    // bracket: 2v7, 3v6, 4v5; then 1 vs lowest, others; conference final
    const seedOf = (t) => seeds.indexOf(t);
    let alive = [seeds[0], playoffGame(seeds[1], seeds[6]), playoffGame(seeds[2], seeds[5]), playoffGame(seeds[3], seeds[4])];
    alive.sort((a, b) => seedOf(a) - seedOf(b));
    const d1 = playoffGame(alive[0], alive[3]), d2 = playoffGame(alive[1], alive[2]);
    const [h, a] = seedOf(d1) < seedOf(d2) ? [d1, d2] : [d2, d1];
    champs[conf] = playoffGame(h, a);
    acc.conf[champs[conf]]++; acc.sbApp[champs[conf]]++;
  }
  acc.sb[playoffGame(champs.AFC, champs.NFC, true)]++;
  // draft: non-playoff teams by worst record (ties: coin flip)
  const order = TEAMS.slice().sort((a, b) => pct(rec[a].w, rec[a].l, rec[a].t) - pct(rec[b].w, rec[b].l, rec[b].t) || rng() - 0.5);
  acc.pick1[order[0]]++; order.slice(0, 5).forEach((t) => acc.top5[t]++);
}

const teams = {};
for (const t of TEAMS) {
  const b = base[t], rem = remaining.filter((g) => g.home === t || g.away === t);
  const remOppRating = rem.length ? rem.reduce((a, g) => a + R.teams[g.home === t ? g.away : g.home].rating, 0) / rem.length : 0;
  const expW = rem.reduce((a, g, i) => { const gi = remaining.indexOf(g); return a + (g.home === t ? pHomeGame[gi] : 1 - pHomeGame[gi]); }, 0);
  teams[t] = {
    conf: confOf[t], div: divOf[t], w: b.w, l: b.l, t: b.t, pf: b.pf, pa: b.pa, dw: b.dw, dl: b.dl,
    proj_w: +(acc.wins[t] / SEASONS).toFixed(2), exp_rest: +expW.toFixed(2), games_left: rem.length,
    playoff: +(acc.playoff[t] / SEASONS).toFixed(4), div_title: +(acc.div[t] / SEASONS).toFixed(4), seed1: +(acc.seed1[t] / SEASONS).toFixed(4),
    conf_title: +(acc.conf[t] / SEASONS).toFixed(4), sb: +(acc.sb[t] / SEASONS).toFixed(4),
    pick1: +(acc.pick1[t] / SEASONS).toFixed(4), top5: +(acc.top5[t] / SEASONS).toFixed(4),
    seeds: seedDist[t].map((x) => +(x / SEASONS).toFixed(4)), wins_dist: winDist[t].map((x) => +(x / SEASONS).toFixed(4)),
    rating: R.teams[t].rating, off: R.teams[t].off, def: R.teams[t].def, sos_rest: +remOppRating.toFixed(2),
    rest: rem.map((g) => { const gi = remaining.indexOf(g), home = g.home === t; return { w: g.week, opp: home ? g.away : g.home, home, neutral: !!g.neutral, p: +(home ? pHomeGame[gi] : 1 - pHomeGame[gi]).toFixed(3) }; }),
  };
}
fs.writeFileSync(outPath, JSON.stringify({ season: model.season, week: model.target_week, through_week: model.through_week, generated: model.generated,
  sims_per_game: PER_GAME, seasons: SEASONS, avg_points: R.mu, divisions: DIV, teams }));
console.log(`season: ${remaining.length} games left, ${SEASONS} seasons simulated`);
