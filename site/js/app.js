/* Gridiron Sim — UI: game picker, animated replay of one simulated game, projections, roster toggles. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const COLORS = {
    ARI: "#c8334a", ATL: "#d03a4c", BAL: "#8a6cd6", BUF: "#3d7be0", CAR: "#2fa4e0", CHI: "#e2793a", CIN: "#f3712b", CLE: "#ff6b2c",
    DAL: "#6f97d6", DEN: "#fb6a2a", DET: "#2f95d6", GB: "#3ecf8e", HOU: "#d84a5a", IND: "#4a86d8", JAX: "#1fa8a8", KC: "#e8414a",
    LA: "#4a7fe0", LAC: "#3fb5f2", LV: "#b9c3cc", MIA: "#18b5b5", MIN: "#9a6be0", NE: "#5a86d0", NO: "#d3bc8d", NYG: "#3d6fd6",
    NYJ: "#35a86a", PHI: "#2aa39a", PIT: "#ffb612", SEA: "#69be28", SF: "#d9534f", TB: "#e0483e", TEN: "#4b92db", WAS: "#c75b5b",
  };
  const col = (t) => COLORS[t] || "#9aa";

  let model = null, cur = { away: null, home: null }, outSet = new Set(), seed = 1, game = null;
  let idx = -1, playing = false, timer = null, speed = 1;
  let projResult = null, projStale = true, worker = null;
  const lines = {}; // user-entered prop lines: key `${id}|${stat}`

  // ---------------- boot ----------------
  fetch("data/model.json").then((r) => r.json()).then((m) => {
    model = m;
    $("dataLine").textContent = `${m.season} season · data through week ${m.through_week} · built ${m.generated}`;
    initPicker();
    initTabs();
    initControls();
    fromHash() || selectGame(defaultGame());
  }).catch((e) => { $("dataLine").textContent = "Could not load data/model.json — serve this folder over http (see README). " + e; });

  function defaultGame() {
    const wk = model.schedule.filter((g) => g.week === model.target_week);
    return wk[0] || model.schedule[model.schedule.length - 1];
  }

  // ---------------- picker ----------------
  function initPicker() {
    const weeks = [...new Set(model.schedule.map((g) => g.week))];
    $("weekSel").innerHTML = weeks.map((w) => `<option value="${w}" ${w === model.target_week ? "selected" : ""}>${w}</option>`).join("");
    $("weekSel").onchange = renderGames;
    const teams = Object.keys(model.teams).sort();
    const opts = teams.map((t) => `<option>${t}</option>`).join("");
    $("awaySel").innerHTML = opts; $("homeSel").innerHTML = opts;
    $("awaySel").onchange = $("homeSel").onchange = () => {
      if ($("awaySel").value !== $("homeSel").value) selectGame({ away: $("awaySel").value, home: $("homeSel").value });
    };
    $("neutralChk").onchange = () => { newGame(seed); projStale = true; };
    renderGames();
  }
  function renderGames() {
    const w = +$("weekSel").value;
    $("gameList").innerHTML = model.schedule.filter((g) => g.week === w).map((g) => {
      const fin = g.home_score != null ? ` <span class="fin">${g.away_score}-${g.home_score}</span>` : "";
      const sel = g.away === cur.away && g.home === cur.home ? "sel" : "";
      return `<button class="${sel}" data-a="${g.away}" data-h="${g.home}">${g.away} @ ${g.home}${fin}</button>`;
    }).join("");
    $("gameList").querySelectorAll("button").forEach((b) => (b.onclick = () => selectGame({ away: b.dataset.a, home: b.dataset.h })));
  }
  function schedFor(a, h) {
    return model.schedule.find((g) => g.away === a && g.home === h && g.week === model.target_week) ||
      model.schedule.find((g) => g.away === a && g.home === h && g.home_score == null) || null;
  }
  function selectGame(g, s) {
    if (!model.teams[g.away] || !model.teams[g.home]) return;
    cur = { away: g.away, home: g.home };
    $("awaySel").value = g.away; $("homeSel").value = g.home;
    outSet = new Set(NFLSim.defaultOut(model, [g.away, g.home]));
    document.documentElement.style.setProperty("--away", col(g.away));
    document.documentElement.style.setProperty("--home", col(g.home));
    renderGames(); renderRoster();
    projStale = true; projResult = null;
    $("projOut").classList.add("hidden"); $("runInfo").textContent = "";
    newGame(s || randSeed());
  }
  const randSeed = () => Math.floor(Math.random() * 1e9);

  // ---------------- tabs ----------------
  function initTabs() {
    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
      if (t.dataset.tab === "proj" && projStale) runProjections();
    }));
  }

  // ---------------- watch ----------------
  function initControls() {
    $("btnPlay").onclick = () => (playing ? pause() : play());
    $("btnStep").onclick = () => { pause(); step(); };
    $("btnEnd").onclick = () => { pause(); idx = game.plays.length - 1; show(idx, false); showFinal(); };
    $("btnNew").onclick = () => newGame(randSeed());
    $("speedSel").onchange = () => (speed = +$("speedSel").value);
    $("btnShare").onclick = () => {
      const url = location.href.split("#")[0] + `#${cur.away}@${cur.home}/${seed}`;
      navigator.clipboard && navigator.clipboard.writeText(url);
      $("btnShare").textContent = "Copied"; setTimeout(() => ($("btnShare").textContent = "Copy link"), 1200);
    };
    $("btnRun").onclick = runProjections;
    $("statSel").onchange = $("teamFilter").onchange = renderProps;
  }
  function fromHash() {
    const m = location.hash.match(/^#([A-Z]{2,3})@([A-Z]{2,3})(?:\/(\d+))?/);
    if (!m) return false;
    selectGame({ away: m[1], home: m[2] }, m[3] ? +m[3] : undefined);
    return true;
  }

  function newGame(s) {
    pause();
    seed = s;
    $("seedLbl").textContent = seed;
    game = NFLSim.simulateGame(model, { away: cur.away, home: cur.home, seed, log: true, out: [...outSet], neutral: $("neutralChk").checked });
    idx = -1;
    $("finalBox").classList.add("hidden");
    drawFieldBase();
    renderStrip();
    resetBoard();
    $("btnPlay").textContent = "▶ Play";
  }

  function resetBoard() {
    setRow("rowAway", cur.away, 0); setRow("rowHome", cur.home, 0);
    $("qtr").textContent = "1ST"; $("clock").textContent = "15:00";
    $("dd").textContent = "KICKOFF"; $("spot").textContent = ""; $("poss").textContent = "";
    $("pType").textContent = ""; $("pType").className = "ptype mono";
    $("pDesc").textContent = `${cur.away} at ${cur.home}. Press play to start.`;
    $("playerBadge").textContent = ""; $("driveBox").textContent = "DRIVE –";
    renderLine(0, -1);
  }
  function setRow(id, abbr, pts) {
    const r = $(id);
    r.querySelector(".abbr").textContent = abbr;
    r.querySelector(".pts").textContent = pts;
    r.querySelector(".bar").style.background = col(abbr);
  }

  function play() {
    if (!game) return;
    if (idx >= game.plays.length - 1) newGame(seed);
    playing = true; $("btnPlay").textContent = "❚❚ Pause";
    tick();
  }
  function pause() { playing = false; clearTimeout(timer); $("btnPlay").textContent = "▶ Play"; }
  function tick() {
    if (!playing) return;
    if (!step()) { pause(); return; }
    const p = game.plays[idx];
    const big = p.scoring || p.turnover;
    timer = setTimeout(tick, (big ? 2600 : 1300) / speed);
  }
  function step() {
    if (idx >= game.plays.length - 1) { showFinal(); return false; }
    idx++;
    show(idx, true);
    if (idx === game.plays.length - 1) setTimeout(showFinal, 900 / speed);
    return true;
  }

  const ordinal = (n) => ["", "1ST", "2ND", "3RD", "4TH"][n] || n + "TH";
  const qName = (q) => (q <= 4 ? ordinal(q) : "OT");
  function scoreAfter(i) { return i + 1 < game.plays.length ? game.plays[i + 1].score : [game.score.away, game.score.home]; }
  const absYd = (pos, yl) => (pos === "away" ? 100 - yl : yl);
  const ylLabel = (pos, yl) => {
    if (yl === 50) return "MIDFIELD";
    const own = pos === "away" ? cur.away : cur.home, opp = pos === "away" ? cur.home : cur.away;
    return yl > 50 ? `${own} ${100 - yl}` : `${opp} ${yl}`;
  };

  function show(i, animate) {
    const p = game.plays[i];
    const sc = scoreAfter(i);
    setRow("rowAway", cur.away, sc[0]); setRow("rowHome", cur.home, sc[1]);
    $("rowAway").classList.toggle("has-ball", p.pos === "away");
    $("rowHome").classList.toggle("has-ball", p.pos === "home");
    $("rowAway").classList.toggle("trail", sc[0] < sc[1]);
    $("rowHome").classList.toggle("trail", sc[1] < sc[0]);
    $("qtr").textContent = qName(p.q); $("clock").textContent = p.clock;
    const team = p.pos === "away" ? cur.away : cur.home;
    $("dd").textContent = p.down ? `${ordinal(p.down)} & ${p.yl <= p.togo ? "GOAL" : p.togo}` : p.type.replace("_", " ").toUpperCase();
    $("spot").textContent = ylLabel(p.pos, p.yl);
    $("poss").innerHTML = `<span style="color:${col(team)}">●</span> ${team}`;

    let label = "", cls = "";
    if (p.scoring === "TD") { label = "TOUCHDOWN"; cls = "td"; }
    else if (p.scoring === "FG") { label = "FIELD GOAL"; cls = "fg"; }
    else if (p.scoring === "Safety") { label = "SAFETY"; cls = "to"; }
    else if (p.turnover) { label = p.turnover.toUpperCase(); cls = "to"; }
    else if (p.type === "field_goal") { label = "NO GOOD"; cls = "to"; }
    else if (p.firstDown) { label = "FIRST DOWN"; cls = "fd"; }
    else if (p.type === "sack") { label = "SACK"; cls = "to"; }
    $("pType").textContent = label; $("pType").className = "ptype mono " + cls;
    $("pDesc").textContent = p.desc + (p.xp === false ? " Extra point NO GOOD." : "");
    const initials = (p.player || team).split(/[ .]+/).filter(Boolean).map((s) => s[0]).join("").slice(0, 3);
    $("playerBadge").textContent = initials;
    $("playerBadge").style.borderColor = col(team);
    $("playerBadge").style.color = col(team);

    const d = game.drives[p.drive - 1];
    if (d) {
      const dteam = d.team === "away" ? cur.away : cur.home;
      $("driveBox").textContent = `DRIVE ${d.n} / ${game.drives.length}\nBALL ${dteam}\nSTART ${ylLabel(d.team, d.start)} · ${String(d.how).toUpperCase()}`;
    }
    renderLine(i, p.drive);
    drawPlay(p, animate);
  }

  function renderLine(i, driveNo) {
    const q = { away: [0, 0, 0, 0, 0], home: [0, 0, 0, 0, 0] };
    let prev = [0, 0];
    if (game) for (let k = 0; k <= i && k < game.plays.length; k++) {
      const s = scoreAfter(k), qi = Math.min(game.plays[k].q, 5) - 1;
      q.away[qi] += s[0] - prev[0]; q.home[qi] += s[1] - prev[1]; prev = s;
    }
    const hasOT = q.away[4] || q.home[4] || (game && game.ot && i >= game.plays.length - 1);
    const cols = hasOT ? 5 : 4;
    const head = `<tr><th></th>${[1, 2, 3, 4, "OT"].slice(0, cols).map((x) => `<th>${x}</th>`).join("")}<th>T</th></tr>`;
    const row = (s, t) => `<tr><td style="color:${col(t)}">${t}</td>${q[s].slice(0, cols).map((x, k) => `<td>${k + 1 <= (game && i >= 0 ? game.plays[i].q : 1) ? x : "-"}</td>`).join("")}<td><b>${prev[s === "away" ? 0 : 1]}</b></td></tr>`;
    $("lineScore").innerHTML = head + row("away", cur.away) + row("home", cur.home);
    document.querySelectorAll("#driveStrip i").forEach((el, k) => el.classList.toggle("cur", k === driveNo - 1));
  }

  function renderStrip() {
    $("driveStrip").innerHTML = game.drives.map((d) => {
      const r = d.result || "";
      const c = r === "Touchdown" ? "Touchdown" : r === "Field goal" ? "fg" : r === "Punt" ? "punt" : /Interception|Fumble|Downs|Safety/.test(r) ? "to" : "other";
      return `<i class="${c}" title="${d.team === "away" ? cur.away : cur.home}: ${r}"></i>`;
    }).join("");
  }

  // ---------------- field drawing ----------------
  const X = (abs) => 100 + abs * 10;
  function drawFieldBase() {
    const svg = $("field");
    let h = `<defs><linearGradient id="turf" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#14301c"/><stop offset="1" stop-color="#0d2414"/></linearGradient></defs>`;
    h += `<rect x="0" y="0" width="1200" height="300" fill="url(#turf)"/>`;
    for (let k = 0; k < 10; k++) if (k % 2 === 0) h += `<rect x="${X(k * 10)}" y="0" width="100" height="300" fill="#ffffff" opacity="0.025"/>`;
    h += `<rect x="0" y="0" width="100" height="300" fill="${col(cur.away)}" opacity="0.35"/>`;
    h += `<rect x="1100" y="0" width="100" height="300" fill="${col(cur.home)}" opacity="0.35"/>`;
    h += `<text x="50" y="150" fill="#fff" opacity=".7" font-family="monospace" font-size="26" font-weight="700" text-anchor="middle" transform="rotate(-90 50 150)">${cur.away}</text>`;
    h += `<text x="1150" y="150" fill="#fff" opacity=".7" font-family="monospace" font-size="26" font-weight="700" text-anchor="middle" transform="rotate(90 1150 150)">${cur.home}</text>`;
    for (let yd = 0; yd <= 100; yd += 5) h += `<line x1="${X(yd)}" x2="${X(yd)}" y1="0" y2="300" stroke="#fff" stroke-opacity="${yd % 10 ? 0.08 : 0.2}"/>`;
    for (let yd = 10; yd < 100; yd += 10) {
      const n = yd <= 50 ? yd : 100 - yd;
      h += `<text x="${X(yd)}" y="286" fill="#fff" opacity=".35" font-family="monospace" font-size="14" text-anchor="middle">${n}</text>`;
      h += `<text x="${X(yd)}" y="24" fill="#fff" opacity=".35" font-family="monospace" font-size="14" text-anchor="middle">${n}</text>`;
    }
    h += `<g id="dyn"></g>`;
    svg.innerHTML = h;
  }
  function drawPlay(p, animate) {
    const g = $("dyn");
    const a0 = absYd(p.pos, Math.max(0, Math.min(100, p.yl)));
    const a1 = absYd(p.pos, Math.max(0, Math.min(100, p.ylEnd == null ? p.yl : p.ylEnd)));
    const dir = p.pos === "away" ? 1 : -1;
    let h = "";
    if (p.down && p.type !== "kickoff") {
      h += `<line x1="${X(a0)}" x2="${X(a0)}" y1="0" y2="300" stroke="#4aa3ff" stroke-width="3"/>`;
      const fd = absYd(p.pos, Math.max(0, p.yl - p.togo));
      if (p.yl > p.togo) h += `<line x1="${X(fd)}" x2="${X(fd)}" y1="0" y2="300" stroke="#f2c94c" stroke-width="3"/>`;
    }
    h += `<text x="${X(a0) + dir * 30}" y="48" fill="${col(p.pos === "away" ? cur.away : cur.home)}" font-family="monospace" font-size="20" font-weight="700" text-anchor="middle">${dir > 0 ? "›››" : "‹‹‹"}</text>`;
    const y0 = 150, air = ["pass", "interception", "punt", "kickoff", "field_goal"].includes(p.type);
    const cy = air ? 40 : 150 + (Math.random() * 40 - 20);
    const endX = p.type === "field_goal" ? X(p.pos === "away" ? 100 : 0) + dir * 40 : X(a1);
    h += `<path id="trail" d="M ${X(a0)} ${y0} Q ${(X(a0) + endX) / 2} ${cy} ${endX} ${y0}" stroke="#fff" stroke-opacity=".35" stroke-width="2" fill="none" stroke-dasharray="4 5"/>`;
    h += `<g id="ball"><ellipse rx="9" ry="6" fill="#f4efe6" stroke="#8a5a2b" stroke-width="2"/></g>`;
    if (p.scoring === "TD") h += `<rect x="${p.pos === "away" ? 1100 : 0}" y="0" width="100" height="300" fill="#3ecf8e" opacity=".25"/>`;
    g.innerHTML = h;
    const ball = $("ball"), path = $("trail");
    const len = path.getTotalLength();
    const dur = animate ? 900 / speed : 0;
    const t0 = performance.now();
    function frame(t) {
      const k = dur ? Math.min(1, (t - t0) / dur) : 1;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const pt = path.getPointAtLength(len * e);
      ball.setAttribute("transform", `translate(${pt.x},${pt.y})`);
      if (k < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---------------- final box ----------------
  function showFinal() {
    if (!game) return;
    const b = Object.values(game.box);
    const side = (t) => {
      const ps = b.filter((s) => s.team === t);
      const sec = (title, rows) => (rows.length ? `<h4>${title}</h4><table>${rows.join("")}</table>` : "");
      const tr = (n, v) => `<tr><td>${n}</td><td>${v}</td></tr>`;
      return sec("PASSING", ps.filter((s) => s.pa).sort((x, y) => y.pa - x.pa).map((s) => tr(s.name, `${s.pc}/${s.pa}, ${s.py} YDS, ${s.ptd} TD, ${s.pint} INT`))) +
        sec("RUSHING", ps.filter((s) => s.ra).sort((x, y) => y.ry - x.ry).map((s) => tr(s.name, `${s.ra} CAR, ${s.ry} YDS, ${s.rtd} TD`))) +
        sec("RECEIVING", ps.filter((s) => s.tg).sort((x, y) => y.recy - x.recy).map((s) => tr(s.name, `${s.rec}/${s.tg} TGT, ${s.recy} YDS, ${s.rectd} TD`))) +
        sec("KICKING", ps.filter((s) => s.fga || s.xpa).map((s) => tr(s.name, `${s.fgm}/${s.fga} FG, ${s.xpm}/${s.xpa} XP, ${s.pts} PTS`)));
    };
    const ts = game.tstats, mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    $("finalBox").innerHTML = `<h2>FINAL${game.ot ? " / OT" : ""} · ${cur.away} ${game.score.away} – ${cur.home} ${game.score.home}</h2>
      <div class="mono dim">YDS ${ts.away.yds} · ${ts.home.yds} &nbsp; TURNOVERS ${ts.away.to} · ${ts.home.to} &nbsp; POSSESSION ${mmss(ts.away.top)} · ${mmss(ts.home.top)}</div>
      <div class="boxgrid"><div><h4 style="color:${col(cur.away)}">${cur.away}</h4>${side(cur.away)}</div><div><h4 style="color:${col(cur.home)}">${cur.home}</h4>${side(cur.home)}</div></div>`;
    $("finalBox").classList.remove("hidden");
  }

  // ---------------- projections ----------------
  function runProjections() {
    if (!model) return;
    const n = +$("nSel").value;
    const opts = { away: cur.away, home: cur.home, out: [...outSet], neutral: $("neutralChk").checked, seed: 12345 };
    $("btnRun").disabled = true; $("prog").style.width = "0%";
    $("runInfo").textContent = `simulating ${n.toLocaleString()} games…`;
    const t0 = performance.now();
    const finish = (res) => {
      projResult = res; projStale = false; $("btnRun").disabled = false; $("prog").style.width = "100%";
      $("runInfo").textContent = `${res.n.toLocaleString()} games in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      renderProjections();
    };
    try {
      if (!worker) { worker = new Worker("js/worker.js"); worker.postMessage({ model }); }
      worker.onmessage = (e) => {
        if (e.data.progress != null) $("prog").style.width = (e.data.progress * 100).toFixed(0) + "%";
        if (e.data.done) finish(e.data.result);
      };
      worker.postMessage({ run: true, opts, n });
    } catch (err) { // no workers (e.g. file://): run on the main thread
      setTimeout(() => {
        const agg = NFLSim.simulateMany(model, opts, n);
        const players = {};
        for (const id in agg.players) {
          const p = agg.players[id], s = p.stats, d = {};
          for (const k of ["py", "pc", "ptd", "pint", "ra", "ry", "rec", "recy", "pts"]) d[k] = Int16Array.from(s[k]).sort();
          d.rry = Int16Array.from(s.ry.map((x, i) => x + s.recy[i])).sort();
          d.td = Int16Array.from(s.rtd.map((x, i) => x + s.rectd[i])).sort();
          players[id] = { id, name: p.name, short: p.short, pos: p.pos, team: p.team, d };
        }
        finish({ n: agg.n, away: agg.away, home: agg.home, wins: agg.wins, players });
      }, 30);
    }
  }

  const pct = (x) => (x * 100).toFixed(1) + "%";
  function american(p) {
    if (p <= 0 || p >= 1) return "–";
    return p >= 0.5 ? String(Math.round((-100 * p) / (1 - p))) : "+" + Math.round((100 * (1 - p)) / p);
  }
  const quant = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
  const meanOf = (arr) => { let s = 0; for (const x of arr) s += x; return s / arr.length; };
  function pOver(sorted, line) { // P(x > line)
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= line) lo = m + 1; else hi = m; }
    return (sorted.length - lo) / sorted.length;
  }

  function renderProjections() {
    const r = projResult, n = r.n, A = cur.away, H = cur.home;
    const sg = schedFor(A, H);
    const margin = r.home.map((h, i) => h - r.away[i]);
    const total = r.home.map((h, i) => h + r.away[i]);
    const pH = (r.wins.home + r.wins.tie / 2) / n, pA = 1 - pH;
    const cards = [
      [`${A} win`, pct(pA), `fair ${american(pA)}`],
      [`${H} win`, pct(pH), `fair ${american(pH)}`],
      ["Avg score", `${meanOf(r.away).toFixed(1)}–${meanOf(r.home).toFixed(1)}`, `${A}–${H}`],
      ["Avg total", meanOf(total).toFixed(1), `median ${quant([...total].sort((a, b) => a - b), 0.5)}`],
    ];
    if (sg && sg.spread != null) {
      const s = sg.spread; // nflverse: positive = home favored by s
      const fav = s >= 0 ? H : A;
      const cover = s >= 0 ? margin.filter((m) => m > s).length / n : margin.filter((m) => -m > -s).length / n;
      cards.push([`${fav} -${Math.abs(s)} (market)`, pct(cover), `cover · push ${pct(margin.filter((m) => Math.abs(m) === Math.abs(s)).length / n)}`]);
    }
    if (sg && sg.total != null) {
      const o = total.filter((t) => t > sg.total).length / n;
      cards.push([`Over ${sg.total} (market)`, pct(o), `under ${pct(total.filter((t) => t < sg.total).length / n)}`]);
    }
    $("gameCards").innerHTML = cards.map(([k, v, s]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");
    hist($("marginChart"), margin, -35, 35, sg && sg.spread != null ? sg.spread : null, `${H} margin`);
    hist($("totalChart"), total, 10, 85, sg && sg.total != null ? sg.total : null, "total");
    $("teamFilter").innerHTML = `<option value="">Both</option><option>${A}</option><option>${H}</option>`;
    $("projOut").classList.remove("hidden");
    renderProps();
  }

  function hist(svg, data, lo, hi, mark, label) {
    const W = 600, Hh = 200, pad = 22, bins = hi - lo + 1, counts = new Array(bins).fill(0);
    for (const x of data) if (x >= lo && x <= hi) counts[x - lo]++;
    const max = Math.max(...counts), bw = (W - 2 * pad) / bins;
    let h = "";
    counts.forEach((c, i) => {
      const bh = (c / max) * (Hh - 2 * pad), x = pad + i * bw;
      const v = lo + i;
      const color = mark != null && v > mark ? "#3ecf8e" : "#4aa3ff";
      h += `<rect x="${x + 0.5}" y="${Hh - pad - bh}" width="${Math.max(1, bw - 1)}" height="${bh}" fill="${color}" opacity=".8"><title>${v}: ${(c / data.length * 100).toFixed(1)}%</title></rect>`;
    });
    for (let v = Math.ceil(lo / 7) * 7; v <= hi; v += 7) h += `<text x="${pad + (v - lo + 0.5) * bw}" y="${Hh - 5}" fill="#7d8ea1" font-size="11" font-family="monospace" text-anchor="middle">${v}</text>`;
    if (mark != null) {
      const x = pad + (mark - lo + 0.5) * bw;
      h += `<line x1="${x}" x2="${x}" y1="${pad - 6}" y2="${Hh - pad}" stroke="#f2c94c" stroke-dasharray="3 3"/><text x="${x + 4}" y="${pad}" fill="#f2c94c" font-size="11" font-family="monospace">market ${mark}</text>`;
    }
    svg.innerHTML = h;
  }

  function renderProps() {
    if (!projResult) return;
    const k = $("statSel").value, tf = $("teamFilter").value;
    const ps = Object.values(projResult.players).filter((p) => (!tf || p.team === tf));
    const minMean = { py: 20, pc: 2, ptd: 0.05, pint: 0.05, ra: 1, ry: 5, rec: 0.5, recy: 5, rry: 5, td: 0.03, pts: 1 }[k];
    const rows = ps.map((p) => ({ p, d: p.d[k], m: meanOf(p.d[k]) })).filter((x) => x.m >= minMean).sort((a, b) => b.m - a.m);
    if (k === "td") {
      $("propTable").innerHTML = `<tr><th>Player</th><th>Team</th><th>Avg TDs</th><th>Anytime TD</th><th>Fair odds</th><th>2+ TDs</th></tr>` +
        rows.map(({ p, d, m }) => {
          const p1 = pOver(d, 0.5), p2 = pOver(d, 1.5);
          return `<tr><td>${p.name}<span class="pos">${p.pos}</span></td><td><span class="teamtag" style="background:${col(p.team)}"></span>${p.team}</td><td>${m.toFixed(2)}</td><td>${pct(p1)}</td><td>${american(p1)}</td><td>${pct(p2)}</td></tr>`;
        }).join("");
      return;
    }
    $("propTable").innerHTML = `<tr><th>Player</th><th>Team</th><th>Mean</th><th>Median</th><th>10th–90th</th><th>Line</th><th>Over</th><th>Under</th><th>Fair over</th><th>Fair under</th></tr>` +
      rows.map(({ p, d, m }) => {
        const key = p.id + "|" + k;
        const med = quant(d, 0.5);
        const line = lines[key] != null ? lines[key] : Math.floor(med) + 0.5;
        const o = pOver(d, line);
        const under = d.filter((x) => x < line).length / d.length;
        const cls = lines[key] != null ? (o >= 0.56 ? "edge-hi" : under >= 0.56 ? "edge-lo" : "") : "";
        return `<tr><td>${p.name}<span class="pos">${p.pos}</span></td><td><span class="teamtag" style="background:${col(p.team)}"></span>${p.team}</td>
          <td>${m.toFixed(1)}</td><td>${med}</td><td>${quant(d, 0.1)}–${quant(d, 0.9)}</td>
          <td><input data-key="${key}" type="number" step="0.5" value="${line}"></td>
          <td class="${cls && o >= 0.56 ? cls : ""}">${pct(o)}</td><td class="${cls && under >= 0.56 ? cls : ""}">${pct(under)}</td><td>${american(o)}</td><td>${american(under)}</td></tr>`;
      }).join("");
    $("propTable").querySelectorAll("input").forEach((inp) => (inp.onchange = () => { lines[inp.dataset.key] = +inp.value; renderProps(); }));
  }

  // ---------------- roster ----------------
  function renderRoster() {
    const block = (t) => {
      const ps = model.teams[t].players;
      return `<div class="team"><h3 style="color:${col(t)}">${t}</h3><div class="hdr"><span></span><span>Player</span><span>Status</span><span>Carry %</span><span>Target %</span></div>` +
        ps.map((p) => `<label class="${outSet.has(p.id) ? "off" : ""}"><input type="checkbox" data-id="${p.id}" ${outSet.has(p.id) ? "" : "checked"}>
          <span>${p.name} <span class="pos">${p.pos}</span></span><span class="st">${p.status || (p.gone ? "Inactive" : p.out ? "Not active" : "")}</span>
          <span>${(p.rush_share * 100).toFixed(0)}%</span><span>${(p.tgt_share * 100).toFixed(0)}%</span></label>`).join("") + "</div>";
    };
    $("rosters").innerHTML = block(cur.away) + block(cur.home);
    $("rosters").querySelectorAll("input").forEach((c) => (c.onchange = () => {
      if (c.checked) outSet.delete(c.dataset.id); else outSet.add(c.dataset.id);
      c.closest("label").classList.toggle("off", !c.checked);
      projStale = true;
      newGame(seed);
    }));
  }
})();
