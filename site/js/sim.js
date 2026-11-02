/* NFL play-by-play game simulator.
 * Works in the browser (window.NFLSim), in a Web Worker (self.NFLSim) and in Node (module.exports).
 * All rates come from data/model.json, built by scripts/build_data.py from nflverse data.
 * Yardline convention: `yl` = yards from the offense to the opponent's end zone (nflverse yardline_100).
 */
(function (root) {
  "use strict";

  // ---------- random helpers ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  function log5(o, d, l) {
    const x = (o * d) / l, y = ((1 - o) * (1 - d)) / (1 - l);
    return x / (x + y);
  }
  function pickWeighted(rand, items, key) {
    let tot = 0;
    for (const it of items) tot += it[key];
    if (tot <= 0) return items[0];
    let r = rand() * tot;
    for (const it of items) { r -= it[key]; if (r <= 0) return it; }
    return items[items.length - 1];
  }
  const sample = (rand, arr) => arr[Math.floor(rand() * arr.length)];

  function distBucket(d) { return d <= 2 ? 0 : d <= 5 ? 1 : d <= 9 ? 2 : d === 10 ? 3 : 4; }
  function fourthDist(d) { return d <= 1 ? 0 : d <= 3 ? 1 : d <= 6 ? 2 : 3; }

  // ---------- team preparation ----------
  function prepTeam(model, abbr, outIds, qbId) {
    const T = model.teams[abbr];
    if (!T) throw new Error("No data for team " + abbr);
    const L = model.league;
    const active = T.players.filter((p) => !outIds.has(p.id));
    const qbs = active.filter((p) => p.pos === "QB" && p.db > 0).sort((a, b) => b.db - a.db);
    const chosen = qbId ? T.players.find((p) => p.id === qbId) : null;
    const qb = chosen || qbs[0] || active.find((p) => p.pos === "QB") || { id: abbr + "-QB", name: abbr + " QB", short: abbr + " QB", pos: "QB", rush_y: [], rec_y: [] };
    // QB adjustment: this QB's own rates vs. the QB mix behind the team's recent passing numbers
    const qr = qb.qb || L.qb_backup, mix = T.off.qb_mix || qr;
    const qbAdj = qr && mix ? {
      sack: qr.sack - mix.sack, scramble: qr.scramble - mix.scramble, comp: qr.comp - mix.comp, int: qr.int - mix.int,
      ypcF: clamp(qr.ypc / mix.ypc, 0.8, 1.2),
    } : { sack: 0, scramble: 0, comp: 0, int: 0, ypcF: 1 };
    const rushers = active.filter((p) => p.rush_share > 0);
    const targets = active.filter((p) => p.tgt_share > 0 && p.id !== qb.id);
    const o = T.off;
    const rushMean = mean(o.rush_yards.filter((y) => y > 0)) || 5;
    const compMean = mean(o.comp_yards.filter((y) => y > 0)) || 11;
    return {
      abbr, T, qb, qbAdj, rushers, targets, kicker: T.kicker,
      // rescale raw samples so the mean matches the shrunk team rate
      rushScale: clamp(o.ypr / (mean(o.rush_yards) || L.ypr), 0.8, 1.25),
      compScale: clamp(o.ypc / (mean(o.comp_yards) || L.ypc), 0.8, 1.25),
      rushMean, compMean,
    };
  }

  // weather: features {wind, cold, rain, snow} (0 indoors) times effects fitted from 2018+ play-by-play
  function weatherDeltas(L, f) {
    const W = L.weather, z = { pass: 0, sack: 0, comp: 0, int: 0, compYdsF: 1, rushYdsF: 1, fumble: 0, fg: 0, xp: 0 };
    if (!W || !f) return z;
    const dot = (k) => { const e = W.effects[k] || {}; let s = 0; for (const n in e) s += e[n] * (f[n] || 0); return s; };
    z.pass = dot("pass_rate") / 0.2436;              // probability change -> logit change around p ~ 0.58
    z.sack = dot("sack_rate"); z.comp = dot("comp_rate"); z.int = dot("int_rate"); z.fumble = dot("fumble_rate");
    z.compYdsF = clamp(1 + dot("comp_yards") / (W.base.comp_yards || 11), 0.7, 1.15);
    z.rushYdsF = clamp(1 + dot("rush_yards") / (W.base.rush_yards || 4.3), 0.7, 1.15);
    z.fg = dot("fg_logit"); z.xp = dot("xp_logit");
    return z;
  }

  function matchup(model, off, def, isHome, neutral, wd) {
    const L = model.league, o = off.T.off, d = def.T.def, q = off.qbAdj;
    const h = neutral ? 1 : (L.home_yds || 1);
    const hfa = isHome ? h : 1 / h;
    const r = (x) => clamp(x, 0.002, 0.95);
    return {
      sack: r(log5(r(o.sack_rate + q.sack), d.sack_rate, L.sack_rate) + wd.sack),
      scramble: r(log5(r(o.scramble_rate + q.scramble), d.scramble_rate, L.scramble_rate)),
      int: r(log5(r(o.int_rate + q.int), d.int_rate, L.int_rate) + wd.int),
      comp: r(log5(r(o.comp_rate + q.comp), d.comp_rate, L.comp_rate) + wd.comp),
      compYdsF: clamp(d.ypc / L.ypc, 0.8, 1.25) * (L.yds_scale || 1) * hfa * q.ypcF * wd.compYdsF,
      rushYdsF: clamp(d.ypr / L.ypr, 0.8, 1.25) * (L.yds_scale || 1) * hfa * wd.rushYdsF,
      passOE: o.pass_oe + 0.5 * d.pass_oe + wd.pass,
    };
  }

  function defaultOut(model, abbrs) {
    const ids = [];
    for (const a of abbrs) for (const p of model.teams[a].players) if (p.out) ids.push(p.id);
    return ids;
  }
  function zoneOf(yl) { return yl <= 5 ? 0 : yl <= 10 ? 1 : yl <= 20 ? 2 : yl <= 30 ? 3 : yl <= 40 ? 4 : -1; }

  // ---------- one game ----------
  function simulateGame(model, opts) {
    const rand = mulberry32(opts.seed == null ? (Math.random() * 2 ** 32) >>> 0 : opts.seed);
    const L = model.league;
    const outIds = new Set(opts.out || defaultOut(model, [opts.away, opts.home]));
    const log = !!opts.log;
    const qbPick = opts.qb || {};
    const teams = { away: prepTeam(model, opts.away, outIds, qbPick.away), home: prepTeam(model, opts.home, outIds, qbPick.home) };
    const wd = weatherDeltas(L, opts.weather);
    const mu = { away: matchup(model, teams.away, teams.home, false, opts.neutral, wd), home: matchup(model, teams.home, teams.away, true, opts.neutral, wd) };
    const fumRush = clamp(L.fumble_rate_rush + wd.fumble, 0.001, 0.05);
    const other = (s) => (s === "home" ? "away" : "home");

    const score = { away: 0, home: 0 };
    const qscore = { away: [0, 0, 0, 0], home: [0, 0, 0, 0] };
    const box = {};
    const plays = [], drives = [];
    const tstats = { away: { yds: 0, top: 0, to: 0, plays: 0 }, home: { yds: 0, top: 0, to: 0, plays: 0 } };

    function stat(team, p) {
      if (!p) return null;
      let s = box[p.id];
      if (!s) s = box[p.id] = { id: p.id, name: p.name, short: p.short, pos: p.pos || "", team: teams[team].abbr,
        pa: 0, pc: 0, py: 0, ptd: 0, pint: 0, sk: 0, ra: 0, ry: 0, rtd: 0, tg: 0, rec: 0, recy: 0, rectd: 0,
        fga: 0, fgm: 0, xpa: 0, xpm: 0, pts: 0 };
      return s;
    }

    // game state
    let qtr = 1, secs = 900;
    let pos, yl, down, togo;
    const timeouts = { away: 3, home: 3 };
    let openingReceiver = rand() < 0.5 ? "away" : "home";
    let force4th = opts.force4th || null;   // "go" | "fg" | "punt": decision for the first play if it's 4th down
    let firstOutcome = null;
    let drive = null;
    let gameOver = false;
    let ot = null; // {poss:{away,home}}

    const halfSecs = () => (qtr === 2 || qtr === 4 ? secs : qtr === 1 || qtr === 3 ? secs + 900 : secs);
    const diff = (s) => score[s] - score[other(s)];
    const clockStr = () => Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");

    function addPts(side, pts, p) {
      score[side] += pts;
      qscore[side][Math.min(qtr, 5) - 1] = (qscore[side][Math.min(qtr, 5) - 1] || 0) + pts;
    }

    function record(entry) {
      if (!log) return;
      entry.q = qtr; entry.clock = clockStr(); entry.secs = secs; entry.score = [score.away, score.home];
      entry.to = { away: timeouts.away, home: timeouts.home };
      entry.drive = drives.length;
      plays.push(entry);
    }

    function startDrive(side, startYl, how) {
      pos = side; yl = startYl; down = 1; togo = Math.min(10, yl);
      drive = { n: drives.length + 1, team: side, start: startYl, how, plays: 0, yds: 0, q: qtr, clock: clockStr(), result: null, t0: halfSecsAbs() };
      drives.push(drive);
      if (ot) {
        if (ot.poss.away >= 1 && ot.poss.home >= 1 && score.away !== score.home) { endGame(); return; }
        ot.poss[side]++;
        ot.bothAtStart = ot.poss.away >= 1 && ot.poss.home >= 1 && !(ot.poss[side] === 1 && ot.poss[other(side)] === 0);
      }
    }
    function halfSecsAbs() { return (qtr - 1) * 900 + (900 - secs); }
    function endDrive(result) {
      if (!drive || drive.result) return;
      drive.result = result;
      const dt = halfSecsAbs() - drive.t0;
      tstats[drive.team].top += Math.max(0, dt);
    }
    function endGame() { gameOver = true; endDrive(drive && !drive.result ? "End of game" : drive && drive.result); }

    function kickoff(kicking, how) {
      const receiving = other(kicking);
      const start = clamp(sample(rand, L.kickoff_start), 1, 99);
      runClock(5, false);
      record({ type: "kickoff", pos: receiving, yl: start, ylEnd: start, yards: 0,
        desc: teams[kicking].kicker.short + " kicks off; " + teams[receiving].abbr + " ball at " + ylText(receiving, start) + "." });
      if (!gameOver) startDrive(receiving, start, how || "Kickoff");
    }

    function ylText(side, y) {
      if (y === 50) return "50";
      return y > 50 ? teams[side].abbr + " " + (100 - y) : teams[other(side)].abbr + " " + y;
    }

    // clock handling incl. 2-minute warning, quarter ends
    function runClock(dt, mayStopAtWarning = true) {
      const before = secs;
      secs = Math.max(0, secs - Math.round(dt));
      if ((qtr === 2 || qtr === 4) && before > 120 && secs < 120) secs = 120;
    }

    function quarterCheck() {
      if (secs > 0) return;
      if (qtr === 1 || qtr === 3) { qtr++; secs = 900; return; }
      if (qtr === 2) {
        endDrive("End of half");
        qtr = 3; secs = 900; timeouts.away = timeouts.home = 3;
        kickoff(openingReceiver, "Second-half kickoff");
        return;
      }
      if (qtr === 4) {
        endDrive("End of game");
        if (score.away === score.home && opts.overtime !== false) {
          qtr = 5; secs = 600; ot = { poss: { away: 0, home: 0 } };
          timeouts.away = timeouts.home = 2;
          kickoff(rand() < 0.5 ? "away" : "home", "OT kickoff");
          return;
        }
        endGame(); return;
      }
      if (qtr === 5) { endDrive("End of game"); endGame(); }
    }

    function scoreTD(side, p, how) {
      addPts(side, 6);
      endDrive("Touchdown");
      // extra point (kick)
      const k = teams[side].kicker;
      const ks = stat(side, k);
      ks.xpa++;
      let good = rand() < shiftP(L.xp_make, wd.xp);
      if (good) { addPts(side, 1); ks.xpm++; ks.pts += 1; }
      if (log) plays[plays.length - 1].xp = good;
      if (ot && ot.bothAtStart) { endGame(); return; }
      afterScore(side);
    }

    function afterScore(side) {
      if (secs <= 0 && (qtr === 2 || qtr >= 4)) { quarterCheck(); return; }
      if (secs <= 0) quarterCheck();
      kickoff(side);
    }

    function changePossession(newSide, newYl, result) {
      endDrive(result);
      if (newYl >= 100) newYl = 99; if (newYl <= 0) newYl = 1;
      startDrive(newSide, newYl, result);
    }

    function clockAfterPlay(incomplete, outOfPlayStop) {
      const hs = halfSecs();
      const lead = diff(pos);
      let dt;
      if (incomplete || outOfPlayStop) dt = L.clock_incomplete + rand() * 2;
      else if (hs <= 120 && (qtr === 2 || lead <= 0)) dt = sample(rand, L.clock_hurry);
      else if (qtr >= 4 && lead > 0) dt = sample(rand, L.clock_milk);
      else dt = sample(rand, L.clock_neutral) * teams[pos].T.off.pace * (L.clock_scale || 1);
      // defense uses timeouts late when trailing
      const d = other(pos);
      if (!incomplete && (qtr === 4 || qtr === 2) && secs <= 120 && timeouts[d] > 0 && diff(d) < 0 && dt > 8) {
        timeouts[d]--; dt = 6;
      } else if (!incomplete && (qtr === 4 || qtr === 2) && secs <= 60 && timeouts[pos] > 0 && lead <= 0 && dt > 8 && secs - dt < 30) {
        timeouts[pos]--; dt = 6;
      }
      tstats[pos].plays++;
      runClock(dt);
    }

    function passProb() {
      const hs = halfSecs(), sd = diff(pos);
      let sb = 0;
      if (hs <= 120) sb = 3;
      else if (qtr >= 3 && sd >= 9) sb = 1;
      else if (qtr >= 3 && sd <= -9) sb = 2;
      else if (qtr >= 4 && sd > 0) sb = 1;
      else if (qtr >= 4 && sd < 0) sb = 2;
      const dn = Math.min(down, 3) - 1;
      let x = L.pass_base[dn][distBucket(togo)] + L.pass_script[sb] + mu[pos].passOE;
      if (yl <= 2) x -= 0.6; // goal-line run tendency
      return sigmoid(x);
    }

    const shiftP = (p, dl) => (dl ? sigmoid(Math.log(p / (1 - p)) + dl) : p);
    function fgMake(dist) {
      const i = clamp(Math.floor((dist - 18) / 5), 0, L.fg_make.length - 1);
      return dist > 68 ? 0.02 : shiftP(clamp(L.fg_make[i], 0.01, 0.995), wd.fg);
    }

    function attemptFG() {
      const side = pos, dist = yl + 17;
      const k = teams[side].kicker, ks = stat(side, k);
      ks.fga++;
      const made = rand() < fgMake(dist);
      runClock(5, false);
      if (made) {
        ks.fgm++; ks.pts += 3; addPts(side, 3);
        record({ type: "field_goal", pos: side, yl, ylEnd: 0, yards: 0, player: k.short, made: true, scoring: "FG",
          desc: k.short + " " + dist + "-yard field goal is GOOD." });
        endDrive("Field goal");
        if (ot && ot.bothAtStart) { endGame(); return; }
        afterScore(side);
      } else {
        record({ type: "field_goal", pos: side, yl, ylEnd: yl, yards: 0, player: k.short, made: false,
          desc: k.short + " " + dist + "-yard field goal is NO GOOD." });
        const spot = yl + 7;
        changePossession(other(side), spot <= 20 ? 80 : 100 - spot, "Missed FG");
      }
    }

    function punt() {
      const side = pos;
      const b = String(clamp(Math.floor((yl - 1) / 10), 0, 9));
      const opts2 = L.punt_start[b] || L.punt_start["6"];
      let start = sample(rand, opts2);
      record({ type: "punt", pos: side, yl, ylEnd: 100 - start, yards: 0,
        desc: teams[side].abbr + " punts; " + teams[other(side)].abbr + " ball at " + ylText(other(side), start) + "." });
      runClock(8, false);
      changePossession(other(side), start, "Punt");
    }

    function fourthDecision() {
      const sd = diff(pos), late = qtr >= 4 && secs <= 300;
      const fgDist = yl + 17;
      if (late && sd < 0) {
        if (sd >= -3 && fgDist <= 55 && (secs <= 30 || sd === 0)) return "fg";
        return "go";
      }
      if (late && sd > 0) return yl <= 37 ? "fg" : yl < 45 && togo <= 1 ? "go" : "punt";
      if (halfSecs() <= 10 && fgDist <= 58) return "fg";
      const row = L.fourth[clamp(Math.floor((yl - 1) / 10), 0, 9)][fourthDist(togo)];
      let r = rand();
      if (fgDist > 62) { // out of range: renormalize go/punt
        const g = row[0] / (row[0] + row[1]);
        return r < g ? "go" : "punt";
      }
      if (r < row[0]) return "go";
      if (r < row[0] + row[1]) return "punt";
      return "fg";
    }

    function shouldKneel() {
      const sd = diff(pos);
      if (sd <= 0) return false;
      const d = other(pos);
      if (qtr === 4 || qtr === 5) {
        const kneelsLeft = 4 - down + 1;
        const burn = Math.max(0, kneelsLeft - timeouts[d]) * 40;
        return secs <= burn && secs <= 120;
      }
      if (qtr === 2 && secs <= 40 && yl > 60 && timeouts[d] === 0) return true;
      return false;
    }

    // ---------- scrimmage play ----------
    function scrimmage() {
      const side = pos, def = other(side), m = mu[side], tm = teams[side];
      const startYl = yl;
      drive.plays++;

      // end of half / game: final-second field goal
      if ((qtr === 2 || qtr === 4 || qtr === 5) && secs <= 6 && yl + 17 <= 58 && (qtr === 2 || (diff(side) >= -3 && diff(side) <= 0))) {
        attemptFG(); return;
      }
      if (shouldKneel()) {
        yl = Math.min(99, yl + 1);
        record({ type: "kneel", pos: side, yl: startYl, ylEnd: yl, yards: -1, player: tm.qb.short, desc: tm.qb.short + " kneels." });
        const s = stat(side, tm.qb); s.ra++; s.ry -= 1;
        tstats[side].yds -= 1;
        down++; togo++;
        runClock(qtr === 2 ? 40 : 40);
        tstats[side].plays++;
        if (down > 4) { changePossession(def, 100 - yl, "Downs"); }
        return;
      }
      if (down === 4) {
        const dec = force4th || fourthDecision();
        force4th = null;
        if (dec === "punt") { punt(); return; }
        if (dec === "fg") { attemptFG(); return; }
      }

      // penalties (pre-snap / accepted, play wiped)
      const pr = rand();
      if (pr < L.pen_off_rate) {
        const y = Math.min(sample(rand, L.pen_off_yards), Math.floor((100 - yl) / 2) || 1);
        yl = Math.min(99, yl + y); togo += y;
        record({ type: "penalty", pos: side, yl: startYl, ylEnd: yl, yards: -y, desc: "Penalty on " + tm.abbr + ", " + y + " yards." });
        runClock(halfSecs() <= 120 ? 4 : L.clock_penalty);
        return;
      } else if (pr < L.pen_off_rate + L.pen_def_rate) {
        const pd = sample(rand, L.pen_def);
        let y = Math.min(pd[0], Math.max(1, Math.floor(yl / 2)));
        if (yl - y <= 0) y = Math.max(1, yl - 1);
        yl -= y;
        if (pd[1] || y >= togo) { down = 1; togo = Math.min(10, yl); } else togo -= y;
        record({ type: "penalty", pos: side, yl: startYl, ylEnd: yl, yards: y, firstDown: !!pd[1] || down === 1,
          desc: "Penalty on " + teams[def].abbr + ", " + y + " yards" + (down === 1 ? ", automatic first down." : ".") });
        runClock(halfSecs() <= 120 ? 4 : L.clock_penalty);
        return;
      }

      let yards = 0, type, player, desc, turnover = null, incomplete = false, pstat = null, recvStat = null;
      const qb = tm.qb;
      const isPass = rand() < passProb();
      const rz = yl <= 20;

      if (isPass) {
        const r = rand();
        if (r < m.sack) {
          type = "sack"; yards = sample(rand, L.sack_yards);
          const s = stat(side, qb); s.sk++;
          desc = qb.short + " sacked for " + (-yards) + (yards === -1 ? " yard." : " yards.");
          player = qb.short;
          if (rand() < 0.08) turnover = "Fumble";
        } else if (r < m.sack + m.scramble) {
          type = "scramble"; yards = sample(rand, L.scramble_yards);
          if (yards > 0) yards = Math.round(yards * m.rushYdsF);
          const s = stat(side, qb); s.ra++; pstat = { s, kind: "rush" };
          player = qb.short;
          desc = qb.short + " scrambles for " + yards + (Math.abs(yards) === 1 ? " yard." : " yards.");
        } else {
          type = "pass";
          const shareKey = rz ? "tgt_rz_share" : "tgt_share";
          const tgt = tm.targets.length ? pickWeighted(rand, tm.targets, shareKey) : null;
          const qs = stat(side, qb); qs.pa++;
          const rs = tgt ? stat(side, tgt) : null;
          if (rs) rs.tg++;
          const zone = yl <= 5 ? 0 : yl <= 10 ? 1 : yl <= 20 ? 2 : 3;
          let pc = m.comp * L.comp_zone_mult[zone];
          if (tgt) pc *= tgt.catch / tm.T.off.comp_rate;
          pc = clamp(pc, 0.2, 0.92);
          const ri = rand();
          if (ri < m.int) {
            type = "interception"; turnover = "Interception"; qs.pint++;
            player = qb.short;
            desc = qb.short + " pass intended for " + (tgt ? tgt.short : "receiver") + " INTERCEPTED.";
          } else if (ri < m.int + pc) {
            const own = tgt && tgt.rec_y.length ? tgt.rec_y.length / (tgt.rec_y.length + 15) : 0;
            let y = rand() < own ? sample(rand, tgt.rec_y) : sample(rand, tm.T.off.comp_yards.length ? tm.T.off.comp_yards : L.comp_yards);
            const z = zoneOf(yl);
            if (z >= 0) y = sample(rand, L.zone_comp[z]);
            if (y > 0) y = Math.max(1, Math.round(y * tm.compScale * m.compYdsF));
            yards = y; qs.pc++;
            recvStat = rs;
            player = tgt ? tgt.short : "";
            pstat = { s: qs, kind: "pass", r: rs };
            desc = qb.short + " pass to " + (tgt ? tgt.short : "receiver") + " for " + yards + (Math.abs(yards) === 1 ? " yard." : " yards.");
            if (rand() < L.fumble_rate_rec) turnover = "Fumble";
          } else {
            incomplete = true; yards = 0;
            player = tgt ? tgt.short : qb.short;
            desc = qb.short + " pass incomplete" + (tgt ? " intended for " + tgt.short : "") + ".";
          }
        }
      } else {
        type = "run";
        const shareKey = yl <= 10 ? "rush_rz_share" : "rush_share";
        const rb = tm.rushers.length ? pickWeighted(rand, tm.rushers, shareKey) : qb;
        const own = rb.rush_y && rb.rush_y.length ? rb.rush_y.length / (rb.rush_y.length + 25) : 0;
        let y = rand() < own ? sample(rand, rb.rush_y) : sample(rand, tm.T.off.rush_yards.length ? tm.T.off.rush_yards : L.rush_yards);
        const z = zoneOf(yl);
        if (z >= 0) y = sample(rand, L.zone_rush[z]);
        if (y > 0) y = Math.round(y * tm.rushScale * m.rushYdsF);
        yards = y;
        const s = stat(side, rb); s.ra++;
        pstat = { s, kind: "rush" };
        player = rb.short;
        const dir = ["up the middle", "left tackle", "right guard", "right end", "left end", "left guard", "right tackle"][Math.floor(rand() * 7)];
        desc = rb.short + " " + dir + " for " + yards + (Math.abs(yards) === 1 ? " yard." : " yards.");
        if (rand() < fumRush) turnover = "Fumble";
      }

      // cap at goal line / own end zone
      if (yards >= yl) yards = yl;
      const td = yards >= yl && !turnover;
      const safety = yl - yards >= 100;
      if (safety) yards = yl - 100;

      // apply stats
      if (pstat) {
        if (pstat.kind === "rush") { pstat.s.ry += yards; if (td) pstat.s.rtd++; }
        if (pstat.kind === "pass") {
          pstat.s.py += yards; if (td) pstat.s.ptd++;
          if (pstat.r) { pstat.r.rec++; pstat.r.recy += yards; if (td) pstat.r.rectd++; }
        }
      }
      if (type !== "interception") { tstats[side].yds += yards; drive.yds += yards; }

      const entry = { type, pos: side, yl: startYl, yards, player, desc, down, togo };
      yl -= yards;
      entry.ylEnd = yl;

      if (td) {
        entry.scoring = "TD"; entry.desc += " TOUCHDOWN.";
        record(entry);
        runClock(6, false);
        scoreTD(side, player, type);
        return;
      }
      if (safety) {
        entry.scoring = "Safety"; entry.desc += " SAFETY.";
        record(entry);
        addPts(def, 2); endDrive("Safety");
        runClock(6, false);
        if (secs <= 0 && (qtr === 2 || qtr >= 4)) { quarterCheck(); return; }
        startDrive(def, 60, "Free kick");
        return;
      }
      if (turnover) {
        tstats[side].to++;
        entry.turnover = turnover; entry.desc += " " + turnover.toUpperCase() + ", recovered by " + teams[def].abbr + ".";
        record(entry);
        runClock(6, false);
        if (turnover === "Interception") {
          const spot = yl - 12;
          if (spot <= 0) { changePossession(def, 80, "Interception"); return; }
          if (rand() < 0.04) { // pick six
            endDrive("Interception");
            drives.push({ n: drives.length + 1, team: def, start: 100 - spot, how: "Interception", plays: 0, yds: 0, q: qtr, clock: clockStr(), result: "Touchdown", t0: halfSecsAbs() });
            drive = drives[drives.length - 1];
            if (log) plays[plays.length - 1].desc += " Returned for a TOUCHDOWN.";
            if (log) plays[plays.length - 1].scoring = "TD";
            scoreTD(def, null, "return");
            return;
          }
          const ret = Math.floor(rand() * 15);
          changePossession(def, clamp(100 - spot - ret, 1, 99), "Interception");
        } else {
          changePossession(def, clamp(100 - yl, 1, 99), "Fumble");
        }
        return;
      }
      // down & distance
      if (yards >= togo) {
        down = 1; togo = Math.min(10, yl); entry.firstDown = true;
      } else {
        down++; togo -= yards;
      }
      record(entry);
      clockAfterPlay(incomplete, type === "scramble" && rand() < 0.3);
      if (down > 4) { changePossession(def, 100 - yl, "Downs"); }
    }

    // ---------- run the game ----------
    const st = opts.start;
    if (st) {
      // pick up mid-game: {q, secs, away, home (scores), pos, yl, down, togo, to: {away, home}, recv2}
      qtr = st.q || 1; secs = st.secs == null ? 900 : st.secs;
      score.away = st.away || 0; score.home = st.home || 0;
      if (st.to) { timeouts.away = st.to.away; timeouts.home = st.to.home; }
      if (st.recv2) openingReceiver = other(st.recv2);
      if (qtr >= 5) ot = { poss: { away: 1, home: 1 } };
      startDrive(st.pos, clamp(st.yl, 1, 99), "Current situation");
      down = clamp(st.down || 1, 1, 4); togo = clamp(st.togo || 10, 1, yl);
    } else {
      kickoff(other(openingReceiver), "Opening kickoff");
    }
    let guard = 0, first = true;
    while (!gameOver && guard++ < 600) {
      if (secs <= 0) { quarterCheck(); continue; }
      if (first && st && down === 4) {
        const side = pos, before = score[side], d0 = drives.length;
        const dec = opts.force4th || null;
        scrimmage();
        const after = score[side] - before;
        firstOutcome = { decision: dec, scored: after,
          converted: after >= 6 || (pos === side && drives.length === d0 && down === 1),
          made: dec === "fg" ? after === 3 : undefined, oppStart: pos !== side ? yl : null };
      } else scrimmage();
      first = false;
    }
    if (drive && !drive.result) endDrive("End of game");

    const winner = score.home > score.away ? "home" : score.away > score.home ? "away" : "tie";
    return {
      away: opts.away, home: opts.home, score, qscore, winner, ot: !!ot,
      box, tstats, drives, plays,
      qb: { away: teams.away.qb.id, home: teams.home.qb.id },
      weather: opts.weather || null, firstOutcome, recv2: other(openingReceiver),
    };
  }

  // ---------- many games ----------
  function simulateMany(model, opts, n, onProgress) {
    const agg = { n: 0, away: [], home: [], players: {}, wins: { away: 0, home: 0, tie: 0 }, first: { n: 0, converted: 0, made: 0, scored: 0 } };
    const base = opts.seed == null ? (Math.random() * 2 ** 31) >>> 0 : opts.seed;
    const keys = ["pa", "pc", "py", "ptd", "pint", "ra", "ry", "rtd", "tg", "rec", "recy", "rectd", "fgm", "xpm", "pts"];
    for (let i = 0; i < n; i++) {
      const g = simulateGame(model, Object.assign({}, opts, { seed: base + i * 7919, log: false }));
      agg.n++;
      agg.away.push(g.score.away); agg.home.push(g.score.home);
      agg.wins[g.winner]++;
      if (g.firstOutcome) { const f = agg.first; f.n++; if (g.firstOutcome.converted) f.converted++; if (g.firstOutcome.made) f.made++; f.scored += g.firstOutcome.scored; }
      const seen = new Set();
      for (const id in g.box) {
        const s = g.box[id];
        let p = agg.players[id];
        if (!p) {
          p = agg.players[id] = { id, name: s.name, short: s.short, pos: s.pos, team: s.team, stats: {} };
          for (const k of keys) p.stats[k] = new Array(agg.n - 1).fill(0);
        }
        for (const k of keys) p.stats[k].push(s[k]);
        seen.add(id);
      }
      for (const id in agg.players) if (!seen.has(id)) for (const k of keys) agg.players[id].stats[k].push(0);
      if (onProgress && i % 250 === 0) onProgress(i / n);
    }
    return agg;
  }

  // win probability from a game state (light: no player stats kept)
  function winProb(model, opts, n) {
    const base = opts.seed == null ? (Math.random() * 2 ** 31) >>> 0 : opts.seed;
    let h = 0, a = 0, m = 0, t = 0;
    for (let i = 0; i < n; i++) {
      const g = simulateGame(model, Object.assign({}, opts, { seed: base + i * 7919, log: false }));
      if (g.winner === "home") h++; else if (g.winner === "away") a++; else { h += 0.5; a += 0.5; }
      m += g.score.home - g.score.away; t += g.score.home + g.score.away;
    }
    return { home: h / n, away: a / n, margin: m / n, total: t / n };
  }

  // compact per-player results: d = sorted (for quantiles/over %), r = per-sim in sim order (for parlays)
  const SUM_KEYS = ["py", "pc", "ptd", "pint", "ra", "ry", "rec", "recy", "pts"];
  function summarize(agg) {
    const players = {};
    for (const id in agg.players) {
      const p = agg.players[id], s = p.stats, n = agg.n;
      const out = { id, name: p.name, short: p.short, pos: p.pos, team: p.team, d: {}, r: {} };
      for (const k of SUM_KEYS) out.r[k] = Int16Array.from(s[k]);
      out.r.rry = new Int16Array(n); out.r.td = new Int16Array(n);
      for (let i = 0; i < n; i++) { out.r.rry[i] = s.ry[i] + s.recy[i]; out.r.td[i] = s.rtd[i] + s.rectd[i]; }
      for (const k in out.r) out.d[k] = Int16Array.from(out.r[k]).sort();
      players[id] = out;
    }
    return { n: agg.n, away: agg.away, home: agg.home, wins: agg.wins, first: agg.first, players };
  }

  const api = { simulateGame, simulateMany, summarize, winProb, mulberry32, defaultOut };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NFLSim = api;
})(typeof self !== "undefined" ? self : this);
