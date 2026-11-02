/* Runs simulations off the main thread: projections (many games) and win-probability series. */
importScripts("sim.js");
let model = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.model) model = m.model;
  if (m.run) {
    const agg = NFLSim.simulateMany(model, m.opts, m.n, (p) => self.postMessage({ progress: p }));
    self.postMessage({ done: true, result: NFLSim.summarize(agg) });
  }
  if (m.wp) {   // win probability before each play of a replayed game
    const out = [];
    m.wp.states.forEach((st, i) => {
      const r = NFLSim.winProb(model, Object.assign({}, m.wp.opts, { start: st, seed: 1000 + i * 31 }), m.wp.n);
      out.push(r.home);
      if (i % 8 === 7 || i === m.wp.states.length - 1) self.postMessage({ wpId: m.wp.id, wp: out.slice(), total: m.wp.states.length });
    });
  }
};
