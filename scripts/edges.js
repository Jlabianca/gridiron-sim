// Edge board: simulate every game that has sportsbook lines and compare the model's
// probabilities with the best available price.
//
//   node scripts/edges.js site/data/model.json site/data/odds.json site/data/edges.json [sims]
const fs = require("fs");
const Sim = require("../site/js/sim.js");
const [modelPath, oddsPath, outPath, nArg] = process.argv.slice(2);
const N = +nArg || 10000;
if (!fs.existsSync(oddsPath)) { console.log("edges: no odds file, skipping"); process.exit(0); }
const model = JSON.parse(fs.readFileSync(modelPath));
const odds = JSON.parse(fs.readFileSync(oddsPath));

const STAT = { player_pass_yds: "py", player_rush_yds: "ry", player_reception_yds: "recy", player_receptions: "rec",
  player_anytime_td: "td", player_pass_tds: "ptd", player_pass_completions: "pc", player_rush_attempts: "ra",
  player_pass_interceptions: "pint", player_rush_reception_yds: "rry" };
const LABEL = { py: "pass yds", ry: "rush yds", recy: "rec yds", rec: "receptions", td: "anytime TD", ptd: "pass TDs",
  pc: "completions", ra: "rush att", pint: "INTs", rry: "rush+rec yds" };
const norm = (s) => String(s || "").toLowerCase().replace(/[.'’-]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
const dec = (a) => (a == null ? null : a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const implied = (a) => (a == null ? null : 1 / dec(a));

const bets = [], games = [];
const now = Date.now();
for (const gid in odds.games) {
  const o = odds.games[gid];
  if (new Date(o.commence).getTime() < now - 3600e3) continue; // already started
  const sg = model.schedule.find((g) => g.away === o.away && g.home === o.home && g.home_score == null);
  if (!model.teams[o.away] || !model.teams[o.home]) continue;
  const weather = sg && sg.weather && sg.weather.features ? sg.weather.features : null;
  const agg = Sim.simulateMany(model, { away: o.away, home: o.home, seed: 777, weather }, N);
  const res = Sim.summarize(agg);
  const n = res.n;
  const margin = res.home.map((h, i) => h - res.away[i]);
  const total = res.home.map((h, i) => h + res.away[i]);
  const frac = (f) => { let c = 0; for (let i = 0; i < n; i++) if (f(i)) c++; return c / n; };
  const add = (b) => {
    if (b.price == null || b.p == null) return;
    const d = dec(b.price), pp = b.p_push || 0;
    b.ev = +(b.p * d + pp - 1).toFixed(4);
    b.p_implied = +implied(b.price).toFixed(4);
    b.p = +b.p.toFixed(4);
    b.game = gid; b.commence = o.commence;
    bets.push(b);
  };
  const pHome = frac((i) => margin[i] > 0) + frac((i) => margin[i] === 0) / 2;
  add({ kind: "ml", label: `${o.away} moneyline`, side: o.away, price: o.ml_away, book: o.ml_away_book, p: 1 - pHome });
  add({ kind: "ml", label: `${o.home} moneyline`, side: o.home, price: o.ml_home, book: o.ml_home_book, p: pHome });
  if (o.spread_home != null) {
    const s = o.spread_home; // home line, e.g. -3.5
    const pHomeCov = frac((i) => margin[i] + s > 0), pPush = frac((i) => margin[i] + s === 0);
    const fmt = (x) => (x > 0 ? "+" + x : "" + x);
    add({ kind: "spread", label: `${o.home} ${fmt(s)}`, side: o.home, line: s, price: o.spread_home_price, book: o.spread_home_book, p: pHomeCov, p_push: pPush });
    add({ kind: "spread", label: `${o.away} ${fmt(-s)}`, side: o.away, line: -s, price: o.spread_away_price, book: o.spread_away_book, p: 1 - pHomeCov - pPush, p_push: pPush });
  }
  if (o.total != null) {
    const pO = frac((i) => total[i] > o.total), pP = frac((i) => total[i] === o.total);
    add({ kind: "total", label: `Over ${o.total}`, side: "over", line: o.total, price: o.over_price, book: o.over_book, p: pO, p_push: pP });
    add({ kind: "total", label: `Under ${o.total}`, side: "under", line: o.total, price: o.under_price, book: o.under_book, p: 1 - pO - pP, p_push: pP });
  }
  // player props
  const byName = {};
  for (const p of Object.values(res.players)) byName[norm(p.name)] = p;
  for (const t of [o.away, o.home]) for (const p of model.teams[t].players) if (!byName[norm(p.name)]) byName[norm(p.name)] = { name: p.name, team: t, pos: p.pos, missing: true, out: p.out };
  let matched = 0, unmatched = [];
  for (const pr of o.props || []) {
    const k = STAT[pr.market], p = byName[norm(pr.player)];
    if (!k) continue;
    if (!p) { unmatched.push(pr.player); continue; }
    matched++;
    const arr = p.r ? p.r[k] : null;          // null = player not in the sim (ruled out / not used)
    const at = (i) => (arr ? arr[i] : 0);
    const base = { kind: "prop", player: p.name, team: p.team, pos: p.pos, stat: k, line: pr.line, out_in_model: !arr };
    if (k === "td") {
      add(Object.assign({}, base, { label: `${p.name} anytime TD`, side: "yes", price: pr.over_price, book: pr.over_book, p: frac((i) => at(i) >= 1) }));
      continue;
    }
    const pO = frac((i) => at(i) > pr.line), pP = frac((i) => at(i) === pr.line);
    const med = arr ? Array.from(arr).sort((a, b) => a - b)[Math.floor(n / 2)] : 0;
    add(Object.assign({}, base, { label: `${p.name} over ${pr.line} ${LABEL[k]}`, side: "over", median: med, price: pr.over_price, book: pr.over_book, p: pO, p_push: pP }));
    add(Object.assign({}, base, { label: `${p.name} under ${pr.line} ${LABEL[k]}`, side: "under", median: med, price: pr.under_price, book: pr.under_book, p: 1 - pO - pP, p_push: pP }));
  }
  games.push({ game: gid, away: o.away, home: o.home, commence: o.commence, props_updated: o.props_updated || null,
    lines_updated: o.lines_updated, props: (o.props || []).length, matched, unmatched: unmatched.slice(0, 20),
    p_home: +pHome.toFixed(4), proj_total: +(total.reduce((a, b) => a + b, 0) / n).toFixed(1),
    proj_margin: +(margin.reduce((a, b) => a + b, 0) / n).toFixed(1) });
}
bets.sort((a, b) => b.ev - a.ev);
fs.writeFileSync(outPath, JSON.stringify({ updated: odds.updated, model_built: model.generated, sims: N,
  credits_remaining: odds.credits_remaining, games, bets }));
console.log(`edges: ${games.length} games, ${bets.length} priced bets, ${bets.filter((b) => b.ev > 0.05).length} with EV > 5%`);
