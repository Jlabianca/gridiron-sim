/* Runs many simulations off the main thread and returns compact per-player distributions. */
importScripts("sim.js");
let model = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.model) model = m.model;
  if (!m.run) return;
  const agg = NFLSim.simulateMany(model, m.opts, m.n, (p) => self.postMessage({ progress: p }));
  self.postMessage({ done: true, result: NFLSim.summarize(agg) });
};
