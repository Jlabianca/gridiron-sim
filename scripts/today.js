// "Today" page data: a plain-English preview for each upcoming game, the reasons behind the
// model's view, confidence labels, players to watch and the day's best bets.
//
//   node scripts/today.js site/data/model.json site/data/today.json [sims]
// Reads (if present) site/data/odds.json, edges.json, season.json and fantasy.json next to the model.
const fs = require("fs");
const path = require("path");
const Sim = require("../site/js/sim.js");
const [modelPath, outPath, nArg] = process.argv.slice(2);
const N = +nArg || 3000;
const dir = path.dirname(modelPath);
const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f))); } catch (e) { return null; } };
const model = JSON.parse(fs.readFileSync(modelPath));
const odds = load("odds.json"), edges = load("edges.json"), season = load("season.json"), fantasy = load("fantasy.json");

// ---------- labels (shared with the site: site/js/app.js uses the same thresholds) ----------
// Labels describe how far the model is from the book, not a guarantee.
function winLabel(p) { return p >= 0.7 ? "Strong" : p >= 0.58 ? "Lean" : "Toss-up"; }
function betLabel(b) {
  if (b.ev > 0.2 || b.out_in_model) return "Check";
  if (b.ev >= 0.1 && b.p - b.p_implied >= 0.06) return "Strong";
  if (b.ev >= 0.04) return "Lean";
  return "Pass";
}
const sideLabel = (p) => betLabel({ ev: p * (1 + 100 / 110) - 1, p, p_implied: 110 / 210 });   // at standard -110

function slim(b) {
  return { game: b.game, kind: b.kind, text: b.label, conf: b.conf, price: b.price, book: b.book, p: b.p, p_implied: b.p_implied, ev: b.ev,
    pid: b.pid || null, player: b.player || null, stat: b.stat || null, line: b.line, side: b.side, commence: b.commence };
}

// ---------- league ranks for matchup talk ----------
const TEAMS = Object.keys(model.teams);
function rankOf(team, side, key, highIsGood) {
  const vals = TEAMS.map((t) => [t, model.teams[t][side][key]]).sort((a, b) => (highIsGood ? b[1] - a[1] : a[1] - b[1]));
  return vals.findIndex((x) => x[0] === team) + 1;   // 1 = best
}
const ord = (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const rankWord = (r) => (r === 1 ? "the best" : r === 32 ? "the worst" : r <= 16 ? `${ord(r)}-best` : `${ord(33 - r)}-worst`);

function starters(team) {
  const T = model.teams[team];
  const qbs = T.players.filter((p) => p.pos === "QB" && p.db > 0).sort((a, b) => b.db - a.db);
  const usual = qbs[0];
  const active = T.players.filter((p) => p.pos === "QB" && !p.out).sort((a, b) => b.db - a.db)[0];
  const keyOut = T.players.filter((p) => p.out && !p.gone && p.pos !== "QB" && (p.rush_share >= 0.3 || p.tgt_share >= 0.15));
  return { usual, active, keyOut };
}

const now = Date.now();
const upcoming = model.schedule.filter((g) => g.home_score == null && model.teams[g.away] && model.teams[g.home])
  .filter((g) => { const t = new Date(`${g.date}T${g.time || "13:00"}:00-05:00`).getTime(); return t > now - 4 * 3600e3 && t < now + 8 * 86400e3; })
  .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));

const games = [];
for (const g of upcoming) {
  const A = g.away, H = g.home, gid = `${A}@${H}`;
  const w = g.weather && g.weather.features ? g.weather.features : null;
  const opts = { away: A, home: H, weather: w, neutral: g.neutral, seed: 4040 };
  const agg = Sim.simulateMany(model, opts, N);
  const n = agg.n, mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const pH = (agg.wins.home + agg.wins.tie / 2) / n, pA = 1 - pH;
  const ptsA = mean(agg.away), ptsH = mean(agg.home), margin = ptsH - ptsA, total = ptsA + ptsH;
  // market: live lines if we have them, else the schedule's closing lines
  const o = odds && odds.games && odds.games[gid];
  const spreadHome = o && o.spread_home != null ? o.spread_home : g.spread != null ? -g.spread : null;   // home line, e.g. -3.5
  const totalLine = o && o.total != null ? o.total : g.total;
  const marg = agg.home.map((h, i) => h - agg.away[i]), tot = agg.home.map((h, i) => h + agg.away[i]);
  let spreadPick = null, totalPick = null;
  if (spreadHome != null) {
    const cover = marg.filter((m) => m + spreadHome > 0).length / n, push = marg.filter((m) => m + spreadHome === 0).length / n;
    const pHomeCov = cover / (1 - push || 1);
    const side = pHomeCov >= 0.5 ? H : A, p = Math.max(pHomeCov, 1 - pHomeCov), line = side === H ? spreadHome : -spreadHome;
    spreadPick = { team: side, line, p: +p.toFixed(3), label: sideLabel(p) };
  }
  if (totalLine != null) {
    const pO = tot.filter((t) => t > totalLine).length / n, pU = tot.filter((t) => t < totalLine).length / n;
    const side = pO >= pU ? "over" : "under", p = Math.max(pO, pU) / ((pO + pU) || 1);
    totalPick = { side, line: totalLine, p: +p.toFixed(3), label: sideLabel(p) };
  }
  const fav = pH >= 0.5 ? H : A, dog = fav === H ? A : H, pFav = Math.max(pH, pA);

  // ---------- reasons ----------
  const reasons = [];
  const R = season && season.teams;
  if (R && R[A] && R[H]) {
    const ra = R[A].rating, rh = R[H].rating, gap = Math.abs(rh - ra);
    if (gap >= 1.5) {
      const better = rh > ra ? H : A;
      reasons.push({ icon: "📈", kind: "strength", text: `${better} rates ${gap.toFixed(1)} points better than ${better === H ? A : H} on a neutral field (power ratings).`, weight: gap });
    } else reasons.push({ icon: "📈", kind: "strength", text: `These teams rate almost evenly (within ${gap.toFixed(1)} points), so small edges decide it.`, weight: 0.5 });
  }
  for (const [off, def] of [[A, H], [H, A]]) {
    const rRun = rankOf(off, "off", "ypr", true), dRun = rankOf(def, "def", "ypr", false);  // dRun 32 = allows most
    if (rRun <= 10 && dRun >= 23) reasons.push({ icon: "🏃", kind: "matchup", text: `${off}'s run game (${rankWord(rRun)} in yards per carry) faces a ${def} defense that's ${rankWord(dRun)} against the run.`, weight: 2 });
    if (rRun >= 23 && dRun <= 10) reasons.push({ icon: "🧱", kind: "matchup", text: `${off} struggles to run (${rankWord(rRun)} in yards per carry) and ${def} is ${rankWord(dRun)} against the run.`, weight: 1.6 });
    const rPass = rankOf(off, "off", "ypc", true), dPass = rankOf(def, "def", "ypc", false);
    if (rPass <= 10 && dPass >= 23) reasons.push({ icon: "🎯", kind: "matchup", text: `${off}'s passing game (${rankWord(rPass)} in yards per catch) gets a ${def} pass defense that's ${rankWord(dPass)}.`, weight: 2 });
    if (rPass >= 23 && dPass <= 10) reasons.push({ icon: "🛡️", kind: "matchup", text: `${def}'s pass defense (${rankWord(dPass)}) should limit a ${off} passing game that ranks ${rankWord(rPass)}.`, weight: 1.6 });
    const sackO = rankOf(off, "off", "sack_rate", false), sackD = rankOf(def, "def", "sack_rate", true);
    if (sackO >= 25 && sackD <= 8) reasons.push({ icon: "💥", kind: "matchup", text: `${off} gives up a lot of sacks (${rankWord(sackO)}) and ${def}'s pass rush is ${rankWord(sackD)}.`, weight: 1.4 });
  }
  const qbNotes = [];
  for (const t of [A, H]) {
    const s = starters(t);
    if (s.usual && s.active && s.usual.id !== s.active.id) {
      qbNotes.push({ team: t, out: s.usual.name, in: s.active.name });
      reasons.push({ icon: "🧢", kind: "qb", text: `${t} is expected to start ${s.active.name} instead of ${s.usual.name}${s.usual.status ? ` (${s.usual.status.toLowerCase()})` : ""}, which drags down their passing numbers.`, weight: 3 });
    }
    if (s.keyOut.length) reasons.push({ icon: "🚑", kind: "injury", text: `${t} is without ${s.keyOut.slice(0, 2).map((p) => `${p.name} (${p.pos}${p.status ? ", " + p.status.toLowerCase() : ""})`).join(" and ")}; the model shifts their touches to teammates.`, weight: 1.8 });
  }
  let wxImpact = null;
  if (w && (w.wind >= 5 || w.rain >= 0.4 || w.snow > 0 || w.cold >= 12)) {
    const calm = Sim.winProb(model, Object.assign({}, opts, { weather: null, seed: 4041 }), 1500).total;
    const wet = Sim.winProb(model, Object.assign({}, opts, { seed: 4041 }), 1500).total;
    wxImpact = +(wet - calm).toFixed(1);
    const bits = []; if (g.weather.wind != null && w.wind > 0) bits.push(`${g.weather.wind} mph wind`); if (w.rain >= 0.4) bits.push("rain"); if (w.snow > 0) bits.push("snow"); if (w.cold >= 12) bits.push(`${g.weather.temp}°F`);
    reasons.push({ icon: "🌧️", kind: "weather", text: `${bits.join(", ").replace(/^./, (c) => c.toUpperCase())} in the forecast: about ${Math.abs(wxImpact).toFixed(1)} points ${wxImpact < 0 ? "off" : "added to"} the projected total.`, weight: Math.min(3, Math.abs(wxImpact) / 2) });
  }
  if (!g.neutral) reasons.push({ icon: "🏟️", kind: "home", text: `${H} gets home field, worth about a point and a half.`, weight: 0.4 });
  if (spreadHome != null) {
    const mktMargin = -spreadHome, diff = margin - mktMargin;
    const by = (m) => (Math.abs(m) < 0.5 ? "even" : `${m > 0 ? H : A} by ${Math.abs(m).toFixed(1).replace(/\.0$/, "")}`);
    if (Math.abs(diff) >= 2.5) reasons.push({ icon: "📊", kind: "market", text: `The model has ${by(margin)}; the market has ${by(mktMargin)}. That's a ${Math.abs(diff).toFixed(1)}-point difference in ${diff > 0 ? H : A}'s favor.`, weight: Math.abs(diff) / 2 });
  }
  reasons.sort((a, b) => b.weight - a.weight);

  // ---------- plain-English preview ----------
  const sc = (x) => x.toFixed(0);
  let text = pFav >= 0.58
    ? `The model likes ${fav} to win (${Math.round(pFav * 100)}%) and projects ${A} ${sc(ptsA)}, ${H} ${sc(ptsH)}.`
    : `Close to a coin flip: the model has ${fav} at ${Math.round(pFav * 100)}% and projects ${A} ${sc(ptsA)}, ${H} ${sc(ptsH)}.`;
  text += "{{SPREAD}}";
  const top = reasons.filter((r) => r.kind !== "home" && r.kind !== "market")[0];
  if (top) text += " " + top.text;
  const wxR = reasons.find((r) => r.kind === "weather");
  if (wxR && wxR !== top) text += " " + wxR.text;

  // ---------- players to watch ----------
  const watch = [];
  if (fantasy) {
    const fp = fantasy.players.filter((p) => p.game === gid && p.pos !== "K" && p.pos !== "DST").sort((a, b) => b.mean.ppr - a.mean.ppr);
    for (const t of [A, H]) for (const p of fp.filter((x) => x.team === t).slice(0, 2)) watch.push({ id: p.id, name: p.name, team: t, pos: p.pos, ppr: p.mean.ppr });
  }
  const gameBets = edges ? edges.bets.filter((b) => b.game === gid).map((b) => ({ ...b, conf: betLabel(b) })) : [];
  const bestBet = gameBets.filter((b) => b.conf === "Strong" || b.conf === "Lean").sort((a, b) => b.ev - a.ev)[0] || null;
  if (spreadPick) { const m = gameBets.find((b) => b.kind === "spread" && b.side === spreadPick.team); if (m) { spreadPick.label = m.conf; spreadPick.price = m.price; spreadPick.book = m.book; } }
  if (totalPick) { const m = gameBets.find((b) => b.kind === "total" && b.side === totalPick.side); if (m) { totalPick.label = m.conf; totalPick.price = m.price; totalPick.book = m.book; } }

  let st = "";
  if (spreadPick && (spreadPick.label === "Strong" || spreadPick.label === "Lean")) st = ` Against the spread it ${spreadPick.label === "Strong" ? "likes" : "leans"} ${spreadPick.team} ${spreadPick.line > 0 ? "+" : ""}${spreadPick.line}.`;
  else if (spreadPick && spreadPick.label === "Check") st = ` It differs a lot from the spread (${spreadPick.team} ${spreadPick.line > 0 ? "+" : ""}${spreadPick.line}), so check the news before trusting it.`;
  else if (spreadPick) st = ` It's close to the market on the spread, so no strong side.`;
  text = text.replace("{{SPREAD}}", st);
  games.push({
    game: gid, away: A, home: H, date: g.date, time: g.time, stadium: g.stadium, neutral: !!g.neutral,
    weather: g.weather || null, wx_impact: wxImpact,
    p_home: +pH.toFixed(3), pts_away: +ptsA.toFixed(1), pts_home: +ptsH.toFixed(1), total: +total.toFixed(1),
    winner: { team: fav, p: +pFav.toFixed(3), label: winLabel(pFav) },
    spread: spreadPick, total_pick: totalPick, market: { spread_home: spreadHome, total: totalLine, live: !!o },
    preview: text, reasons: reasons.slice(0, 6).map(({ icon, kind, text: t }) => ({ icon, kind, text: t })),
    qb_changes: qbNotes, watch, best_bet: bestBet && slim(bestBet),
  });
}

// ---------- best bets across the slate ----------
let best = [];
if (edges) {
  best = edges.bets.filter((b) => upcoming.some((g) => `${g.away}@${g.home}` === b.game))
    .map((b) => ({ ...b, conf: betLabel(b) }))
    .filter((b) => b.conf === "Strong" || b.conf === "Lean")
    .sort((a, b) => (a.conf === b.conf ? b.ev - a.ev : a.conf === "Strong" ? -1 : 1));
  const seen = new Set();   // at most one bet per game, so the list covers the slate
  best = best.filter((b) => { if (seen.has(b.game)) return false; seen.add(b.game); return true; }).slice(0, 6);
}
fs.writeFileSync(outPath, JSON.stringify({ generated: model.generated, week: model.target_week, sims: N, lines_updated: odds ? odds.updated : null, games, best_bets: best.map(slim) }));
console.log(`today: ${games.length} games previewed, ${best.length} best bets`);
