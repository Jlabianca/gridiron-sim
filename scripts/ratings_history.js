// Merge this build's power ratings into the weekly history used for trend arrows.
//   node scripts/ratings_history.js <season.json or ratings file> site/data/ratings_history.json
// History is keyed by "through week" (ratings after week N's games). Re-running in the same week overwrites it.
const fs = require("fs");
const [src, histPath] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(src));
const h = fs.existsSync(histPath) ? JSON.parse(fs.readFileSync(histPath)) : { season: s.season, weeks: {} };
const model = s.through_week != null ? s : null;
const wk = String(s.through_week != null ? s.through_week : s.week - 1);
const r = s.ratings || Object.fromEntries(Object.entries(s.teams).map(([t, v]) => [t, { rating: v.rating, off: v.off, def: v.def }]));
h.weeks[wk] = Object.fromEntries(Object.entries(r).map(([t, v]) => [t, +v.rating.toFixed(2)]));
fs.writeFileSync(histPath, JSON.stringify(h));
console.log(`ratings history: weeks ${Object.keys(h.weeks).sort((a, b) => a - b).join(", ")}`);
