/* Runs many simulations off the main thread and returns compact per-player distributions. */
importScripts("sim.js");
let model = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.model) model = m.model;
  if (!m.run) return;
  const agg = NFLSim.simulateMany(model, m.opts, m.n, (p) => self.postMessage({ progress: p }));
  self.postMessage({ done: true, result: summarize(agg) });
};
function summarize(agg) {
  const players = {};
  for (const id in agg.players) {
    const p = agg.players[id], s = p.stats, n = agg.n;
    const rry = new Array(n), td = new Array(n);
    for (let i = 0; i < n; i++) { rry[i] = s.ry[i] + s.recy[i]; td[i] = s.rtd[i] + s.rectd[i]; }
    const out = { id, name: p.name, short: p.short, pos: p.pos, team: p.team, d: {} };
    for (const k of ["py", "pc", "ptd", "pint", "ra", "ry", "rec", "recy", "pts"]) out.d[k] = Int16Array.from(s[k]).sort();
    out.d.rry = Int16Array.from(rry).sort();
    out.d.td = Int16Array.from(td).sort();
    players[id] = out;
  }
  return { n: agg.n, away: agg.away, home: agg.home, wins: agg.wins, players };
}
