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
  let qbSel = { away: "", home: "" };
  let legs = [], bookOdds = ""; // "" = automatic (most recent starter who isn't ruled out)

  // ---------------- boot ----------------
  fetch("data/model.json").then((r) => r.json()).then((m) => {
    model = m;
    $("dataLine").textContent = `${m.season} season · data through week ${m.through_week} · built ${m.generated}`;
    initPicker();
    initTabs();
    initControls();
    fromHash() || selectGame(defaultGame());
    booted = true;
    initEdgeControls();
    fetchEdges();
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
    document.addEventListener("change", (e) => {
      const el = e.target.closest("[data-wx]");
      if (!el) return;
      wxState[el.dataset.wx] = el.type === "number" ? +el.value : el.value;
      weatherChanged();
    });
    renderGames();
  }
  function renderGames() {
    const w = +$("weekSel").value;
    $("gameList").innerHTML = model.schedule.filter((g) => g.week === w).map((g) => {
      const fin = g.home_score != null ? ` <span class="fin">${g.away_score}-${g.home_score}</span>` : "";
      const sel = g.away === cur.away && g.home === cur.home ? "sel" : "";
      const ec = g.home_score == null ? edgeCount(g.away, g.home) : 0;
      const dot = ec ? `<span class="edot" title="${ec} model edges of 5%+ on the edge board">${ec}</span>` : "";
      return `<button class="${sel}" data-a="${g.away}" data-h="${g.home}">${g.away} @ ${g.home}${fin}${dot}</button>`;
    }).join("");
    $("gameList").querySelectorAll("button").forEach((b) => (b.onclick = () => selectGame({ away: b.dataset.a, home: b.dataset.h })));
  }
  function schedFor(a, h) {
    return model.schedule.find((g) => g.away === a && g.home === h && g.week === model.target_week) ||
      model.schedule.find((g) => g.away === a && g.home === h && g.home_score == null) || null;
  }
  let booted = false;
  function selectGame(g, s) {
    if (!model.teams[g.away] || !model.teams[g.home]) return;
    if (booted) edScope = "game";
    cur = { away: g.away, home: g.home };
    $("awaySel").value = g.away; $("homeSel").value = g.home;
    outSet = new Set(NFLSim.defaultOut(model, [g.away, g.home]));
    qbSel = { away: "", home: "" };
    legs = [];
    document.documentElement.style.setProperty("--away", col(g.away));
    document.documentElement.style.setProperty("--home", col(g.home));
    renderGames(); renderRoster(); renderWeather();
    projStale = true; projResult = null;
    $("projOut").classList.add("hidden"); $("runInfo").textContent = "";
    newGame(s || randSeed());
    if (edges && $("tab-edges").classList.contains("active")) renderEdges();
  }
  const randSeed = () => Math.floor(Math.random() * 1e9);

  // ---------------- weather ----------------
  function wxFeatures(temp, wind, precip) { // same definitions as scripts/weather.py
    return { wind: Math.max(0, Math.min(30, (wind == null ? 8 : wind) - 10)), cold: Math.max(0, Math.min(45, 40 - (temp == null ? 60 : temp))),
      rain: precip === "rain" ? 1 : 0, snow: precip === "snow" ? 1 : 0 };
  }
  const wxState = { mode: "auto", temp: 30, wind: 20, precip: "none" };
  const impactCache = {};
  function currentWeather() {
    const g = schedFor(cur.away, cur.home) || model.schedule.find((x) => x.away === cur.away && x.home === cur.home);
    const stadium = (g && g.stadium) || "";
    if (wxState.mode === "none") return { kind: "off", features: null, stadium };
    if (wxState.mode === "custom") {
      const w = { temp: wxState.temp, wind: wxState.wind, rain: wxState.precip === "rain" ? 1 : 0, snow: wxState.precip === "snow" ? 1 : 0 };
      return { kind: "custom", w, features: wxFeatures(w.temp, w.wind, wxState.precip), stadium };
    }
    const w = g && g.weather;
    if (!w) return { kind: "none", features: null, stadium };
    if (w.source === "indoor") return { kind: "indoor", roof: w.roof, features: null, stadium };
    return { kind: w.source, w, features: w.features, stadium };
  }
  function severity(f) {
    if (!f) return "calm";
    if (f.wind >= 10 || f.snow >= 0.4 || f.rain >= 0.5 || f.cold >= 20) return "severe";
    if (f.wind >= 4 || f.cold >= 8 || f.rain >= 0.2 || f.snow > 0) return "mild";
    return "calm";
  }
  function renderWeather() {
    const cw = currentWeather(), w = cw.w || {}, f = cw.features;
    let sev, icon, big, badge, lines = [], src;
    if (cw.kind === "indoor") {
      sev = "indoor"; icon = "🏟️"; big = "Indoors"; badge = cw.roof === "dome" ? "Dome" : "Roof closed";
      lines = ["No weather effect"]; src = cw.stadium;
    } else if (cw.kind === "none") {
      sev = "none"; icon = "🗓️"; big = "—"; badge = "No forecast yet";
      lines = ["Forecasts appear about 2 weeks before kickoff"]; src = cw.stadium;
    } else if (cw.kind === "off") {
      sev = "none"; icon = "🚫"; big = "Off"; badge = "Weather ignored"; lines = ["Simulating neutral conditions"]; src = cw.stadium;
    } else {
      sev = severity(f);
      icon = w.snow > 0 ? "❄️" : w.rain >= 0.3 ? "🌧️" : (w.wind || 0) >= 18 ? "💨" : (w.temp || 60) <= 32 ? "🥶" : (w.precip_prob || 0) >= 30 ? "🌥️" : "☀️";
      big = (w.temp != null ? w.temp : "–") + "°";
      badge = { severe: "Weather game", mild: "Some weather", calm: "Good conditions" }[sev];
      lines.push(`💨 ${w.wind != null ? w.wind : "–"} mph${w.gusts ? ` · gusts ${w.gusts}` : ""}`);
      if (w.snow > 0) lines.push(`❄️ ${w.precip_prob != null ? w.precip_prob + "% " : ""}snow`);
      else if (w.precip_prob != null) lines.push(`💧 ${w.precip_prob}% rain`);
      else if (w.rain) lines.push("💧 rain");
      src = (cw.kind === "forecast" ? "Forecast for kickoff" : cw.kind === "observed" ? "Reported at kickoff" : "Custom conditions") + (cw.stadium ? " · " + cw.stadium : "");
    }
    const key = `${cur.away}|${cur.home}|${JSON.stringify(f)}|${[...outSet].sort().join(",")}|${qbSel.away}|${qbSel.home}`;
    const imp = f ? impactCache[key] : 0;
    const impHtml = f ? `<div class="wx-impact"><div class="k">Scoring impact</div><div class="v">${imp == null ? "…" : (imp > 0 ? "+" : imp < 0 ? "−" : "") + Math.abs(imp).toFixed(1)}</div><div class="s">pts on total</div></div>` : "<div></div>";
    const edit = `<div class="wx-edit"><select data-wx="mode" title="Weather the simulation uses">
        <option value="auto" ${wxState.mode === "auto" ? "selected" : ""}>Use forecast / actual</option>
        <option value="none" ${wxState.mode === "none" ? "selected" : ""}>Ignore weather</option>
        <option value="custom" ${wxState.mode === "custom" ? "selected" : ""}>Custom…</option></select>
      ${wxState.mode === "custom" ? `<input data-wx="temp" type="number" value="${wxState.temp}">°F <input data-wx="wind" type="number" value="${wxState.wind}">mph
        <select data-wx="precip">${["none", "rain", "snow"].map((v) => `<option value="${v}" ${wxState.precip === v ? "selected" : ""}>${v === "none" ? "dry" : v}</option>`).join("")}</select>` : ""}</div>`;
    const html = `<div class="wxcard sev-${sev}"><div class="wx-icon">${icon}</div>
      <div><div class="wx-top"><span class="wx-temp">${big}</span><span class="wx-badge">${badge}</span></div>
      <div class="wx-lines">${lines.map((l) => `<span>${l}</span>`).join("")}</div><div class="wx-src">${src || ""}</div></div>${impHtml}${edit}</div>`;
    document.querySelectorAll(".wxslot").forEach((el) => (el.innerHTML = html));
    if (f && imp == null) setTimeout(() => {               // quick estimate: 800 sims with vs. without the weather
      const base = Object.assign(simOpts(), { seed: 99 });
      const tot = (o) => { const a = NFLSim.simulateMany(model, o, 800); let t = 0; for (let i = 0; i < a.n; i++) t += a.home[i] + a.away[i]; return t / a.n; };
      impactCache[key] = tot(base) - tot(Object.assign({}, base, { weather: null }));
      renderWeather();
    }, 50);
  }
  function weatherChanged() { renderWeather(); projStale = true; newGame(seed); if ($("tab-proj").classList.contains("active")) runProjections(); }
  function simOpts() {
    return { away: cur.away, home: cur.home, out: [...outSet], neutral: $("neutralChk").checked,
      weather: currentWeather().features, qb: { away: qbSel.away || undefined, home: qbSel.home || undefined } };
  }

  // ---------------- tabs ----------------
  function initTabs() {
    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
      if (t.dataset.tab === "proj" && projStale) runProjections();
      if (t.dataset.tab === "score") loadScorecard();
      if (t.dataset.tab === "edges") loadEdges();
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
    $("legType").onchange = renderLegInputs;
    $("legAdd").onclick = addLegFromForm;
    $("propTable").addEventListener("click", (e) => {
      const b = e.target.closest(".addleg"); if (!b) return;
      const d = b.dataset;
      addLeg(d.stat === "td" ? { type: "td", pid: d.pid } : { type: "prop", pid: d.pid, stat: d.stat, dir: d.dir, line: +d.line });
    });
    $("legTable").addEventListener("click", (e) => {
      const b = e.target.closest(".rm"); if (!b) return;
      legs.splice(+b.dataset.i, 1); renderParlay();
    });
    $("sgpCards").addEventListener("change", (e) => { if (e.target.id === "bookOdds") { bookOdds = e.target.value; renderParlay(); } });
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
    game = NFLSim.simulateGame(model, Object.assign(simOpts(), { seed, log: true }));
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
    const opts = Object.assign(simOpts(), { seed: 12345 });
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
        finish(NFLSim.summarize(NFLSim.simulateMany(model, opts, n)));
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
    renderLegInputs();
    renderParlay();
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
      $("propTable").innerHTML = `<tr><th>Player</th><th>Team</th><th>Avg TDs</th><th>Anytime TD</th><th>Fair odds</th><th>2+ TDs</th><th>Parlay</th></tr>` +
        rows.map(({ p, d, m }) => {
          const p1 = pOver(d, 0.5), p2 = pOver(d, 1.5);
          return `<tr><td>${p.name}<span class="pos">${p.pos}</span></td><td><span class="teamtag" style="background:${col(p.team)}"></span>${p.team}</td><td>${m.toFixed(2)}</td><td>${pct(p1)}</td><td>${american(p1)}</td><td>${pct(p2)}</td><td><button class="addleg" data-pid="${p.id}" data-stat="td" title="Add to parlay">+</button></td></tr>`;
        }).join("");
      return;
    }
    $("propTable").innerHTML = `<tr><th>Player</th><th>Team</th><th>Mean</th><th>Median</th><th>10th–90th</th><th>Line</th><th>Over</th><th>Under</th><th>Fair over</th><th>Fair under</th><th>Parlay</th></tr>` +
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
          <td class="${cls && o >= 0.56 ? cls : ""}">${pct(o)}</td><td class="${cls && under >= 0.56 ? cls : ""}">${pct(under)}</td><td>${american(o)}</td><td>${american(under)}</td>
          <td><button class="addleg" data-pid="${p.id}" data-stat="${k}" data-dir="over" data-line="${line}" title="Add over to parlay">+O</button><button class="addleg" data-pid="${p.id}" data-stat="${k}" data-dir="under" data-line="${line}" title="Add under to parlay">+U</button></td></tr>`;
      }).join("");
    $("propTable").querySelectorAll("input").forEach((inp) => (inp.onchange = () => { lines[inp.dataset.key] = +inp.value; renderProps(); }));
  }

  // ---------------- parlay builder ----------------
  const STAT_NAMES = { py: "pass yds", pc: "completions", ptd: "pass TDs", pint: "INTs", ra: "rush att", ry: "rush yds", rec: "receptions", recy: "rec yds", rry: "rush+rec yds", pts: "kicker pts" };
  function legPlayers() {
    return Object.values(projResult.players).filter((p) => p.d.py[p.d.py.length - 1] > 0 || p.d.rry[p.d.rry.length - 1] > 0 || p.d.pts[p.d.pts.length - 1] > 0)
      .sort((a, b) => (a.team === b.team ? 0 : a.team === cur.away ? -1 : 1) || meanOf(b.r.rry) + meanOf(b.r.py) - meanOf(a.r.rry) - meanOf(a.r.py));
  }
  function renderLegInputs() {
    if (!projResult) return;
    const t = $("legType").value, A = cur.away, H = cur.home;
    const teamSel = `<select id="lgTeam"><option>${A}</option><option>${H}</option></select>`;
    const dirSel = `<select id="lgDir"><option value="over">Over</option><option value="under">Under</option></select>`;
    const line = (v) => `<input id="lgLine" type="number" step="0.5" value="${v}">`;
    const sg = schedFor(A, H);
    const plSel = () => `<select id="lgPid">${legPlayers().map((p) => `<option value="${p.id}">${p.team} · ${p.name} (${p.pos})</option>`).join("")}</select>`;
    const statSel = `<select id="lgStat">${Object.entries(STAT_NAMES).map(([k, v]) => `<option value="${k}" ${k === "recy" ? "selected" : ""}>${v}</option>`).join("")}</select>`;
    $("legInputs").innerHTML = {
      ml: teamSel,
      spread: teamSel + line(sg && sg.spread != null ? -Math.abs(sg.spread) : -3.5),
      total: dirSel + line(sg && sg.total != null ? sg.total : 44.5),
      teamtotal: teamSel + dirSel + line(21.5),
      prop: plSel() + statSel + dirSel + line(49.5),
      td: plSel(),
    }[t];
  }
  function addLegFromForm() {
    const t = $("legType").value, v = (id) => ($(id) ? $(id).value : null);
    const leg = { type: t };
    if ($("lgTeam")) leg.team = v("lgTeam");
    if ($("lgDir")) leg.dir = v("lgDir");
    if ($("lgLine")) leg.line = +v("lgLine");
    if ($("lgPid")) leg.pid = v("lgPid");
    if ($("lgStat")) leg.stat = v("lgStat");
    addLeg(leg);
  }
  function addLeg(leg) {
    if (legs.length >= 10) return;
    legs.push(leg); renderParlay();
    document.querySelector(".sgp").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function legLabel(l) {
    const P = (id) => (projResult.players[id] || { name: id }).name;
    const sgn = (x) => (x > 0 ? "+" + x : "" + x);
    switch (l.type) {
      case "ml": return `${l.team} to win`;
      case "spread": return `${l.team} ${sgn(l.line)}`;
      case "total": return `Game ${l.dir} ${l.line}`;
      case "teamtotal": return `${l.team} ${l.dir} ${l.line} pts`;
      case "prop": return `${P(l.pid)} ${l.dir} ${l.line} ${STAT_NAMES[l.stat]}`;
      case "td": return `${P(l.pid)} anytime TD`;
    }
  }
  function legHits(l) {               // 1/0 per simulated game, in sim order
    const r = projResult, n = r.n, out = new Uint8Array(n);
    const pts = (team, i) => (team === cur.home ? r.home[i] : r.away[i]);
    const opp = (team) => (team === cur.home ? cur.away : cur.home);
    const pl = r.players[l.pid];
    for (let i = 0; i < n; i++) {
      let h = false;
      switch (l.type) {
        case "ml": h = pts(l.team, i) > pts(opp(l.team), i); break;
        case "spread": h = pts(l.team, i) - pts(opp(l.team), i) + l.line > 0; break;
        case "total": { const t = r.home[i] + r.away[i]; h = l.dir === "over" ? t > l.line : t < l.line; break; }
        case "teamtotal": { const t = pts(l.team, i); h = l.dir === "over" ? t > l.line : t < l.line; break; }
        case "prop": { const v = pl ? pl.r[l.stat][i] : 0; h = l.dir === "over" ? v > l.line : v < l.line; break; }
        case "td": h = pl ? pl.r.td[i] >= 1 : false; break;
      }
      out[i] = h ? 1 : 0;
    }
    return out;
  }
  function decimalFromAmerican(a) { a = +a; if (!a) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function renderParlay() {
    if (!projResult) return;
    const n = projResult.n;
    if (!legs.length) { $("legTable").innerHTML = ""; $("sgpCards").innerHTML = `<div class="card"><div class="k">No legs yet</div><div class="s">Add 2+ legs to price a parlay</div></div>`; return; }
    const hits = legs.map(legHits);
    const probs = hits.map((h) => h.reduce((a, b) => a + b, 0) / n);
    let all = 0;
    for (let i = 0; i < n; i++) { let ok = 1; for (const h of hits) if (!h[i]) { ok = 0; break; } all += ok; }
    const joint = all / n, indep = probs.reduce((a, b) => a * b, 1);
    $("legTable").innerHTML = `<tr><th>Leg</th><th></th><th>Hit %</th><th>Fair odds</th><th></th></tr>` +
      legs.map((l, i) => `<tr><td>${legLabel(l)}</td><td></td><td>${pct(probs[i])}</td><td>${american(probs[i])}</td><td><button class="rm" data-i="${i}" title="Remove leg">✕</button></td></tr>`).join("");
    const corr = indep > 0 ? joint / indep : 0;
    const dec = decimalFromAmerican(bookOdds);
    const ev = dec ? joint * dec - 1 : null;
    const cards = [
      ["All legs hit", pct(joint), `${all.toLocaleString()} of ${n.toLocaleString()} sims`],
      ["Fair parlay odds", american(joint), joint ? `decimal ${(1 / joint).toFixed(2)}` : "never hit"],
      ["If legs were independent", pct(indep), `fair ${american(indep)}`],
      ["Correlation", legs.length > 1 ? corr.toFixed(2) + "×" : "–", legs.length > 1 ? (corr > 1.05 ? "legs help each other" : corr < 0.95 ? "legs work against each other" : "roughly independent") : "add another leg"],
    ];
    $("sgpCards").innerHTML = cards.map(([k, v, s]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("") +
      `<div class="card"><div class="k">Book's parlay odds</div><input id="bookOdds" type="text" placeholder="+450" value="${bookOdds}">
        <div class="s ${ev == null ? "" : ev > 0 ? "ev-pos" : "ev-neg"}">${ev == null ? "enter odds to see expected value" : `model EV ${ev > 0 ? "+" : ""}${(ev * 100).toFixed(1)}% per $1`}</div></div>`;
  }

  // ---------------- edge board ----------------
  let edges = null, edScope = "all", edLoading = null;
  const edState = { kind: "", min: 0.03 };
  function fetchEdges() {
    if (!edLoading) edLoading = fetch("data/edges.json?" + Date.now()).then((r) => { if (!r.ok) throw 0; return r.json(); })
      .then((e) => { edges = e; renderGames(); return e; }).catch(() => null);
    return edLoading;
  }
  function loadEdges() {
    fetchEdges().then((e) => {
      if (!e) {
        $("edMeta").textContent = "";
        $("edGames").innerHTML = `<div class="edgame"><div class="eempty">No lines yet. The board fills in after the next daily update.</div></div>`;
        return;
      }
      renderEdges();
    });
  }
  function edgeCount(away, home) {
    if (!edges) return 0;
    return edges.bets.filter((b) => b.game === away + "@" + home && b.ev >= 0.05).length;
  }
  function initEdgeControls() {
    document.querySelectorAll("#edKind button, #edMin button").forEach((b) => (b.onclick = () => {
      b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      if (b.parentElement.id === "edKind") edState.kind = b.dataset.v; else edState.min = +b.dataset.v;
      renderEdges();
    }));
    $("edBest").onchange = renderEdges;
    $("edScope").onclick = (e) => { if (e.target.closest("button")) { edScope = "all"; renderEdges(); } };
    const goGame = (el, tab) => {
      selectGame({ away: el.dataset.a, home: el.dataset.h });
      if (tab) document.querySelector(`.tab[data-tab="${tab}"]`).click();
    };
    $("edGames").addEventListener("click", (e) => {
      const open = e.target.closest(".eg-open"); if (open) return goGame(open, "watch");
      const head = e.target.closest(".eg-head"); if (head) goGame(head);
    });
    $("edTop").addEventListener("click", (e) => { const c = e.target.closest(".topcard"); if (c) goGame(c); });
  }
  function renderEdges() {
    const e = edges; if (!e) return;
    const fmtT = (t) => (t ? new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "–");
    $("edMeta").textContent = `Lines updated ${fmtT(e.updated)} · ${e.games.length} games · ${e.bets.length} bets priced` +
      (e.credits_remaining != null ? ` · ${e.credits_remaining} API credits left` : "");
    const focus = edScope === "game" ? cur.away + "@" + cur.home : null;
    const inScope = !focus || e.games.some((g) => g.game === focus);
    $("edScope").innerHTML = focus
      ? `<span class="chip">Showing ${cur.away} @ ${cur.home}${inScope ? "" : " (no lines)"} <button title="Show every game">✕ all games</button></span>`
      : "All games · pick a game above to focus on it";
    let list = e.bets.filter((b) => (!focus || b.game === focus) && (!edState.kind || (edState.kind === "prop" ? b.kind === "prop" : b.kind !== "prop")));
    if ($("edBest").checked) {
      const seen = new Set();
      list = list.filter((b) => { const k = b.game + "|" + b.kind + "|" + (b.player || "") + "|" + (b.stat || "") + "|" + (b.kind === "ml" ? "ml" : Math.abs(b.line)); if (seen.has(k)) return false; seen.add(k); return true; });
    }
    const shown = list.filter((b) => b.ev >= edState.min);
    const gameOf = (b) => e.games.find((x) => x.game === b.game) || { away: b.game.split("@")[0], home: b.game.split("@")[1] };
    const tier = (ev) => (ev >= 0.1 ? 3 : ev >= 0.05 ? 2 : ev >= 0 ? 1 : 0);
    const signed = (x, d = 1) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x * 100).toFixed(d);
    const priceTxt = (p) => (p > 0 ? "+" + p : "" + p);
    const bar = (b) => `<div class="pbar"><i class="${b.p >= b.p_implied ? "" : "neg"}" style="width:${(b.p * 100).toFixed(1)}%"></i><b style="left:calc(${(b.p_implied * 100).toFixed(1)}% - 1px)"></b></div>`;
    const tag = (b) => ({ ml: "ML", spread: "SPREAD", total: "TOTAL", prop: b.stat === "td" ? "TD" : "PROP" })[b.kind];
    const flags = (b) => (b.out_in_model ? `<span class="flag red" title="Ruled out or unused in the model">out in model</span>` : "") +
      (b.ev > 0.2 ? `<span class="flag" title="Gaps this big usually mean the model is missing news">check news</span>` : "");

    // top plays
    const top = shown.filter((b) => b.ev > 0).slice(0, 4);
    $("edTop").innerHTML = top.map((b, i) => {
      const g = gameOf(b);
      return `<div class="topcard" style="--tier:${b.ev > 0.2 ? "var(--accent)" : "var(--good)"}" data-a="${g.away}" data-h="${g.home}" title="Open this game">
        <span class="rank">#${i + 1}</span><div class="tc-game">${g.away} @ ${g.home} · ${fmtT(b.commence)}</div>
        <div class="tc-bet">${b.label}${flags(b)}</div>
        <div class="tc-row"><span class="price">${priceTxt(b.price)}</span><span class="bookpill">${b.book || ""}</span><span class="tc-ev">${signed(b.ev)}%</span></div>
        ${bar(b)}<div class="tc-cap"><span>Model ${(b.p * 100).toFixed(0)}%</span><span>Book ${(b.p_implied * 100).toFixed(0)}%</span><span>EV</span></div></div>`;
    }).join("");

    // grouped by game
    const games = e.games.filter((g) => !focus || g.game === focus).sort((a, b) => (a.commence < b.commence ? -1 : 1));
    const hdr = `<div class="erow hdr"><span>Bet</span><span>Best price</span><span>Model vs book</span><span style="text-align:right">Edge</span><span style="text-align:right">EV</span><span style="text-align:right">Median</span></div>`;
    $("edGames").innerHTML = games.map((g) => {
      const rows = shown.filter((b) => b.game === g.game);
      if (!rows.length && !focus) return "";
      const fav = g.p_home >= 0.5 ? g.home : g.away, fp = Math.max(g.p_home, 1 - g.p_home);
      const pa = (g.proj_total / 2 - g.proj_margin / 2).toFixed(0), ph = (g.proj_total / 2 + g.proj_margin / 2).toFixed(0);
      const n5 = rows.filter((b) => b.ev >= 0.05).length;
      return `<div class="edgame ${focus ? "focus" : ""}">
        <div class="eg-head" style="--a:${col(g.away)};--h:${col(g.home)}" data-a="${g.away}" data-h="${g.home}" title="Focus this game">
          <span class="eg-teams"><span style="color:${col(g.away)}">${g.away}</span> @ <span style="color:${col(g.home)}">${g.home}</span></span>
          <span class="eg-time">${fmtT(g.commence)}</span>
          <span class="eg-model">Model: ${fav} ${(fp * 100).toFixed(0)}% · proj ${g.away} ${pa}–${ph} ${g.home}</span>
          <span class="eg-count ${n5 ? "" : "zero"}">${n5} edge${n5 === 1 ? "" : "s"} 5%+</span>
          <button class="eg-open" data-a="${g.away}" data-h="${g.home}">Simulate ▸</button></div>
        ${rows.length ? hdr + rows.map((b) => `<div class="erow">
            <div class="ebet"><span class="tag">${tag(b)}</span>${b.label}${flags(b)}</div>
            <div><span class="price">${priceTxt(b.price)}</span> <span class="bookpill">${b.book || ""}</span></div>
            <div class="eprob">${bar(b)}<div class="lbl"><span>model ${(b.p * 100).toFixed(1)}%</span><span>book ${(b.p_implied * 100).toFixed(1)}%</span></div></div>
            <div class="eedge ${b.p >= b.p_implied ? "edge-hi" : "edge-lo"}">${signed(b.p - b.p_implied)}</div>
            <div class="evb t${tier(b.ev)}">${signed(b.ev)}%</div>
            <div class="emed">${b.median != null ? b.median : ""}</div></div>`).join("")
          : `<div class="eempty">Nothing at this threshold${g.props ? "" : " · player props appear about 30 hours before kickoff"}.</div>`}
      </div>`;
    }).join("") || `<div class="edgame"><div class="eempty">Nothing at this threshold.</div></div>`;
  }

  // ---------------- scorecard ----------------
  let scHist = null;
  function loadScorecard() {
    if (scHist) return renderScorecard();
    fetch("data/history.json?" + Date.now()).then((r) => r.json()).then((h) => {
      scHist = h;
      const weeks = [...new Set(Object.values(h.games).map((g) => g.week))].sort((a, b) => a - b);
      $("scWeek").innerHTML = `<option value="">All</option>` + weeks.map((w) => `<option>${w}</option>`).join("");
      $("scFilter").onchange = $("scWeek").onchange = renderScorecard;
      renderScorecard();
    }).catch(() => { $("scCards").innerHTML = `<div class="card"><div class="k">No history yet</div><div class="s">It fills in after the first daily update.</div></div>`; });
  }
  function grade(g) {
    const m = g.home_score - g.away_score, t = g.home_score + g.away_score, out = { m, t };
    out.su = m === 0 ? 0 : (g.p_home > 0.5) === (m > 0) ? 1 : -1;
    out.suMkt = m === 0 || g.spread == null || g.spread === 0 ? null : (g.spread > 0) === (m > 0) ? 1 : -1;
    if (g.spread != null && g.p_home_cover != null) {
      out.atsSide = g.p_home_cover >= 0.5 ? "home" : "away";
      out.atsP = Math.max(g.p_home_cover, 1 - g.p_home_cover);
      const r = m - g.spread; out.ats = r === 0 ? 0 : (r > 0) === (out.atsSide === "home") ? 1 : -1;
    }
    if (g.total != null && g.p_over != null) {
      out.ouSide = g.p_over >= 0.5 ? "over" : "under";
      out.ouP = Math.max(g.p_over, 1 - g.p_over);
      const r = t - g.total; out.ou = r === 0 ? 0 : (r > 0) === (out.ouSide === "over") ? 1 : -1;
    }
    if (g.home_ml && g.away_ml && m !== 0) {
      const ip = (x) => (x < 0 ? -x / (-x + 100) : 100 / (x + 100));
      const mkt = ip(g.home_ml) / (ip(g.home_ml) + ip(g.away_ml)), y = m > 0 ? 1 : 0;
      out.brier = (g.p_home - y) ** 2; out.brierMkt = (mkt - y) ** 2;
    }
    return out;
  }
  const units = (r) => (r > 0 ? 0.9091 : r < 0 ? -1 : 0);
  function rec(list, key) {
    const w = list.filter((x) => x[key] === 1).length, l = list.filter((x) => x[key] === -1).length, p = list.filter((x) => x[key] === 0).length;
    const u = list.reduce((a, x) => a + (x[key] == null ? 0 : units(x[key])), 0);
    return { w, l, p, u, pct: w + l ? w / (w + l) : 0, txt: `${w}–${l}${p ? "–" + p : ""}` };
  }
  function renderScorecard() {
    const f = $("scFilter").value, wk = $("scWeek").value;
    const all = Object.values(scHist.games).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const sel = all.filter((g) => (!wk || g.week === +wk) && (f === "all" || (f === "live" ? !g.backfill : g.backfill)));
    const done = sel.filter((g) => g.final).map((g) => Object.assign({ g }, grade(g)));
    const up = sel.filter((g) => !g.final);
    const su = rec(done, "su"), suM = rec(done, "suMkt"), ats = rec(done, "ats"), ou = rec(done, "ou");
    const strong = done.map((x) => ({ ats: x.atsP >= 0.55 ? x.ats : null, ou: x.ouP >= 0.55 ? x.ou : null }));
    const sA = rec(strong, "ats"), sO = rec(strong, "ou");
    const br = done.filter((x) => x.brier != null);
    const bM = br.reduce((a, x) => a + x.brier, 0) / (br.length || 1), bK = br.reduce((a, x) => a + x.brierMkt, 0) / (br.length || 1);
    const uTxt = (u) => (u >= 0 ? "+" : "−") + Math.abs(u).toFixed(2) + "u";
    const cls = (u) => (u > 0 ? "good" : u < 0 ? "bad" : "");
    const cards = [
      ["Picked the winner", `${(su.pct * 100).toFixed(0)}%`, `${su.txt} · market favorites ${(suM.pct * 100).toFixed(0)}%`, ""],
      ["Against the spread", ats.txt, `${(ats.pct * 100).toFixed(1)}% · ${uTxt(ats.u)}`, cls(ats.u)],
      ["Totals (over/under)", ou.txt, `${(ou.pct * 100).toFixed(1)}% · ${uTxt(ou.u)}`, cls(ou.u)],
      ["Strong picks (55%+)", `${sA.w + sO.w}–${sA.l + sO.l}`, `ATS ${sA.txt}, totals ${sO.txt} · ${uTxt(sA.u + sO.u)}`, cls(sA.u + sO.u)],
      ["Win-prob accuracy", bM.toFixed(3), `Brier score, lower is better · market ${bK.toFixed(3)}`, bM <= bK ? "good" : "bad"],
    ];
    $("scCards").innerHTML = cards.map(([k, v, s, c]) => `<div class="card"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`).join("");

    // cumulative units chart
    let cum = 0; const pts = [0];
    for (const x of done) { cum += (x.ats == null ? 0 : units(x.ats)) + (x.ou == null ? 0 : units(x.ou)); pts.push(cum); }
    const W = 1000, H = 220, pad = 28, lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = hi - lo || 1;
    const X = (i) => pad + (i / Math.max(1, pts.length - 1)) * (W - 2 * pad), Y = (v) => H - pad - ((v - lo) / span) * (H - 2 * pad);
    const path = pts.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    $("scChart").innerHTML = `<line x1="${pad}" x2="${W - pad}" y1="${Y(0)}" y2="${Y(0)}" stroke="#33475c" stroke-dasharray="4 4"/>
      <path d="${path}" fill="none" stroke="${cum >= 0 ? "#3ecf8e" : "#ef5b5b"}" stroke-width="2.5"/>
      <text x="${W - pad}" y="${Y(cum) - 8}" fill="#e8eef5" font-family="monospace" font-size="13" text-anchor="end">${uTxt(cum)}</text>
      <text x="${pad}" y="${H - 6}" fill="#7d8ea1" font-family="monospace" font-size="11">${done.length} games</text>
      <text x="4" y="${Y(hi) + 4}" fill="#7d8ea1" font-family="monospace" font-size="11">${hi.toFixed(1)}</text><text x="4" y="${Y(lo) + 4}" fill="#7d8ea1" font-family="monospace" font-size="11">${lo.toFixed(1)}</text>`;

    const res = (r) => (r == null ? "" : r > 0 ? "ok" : r < 0 ? "no" : "push");
    const mark = (r) => (r == null ? "" : r > 0 ? " ✓" : r < 0 ? " ✗" : " push");
    const fmtSpread = (g, side) => { const s = side === "home" ? -g.spread : g.spread; return `${g[side]} ${s > 0 ? "+" + s : s}`; };
    const rowsDone = done.slice().reverse().map((x) => {
      const g = x.g, fav = g.p_home >= 0.5 ? g.home : g.away, fp = Math.max(g.p_home, 1 - g.p_home);
      return `<tr><td>${g.week}</td><td>${g.away} @ ${g.home}${g.backfill ? '<span class="bf">backfill</span>' : ""}</td>
        <td>${g.away_score}–${g.home_score}</td>
        <td class="${res(x.su)}">${fav} ${(fp * 100).toFixed(0)}%${mark(x.su)}</td>
        <td>${(g.total_proj / 2 - g.margin / 2).toFixed(1)}–${(g.total_proj / 2 + g.margin / 2).toFixed(1)}</td>
        <td class="${res(x.ats)}">${x.atsSide ? fmtSpread(g, x.atsSide) + ` (${(x.atsP * 100).toFixed(0)}%)` + mark(x.ats) : "–"}</td>
        <td class="${res(x.ou)}">${x.ouSide ? `${x.ouSide === "over" ? "O" : "U"} ${g.total} (${(x.ouP * 100).toFixed(0)}%)` + mark(x.ou) : "–"}</td></tr>`;
    }).join("");
    const rowsUp = up.map((g) => {
      const fav = g.p_home >= 0.5 ? g.home : g.away, fp = Math.max(g.p_home, 1 - g.p_home);
      const aS = g.p_home_cover >= 0.5 ? "home" : "away", aP = Math.max(g.p_home_cover, 1 - g.p_home_cover);
      const oS = g.p_over >= 0.5 ? "O" : "U", oP = Math.max(g.p_over, 1 - g.p_over);
      return `<tr><td>${g.week}</td><td>${g.away} @ ${g.home} <span class="up">upcoming</span></td><td>–</td><td>${fav} ${(fp * 100).toFixed(0)}%</td>
        <td>${(g.total_proj / 2 - g.margin / 2).toFixed(1)}–${(g.total_proj / 2 + g.margin / 2).toFixed(1)}</td>
        <td>${g.spread != null ? fmtSpread(g, aS) + ` (${(aP * 100).toFixed(0)}%)` : "–"}</td><td>${g.total != null ? `${oS} ${g.total} (${(oP * 100).toFixed(0)}%)` : "–"}</td></tr>`;
    }).join("");
    $("scTable").innerHTML = `<tr><th>Wk</th><th>Game</th><th>Final</th><th>Model winner</th><th>Proj. score</th><th>Spread pick</th><th>Total pick</th></tr>` + rowsUp + rowsDone;
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
    const qbBlock = (side) => {
      const t = cur[side], qbs = model.teams[t].players.filter((p) => p.pos === "QB");
      const auto = qbs.filter((p) => !outSet.has(p.id) && p.db > 0).sort((a, b) => b.db - a.db)[0] || qbs.find((p) => !outSet.has(p.id));
      const pick = qbs.find((p) => p.id === qbSel[side]) || auto;
      const q = pick && pick.qb, mix = model.teams[t].off.qb_mix;
      const note = q && mix ? `vs. team's recent QB play: comp ${((q.comp - mix.comp) * 100).toFixed(1)} pts · INT ${((q.int - mix.int) * 100).toFixed(1)} pts · sacks ${((q.sack - mix.sack) * 100).toFixed(1)} pts · yds/comp ${((q.ypc / mix.ypc - 1) * 100).toFixed(0)}% · ${q.dropbacks} dropbacks of data` : "";
      return `<div class="team"><h3 style="color:${col(t)}">${t} starting QB</h3><select data-side="${side}">
        <option value="">Auto${auto ? " — " + auto.name : ""}</option>${qbs.map((p) => `<option value="${p.id}" ${qbSel[side] === p.id ? "selected" : ""}>${p.name}${p.status ? " (" + p.status + ")" : ""}${p.qb ? " · " + p.qb.dropbacks + " db" : ""}</option>`).join("")}
        </select><div class="qbnote">${note}</div></div>`;
    };
    $("qbPick").innerHTML = qbBlock("away") + qbBlock("home");
    $("qbPick").querySelectorAll("select").forEach((sel) => (sel.onchange = () => {
      qbSel[sel.dataset.side] = sel.value; projStale = true; renderRoster(); renderWeather(); newGame(seed);
    }));
    $("rosters").querySelectorAll("input").forEach((c) => (c.onchange = () => {
      if (c.checked) outSet.delete(c.dataset.id); else outSet.add(c.dataset.id);
      projStale = true;
      renderRoster(); renderWeather();
      newGame(seed);
    }));
  }
})();
