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
  let legs = [], bookOdds = "";
  let wpWorker = null, wpJob = 0, wpData = null; // win-probability series for the replay // "" = automatic (most recent starter who isn't ruled out)

  // remembered settings (per browser)
  const store = {
    get(k, d) { try { const v = localStorage.getItem("gs." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("gs." + k, JSON.stringify(v)); } catch (e) {} },
  };

  // offline support / installable app (needs https or localhost)
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

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
    const sp = store.get("speed", null);
    if (sp) { speed = +sp; $("speedSel").value = String(sp); }
    const fmt = store.get("fmt", null);
    if (fmt) { ft.fmt = fmt; $("ftFmt").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === fmt)); }
    const tab = store.get("tab", "today"), tb = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (tb && tab !== "today") tb.click(); else loadToday();
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
      store.set("tab", t.dataset.tab);
      document.body.dataset.tab = t.dataset.tab;
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
      if (t.dataset.tab === "proj" && projStale) runProjections();
      if (t.dataset.tab === "score") loadScorecard();
      if (t.dataset.tab === "edges") loadEdges();
      if (t.dataset.tab === "live") renderGameDay();
      if (t.dataset.tab === "fantasy") loadFantasy();
      if (t.dataset.tab === "season") loadSeason();
      if (t.dataset.tab === "today") loadToday();
    }));
  }

  // ---------------- watch ----------------
  function initControls() {
    $("btnPlay").onclick = () => (playing ? pause() : play());
    $("btnStep").onclick = () => { pause(); step(); };
    $("btnEnd").onclick = () => { pause(); idx = game.plays.length - 1; show(idx, false); showFinal(); };
    $("wpChart").onclick = (e) => {   // jump the replay to the clicked moment
      if (!wpData || !wpData.vals.length) return;
      const r = $("wpChart").getBoundingClientRect(), t = ((e.clientX - r.left) / r.width) * wpData.endT;
      let best = 0; game.plays.forEach((p, i) => { if (p.secs != null && elapsedOf(p.q, p.secs) <= t) best = i; });
      pause(); idx = best; show(idx, false);
    };
    $("btnNew").onclick = () => newGame(randSeed());
    $("speedSel").onchange = () => { speed = +$("speedSel").value; store.set("speed", speed); };
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
    startWP();
    $("btnPlay").textContent = "▶ Play";
  }

  // confidence label for a priced bet (same thresholds as scripts/today.js)
  function betConf(b) {
    if (b.ev > 0.2 || b.out_in_model) return "Check";
    if (b.ev >= 0.1 && b.p - b.p_implied >= 0.06) return "Strong";
    if (b.ev >= 0.04) return "Lean";
    return "Pass";
  }

  // ---------------- today ----------------
  let today = null, todayLoading = null;
  const conf = (l, title) => `<span class="conf ${l}" title="${title || ({ Strong: "Big gap between the model and the book", Lean: "Modest gap between the model and the book", Pass: "Model is close to the book", "Toss-up": "Too close to call", Check: "Gap is so big the model may be missing news: check injuries first" })[l] || ""}">${l}</span>`;
  function loadToday() {
    if (!todayLoading) todayLoading = fetch("data/today.json?" + (model ? model.generated : "")).then((r) => (r.ok ? r.json() : null)).then((t) => (today = t)).catch(() => null);
    todayLoading.then(renderToday);
  }
  const dayName = (d) => new Date(d + "T12:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  const kick = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"} ET`; };
  function renderToday() {
    const T = today;
    if (!T || !T.games.length) {
      $("tdHero").innerHTML = `<div><h2>Today</h2><p>No upcoming games in the next week, or previews haven't been built yet.</p></div>`;
      $("tdBest").innerHTML = ""; $("tdGames").innerHTML = ""; return;
    }
    const days = [...new Set(T.games.map((g) => g.date))];
    $("tdHero").innerHTML = `<div><h2>Week ${T.week} at a glance</h2><p>${T.games.length} games · previews built ${T.generated}${T.lines_updated ? " · lines from " + new Date(T.lines_updated).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""}</p></div>`;
    // best bets
    const betText = (b) => b.kind === "prop" ? b.text : b.text;
    $("tdBest").innerHTML = T.best_bets.length ? `<div class="td-best"><h3>The model's best bets</h3><div class="td-bets">${T.best_bets.map((b) => {
      const [a, h] = b.game.split("@");
      return `<div class="td-bet"><div class="gm">${a} @ ${h} · ${new Date(b.commence).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</div>
        <div class="bt">${b.pid ? `<span class="plink" data-pid="${b.pid}" data-stat="${b.stat}" data-line="${b.line}">${betText(b)}</span>` : betText(b)} ${conf(b.conf)}</div>
        <div class="why"><b>${b.price > 0 ? "+" + b.price : b.price}</b> at ${b.book}. Model gives it <b>${Math.round(b.p * 100)}%</b> vs. the book's ${Math.round(b.p_implied * 100)}%.</div></div>`;
    }).join("")}</div></div>` : "";
    // games by day
    const pickHtml = (k, v, label, sub) => `<div class="tg-pick"><div class="k">${k}</div><div class="v">${v}</div>${label ? conf(label) : ""}${sub ? `<div class="k" style="margin-top:3px;text-transform:none;letter-spacing:0">${sub}</div>` : ""}</div>`;
    const wxBadge = (g) => {
      const w = g.weather; if (!w) return "";
      if (w.source === "indoor") return `<span class="tg-wx">🏟️ indoors</span>`;
      const f = w.features || {}; const ic = f.snow > 0 ? "❄️" : f.rain >= 0.4 ? "🌧️" : (w.wind || 0) >= 18 ? "💨" : (w.temp || 60) <= 32 ? "🥶" : "☀️";
      return `<span class="tg-wx">${ic} ${w.temp != null ? w.temp + "°" : ""}${w.wind != null ? " · " + w.wind + " mph" : ""}</span>`;
    };
    $("tdGames").innerHTML = days.map((d) => `<div class="td-day">${dayName(d)}</div><div class="td-grid">${T.games.filter((g) => g.date === d).map((g) => {
      const A = g.away, H = g.home, pa = 1 - g.p_home;
      const sp = g.spread, tp = g.total_pick;
      return `<div class="tg" style="--a:${col(A)};--h:${col(H)}">
        <div class="tg-head"><div class="tg-team" style="color:${col(A)}">${A}<small>${Math.round(pa * 100)}% · ${g.pts_away.toFixed(0)} pts</small></div>
          <div class="tg-mid"><b>${kick(g.time)}</b>${g.neutral ? "neutral site" : "@ " + (g.stadium || H)}<br>${wxBadge(g)}</div>
          <div class="tg-team h" style="color:${col(H)}">${H}<small>${g.pts_home.toFixed(0)} pts · ${Math.round(g.p_home * 100)}%</small></div></div>
        <div class="tg-wp"><div style="flex:${pa};background:${col(A)}"></div><div style="flex:${g.p_home};background:${col(H)}"></div></div>
        <div class="tg-picks">
          ${pickHtml("Winner", `${g.winner.team} ${Math.round(g.winner.p * 100)}%`, g.winner.label)}
          ${sp ? pickHtml("Spread", `${sp.team} ${sp.line > 0 ? "+" : ""}${sp.line}`, sp.label, `${Math.round(sp.p * 100)}% to cover`) : pickHtml("Spread", "–")}
          ${tp ? pickHtml("Total", `${tp.side === "over" ? "Over" : "Under"} ${tp.line}`, tp.label, `proj ${g.total.toFixed(0)} · ${Math.round(tp.p * 100)}%`) : pickHtml("Total", g.total.toFixed(0))}
        </div>
        <div class="tg-text">${g.preview}</div>
        <details class="tg-why"><summary>Why? ▸</summary><ul>${g.reasons.map((r) => `<li><span>${r.icon}</span><span>${r.text}</span></li>`).join("")}</ul></details>
        ${g.watch.length ? `<div class="tg-watch"><span class="dim">Players to watch:</span>${g.watch.map((w) => `<span class="chip"><span class="plink" data-pid="${w.id}" data-stat="fp">${w.name}</span> <span class="dim">${w.ppr.toFixed(1)} pts</span></span>`).join("")}</div>` : ""}
        ${g.best_bet ? `<div class="tg-watch"><span class="dim">Best bet:</span> <span>${g.best_bet.pid ? `<span class="plink" data-pid="${g.best_bet.pid}" data-stat="${g.best_bet.stat}" data-line="${g.best_bet.line}">${g.best_bet.text}</span>` : g.best_bet.text} <b>${g.best_bet.price > 0 ? "+" + g.best_bet.price : g.best_bet.price}</b></span> ${conf(g.best_bet.conf)}</div>` : ""}
        <div class="tg-foot"><button data-go="watch" data-a="${A}" data-h="${H}">▶ Watch a sim</button><button data-go="proj" data-a="${A}" data-h="${H}">Props</button><button data-go="edges" data-a="${A}" data-h="${H}">Odds</button><button data-go="live" data-a="${A}" data-h="${H}">Game day</button></div>
      </div>`;
    }).join("")}</div>`).join("");
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("#tdGames [data-go]"); if (!b) return;
    selectGame({ away: b.dataset.a, home: b.dataset.h });
    document.querySelector(`.tab[data-tab="${b.dataset.go}"]`).click();
  });

  // ---------------- season ----------------
  let season = null, rhist = null;
  const se = { view: "odds", conf: "", team: null };
  function loadSeason() {
    if (season) return renderSeason();
    Promise.all([
      fetch("data/season.json?" + (model ? model.generated : "")).then((r) => (r.ok ? r.json() : null)),
      fetch("data/ratings_history.json?" + (model ? model.generated : "")).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([s2, h]) => {
      season = s2; rhist = h;
      if (!season) { $("seBody").innerHTML = `<div class="gd-card dim">Season projections appear after the next daily update.</div>`; return; }
      for (const id of ["seView", "seConf"]) $(id).querySelectorAll("button").forEach((b) => (b.onclick = () => {
        $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        se[id === "seView" ? "view" : "conf"] = b.dataset.v; renderSeason();
      }));
      $("seBody").addEventListener("click", (e) => { const r = e.target.closest("tr[data-t]"); if (r) { se.team = se.team === r.dataset.t ? null : r.dataset.t; renderSeason(); $("seTeam").scrollIntoView({ behavior: "smooth", block: "nearest" }); } });
      $("seTeam").addEventListener("click", (e) => { if (e.target.closest("button[data-close]")) { se.team = null; renderSeason(); } });
      renderSeason();
    }).catch(() => { $("seBody").innerHTML = `<div class="gd-card dim">Season projections appear after the next daily update.</div>`; });
  }
  const heat = (p, hue = "62,207,142") => `<span class="heat" style="background:rgba(${hue},${(0.08 + 0.75 * p).toFixed(2)});color:${p > 0.55 ? "#06140c" : "var(--text)"}">${p >= 0.995 ? ">99%" : p > 0 && p < 0.005 ? "<1%" : Math.round(p * 100) + "%"}</span>`;
  const recStr = (t) => `${t.w}-${t.l}${t.t ? "-" + t.t : ""}`;
  const tname = (t) => `<span class="tname"><i style="background:${col(t)}"></i>${t}</span>`;
  function renderSeason() {
    const S = season, T = S.teams;
    $("seMeta").textContent = `${S.season} · after week ${S.through_week} · ${S.seasons.toLocaleString()} simulated seasons · built ${S.generated}`;
    const confOk = (t) => !se.conf || T[t].conf === se.conf;
    if (se.view === "odds") {
      $("seBody").innerHTML = `<div class="se-divs">${Object.entries(S.divisions).filter(([d]) => !se.conf || d.startsWith(se.conf)).map(([d, ts]) => {
        const rows = ts.slice().sort((a, b) => T[b].proj_w - T[a].proj_w);
        return `<div class="se-div"><h3>${d}</h3><table class="se"><tr><th>Team</th><th>Record</th><th>Proj W</th><th>Playoffs</th><th>Division</th><th>#1 seed</th><th>Conf</th><th>Super Bowl</th></tr>
          ${rows.map((t) => `<tr class="row ${se.team === t ? "sel" : ""}" data-t="${t}"><td>${tname(t)}</td><td>${recStr(T[t])}</td><td>${T[t].proj_w.toFixed(1)}</td>
            <td>${heat(T[t].playoff)}</td><td>${heat(T[t].div_title)}</td><td>${heat(T[t].seed1, "242,201,76")}</td><td>${heat(T[t].conf_title, "242,201,76")}</td><td>${heat(T[t].sb, "242,201,76")}</td></tr>`).join("")}</table></div>`;
      }).join("")}</div>`;
    } else if (se.view === "power") {
      const weeks = rhist ? Object.keys(rhist.weeks).map(Number).sort((a, b) => a - b) : [];
      const prevW = weeks.filter((w) => w < S.through_week).pop();
      const prevRank = {};
      if (prevW != null) Object.entries(rhist.weeks[prevW]).sort((a, b) => b[1] - a[1]).forEach(([t], i) => (prevRank[t] = i + 1));
      const all = Object.keys(T).sort((a, b) => T[b].rating - T[a].rating);
      const maxR = Math.max(...all.map((t) => Math.abs(T[t].rating)), 1), maxOD = Math.max(...all.map((t) => Math.max(Math.abs(T[t].off), Math.abs(T[t].def))), 1);
      const dbar = (v, m) => { const w = (Math.abs(v) / m) * 50; return `<span class="dbar"><b></b><i style="${v >= 0 ? `left:50%;width:${w}%;background:var(--good)` : `left:${50 - w}%;width:${w}%;background:var(--bad)`}"></i></span>`; };
      const spark = (t) => {
        if (!weeks.length) return "";
        const vals = weeks.map((w) => rhist.weeks[w][t]).filter((v) => v != null); if (vals.length < 2) return "";
        const lo = -maxR, hi = maxR, W = 90, H = 22, X = (i) => (i / (vals.length - 1)) * W, Y = (v) => H - ((v - lo) / (hi - lo)) * H;
        return `<svg class="spark" width="${W}" height="${H}"><line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" stroke="#33475c" stroke-dasharray="2 2"/><path d="${vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}" fill="none" stroke="${col(t)}" stroke-width="2"/></svg>`;
      };
      $("seBody").innerHTML = `<div class="se-div"><table class="se se-power"><tr><th>#</th><th style="text-align:left">Team</th><th>Record</th><th>Rating</th><th style="text-align:center">vs average</th><th style="text-align:center">Offense</th><th style="text-align:center">Defense</th><th>Trend (wk ${weeks[0] ?? "–"}–${weeks[weeks.length - 1] ?? "–"})</th><th>Rest of schedule</th><th>Playoffs</th></tr>
        ${all.filter(confOk).map((t) => {
          const rk = all.indexOf(t) + 1, pr = prevRank[t], mv = pr ? pr - rk : 0;
          return `<tr class="row ${se.team === t ? "sel" : ""}" data-t="${t}"><td class="rk">${rk}${mv ? `<span class="mv ${mv > 0 ? "up" : "dn"}">${mv > 0 ? "▲" : "▼"}${Math.abs(mv)}</span>` : ""}</td><td>${tname(t)}</td><td>${recStr(T[t])}</td>
            <td><b>${T[t].rating > 0 ? "+" : ""}${T[t].rating.toFixed(1)}</b></td><td style="text-align:center">${dbar(T[t].rating, maxR)}</td>
            <td style="text-align:center" title="points scored vs average">${dbar(T[t].off, maxOD)} <span class="dim">${T[t].off > 0 ? "+" : ""}${T[t].off.toFixed(1)}</span></td>
            <td style="text-align:center" title="points prevented vs average">${dbar(T[t].def, maxOD)} <span class="dim">${T[t].def > 0 ? "+" : ""}${T[t].def.toFixed(1)}</span></td>
            <td>${spark(t)}</td><td title="average rating of remaining opponents">${T[t].sos_rest > 0.75 ? '<span style="color:var(--bad)">hard</span>' : T[t].sos_rest < -0.75 ? '<span style="color:var(--good)">easy</span>' : "average"} <span class="dim">(${T[t].sos_rest > 0 ? "+" : ""}${T[t].sos_rest.toFixed(1)})</span></td>
            <td>${heat(T[t].playoff)}</td></tr>`;
        }).join("")}</table></div>`;
    } else {
      const all = Object.keys(T).filter(confOk).sort((a, b) => T[b].pick1 - T[a].pick1 || T[b].top5 - T[a].top5 || T[a].proj_w - T[b].proj_w).slice(0, 16);
      $("seBody").innerHTML = `<div class="se-div"><h3>Race for the #1 pick</h3><table class="se"><tr><th>Team</th><th>Record</th><th>Proj W</th><th>#1 pick</th><th>Top-5 pick</th><th>Playoffs</th></tr>
        ${all.map((t) => `<tr class="row ${se.team === t ? "sel" : ""}" data-t="${t}"><td>${tname(t)}</td><td>${recStr(T[t])}</td><td>${T[t].proj_w.toFixed(1)}</td><td>${heat(T[t].pick1, "239,91,91")}</td><td>${heat(T[t].top5, "239,91,91")}</td><td>${heat(T[t].playoff)}</td></tr>`).join("")}</table></div>
        <p class="note">Draft order is by record only (strength-of-schedule tiebreakers are approximated by a coin flip).</p>`;
    }
    renderSeasonTeam();
  }
  function renderSeasonTeam() {
    const t = se.team; if (!t || !season.teams[t]) { $("seTeam").innerHTML = ""; return; }
    const T = season.teams[t], c = col(t);
    // seed distribution
    const sd = T.seeds, W = 320, H = 140, bw = W / 8;
    let seedSvg = "";
    const lab = ["Out", "1", "2", "3", "4", "5", "6", "7"], order = [1, 2, 3, 4, 5, 6, 7, 0], maxS = Math.max(...sd, 0.01);
    order.forEach((k, i) => { const h = (sd[k] / maxS) * (H - 34); seedSvg += `<rect x="${i * bw + 4}" y="${H - 18 - h}" width="${bw - 8}" height="${h}" rx="3" fill="${k === 0 ? "#3a4a5c" : c}" opacity="${k === 0 ? 1 : 0.85}"/><text x="${i * bw + bw / 2}" y="${H - 4}" fill="#7d8ea1" font-size="10" font-family="monospace" text-anchor="middle">${lab[k]}</text>${sd[k] >= 0.01 ? `<text x="${i * bw + bw / 2}" y="${H - 22 - h}" fill="#e8eef5" font-size="10" font-family="monospace" text-anchor="middle">${Math.round(sd[k] * 100)}%</text>` : ""}`; });
    // win distribution
    const wd = T.wins_dist, lo = wd.findIndex((x) => x >= 0.002), hi = 17 - [...wd].reverse().findIndex((x) => x >= 0.002), n = hi - lo + 1, bw2 = W / n, maxW = Math.max(...wd);
    let winSvg = "";
    for (let k = lo; k <= hi; k++) { const i = k - lo, h = (wd[k] / maxW) * (H - 34); winSvg += `<rect x="${i * bw2 + 2}" y="${H - 18 - h}" width="${bw2 - 4}" height="${h}" rx="2" fill="${c}" opacity=".8"/><text x="${i * bw2 + bw2 / 2}" y="${H - 4}" fill="#7d8ea1" font-size="10" font-family="monospace" text-anchor="middle">${k}</text>`; }
    const rest = T.rest.map((g) => { const p = g.p, bg = p >= 0.5 ? `rgba(62,207,142,${(0.1 + (p - 0.5) * 1.2).toFixed(2)})` : `rgba(239,91,91,${(0.1 + (0.5 - p) * 1.2).toFixed(2)})`;
      return `<div style="background:${bg}">W${g.w} ${g.neutral ? "vs" : g.home ? "vs" : "@"} <span style="color:${col(g.opp)}">${g.opp}</span><b>${Math.round(p * 100)}%</b></div>`; }).join("");
    $("seTeam").innerHTML = `<div class="se-team"><h3><span>${tname(t)} <span class="dim" style="font-size:13px;font-weight:400">${recStr(T)} · ${T.div} · rating ${T.rating > 0 ? "+" : ""}${T.rating.toFixed(1)}</span></span><button data-close>close</button></h3>
      <div class="dim mono" style="font-size:12px">Projected ${T.proj_w.toFixed(1)} wins · playoffs ${Math.round(T.playoff * 100)}% · division ${Math.round(T.div_title * 100)}% · Super Bowl ${(T.sb * 100).toFixed(1)}%</div>
      <div class="se-tgrid"><div><h4>Playoff seed</h4><svg viewBox="0 0 ${W} ${H}">${seedSvg}</svg></div>
        <div><h4>Final win total</h4><svg viewBox="0 0 ${W} ${H}">${winSvg}</svg></div>
        <div><h4>Remaining games · model win %</h4><div class="rest">${rest || '<span class="dim">Season complete</span>'}</div></div></div></div>`;
  }

  // ---------------- fantasy ----------------
  let fant = null, fantLoading = null;
  const ft = { week: null, fmt: "ppr", pos: "", sort: "mean", team: "", q: "", cmp: [] };
  const BOOM = { QB: [25, 12], RB: [20, 7], WR: [20, 7], TE: [15, 5], K: [12, 5], DST: [12, 3] };
  function fetchFantasy() {
    if (!fantLoading) fantLoading = fetch("data/fantasy.json?" + (model ? model.generated : "")).then((r) => { if (!r.ok) throw 0; return r.json(); }).then((f) => (fant = f)).catch(() => null);
    return fantLoading;
  }
  // P(X >= t) from 21 evenly spaced quantiles (linear interpolation)
  function pAtLeast(q, t) {
    if (t <= q[0]) return 1; if (t > q[20]) return 0;
    for (let i = 0; i < 20; i++) if (t <= q[i + 1]) { const f = q[i + 1] === q[i] ? 1 : (t - q[i]) / (q[i + 1] - q[i]); return 1 - (i + f) / 20; }
    return 0;
  }
  function sampleQ(q, u) { const x = u * 20, i = Math.min(19, Math.floor(x)); return q[i] + (q[i + 1] - q[i]) * (x - i); }
  function thresholds(pos, fmt) { const [b, d] = BOOM[pos] || [20, 7]; const k = ["RB", "WR", "TE"].includes(pos) ? (fmt === "half" ? 0.9 : fmt === "std" ? 0.8 : 1) : 1; return [b * k, d * k]; }
  function loadFantasy() {
    fetchFantasy().then((f) => {
      if (!f) { $("ftTable").innerHTML = `<tr><td class="dim">No projections yet. They appear after the next daily update.</td></tr>`; return; }
      if (ft.week == null) {
        // default to the week with the most games left
        const cnt = (w) => f.games.filter((g) => g.week === w).length;
        ft.week = f.weeks.slice().sort((a, b) => cnt(b) - cnt(a))[0];
        $("ftWeek").innerHTML = f.weeks.filter((w) => cnt(w)).map((w) => `<button data-v="${w}" class="${w === ft.week ? "on" : ""}">Week ${w} <span class="dim">(${cnt(w)} game${cnt(w) === 1 ? "" : "s"})</span></button>`).join("");
        const segs = [["ftWeek", "week", true], ["ftFmt", "fmt"], ["ftPos", "pos"]];
        for (const [id, key, num] of segs) $(id).querySelectorAll("button").forEach((b) => (b.onclick = () => {
          $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
          ft[key] = num ? +b.dataset.v : b.dataset.v; if (key === "week") ft.cmp = []; if (key === "fmt") store.set("fmt", ft.fmt); renderFantasy();
        }));
        $("ftSort").onchange = () => { ft.sort = $("ftSort").value; renderFantasy(); };
        $("ftTeam").onchange = () => { ft.team = $("ftTeam").value; renderFantasy(); };
        $("ftSearch").oninput = () => { ft.q = $("ftSearch").value.toLowerCase(); renderFantasy(); };
        $("ftTable").addEventListener("change", (e) => {
          const c = e.target.closest("input[data-cmp]"); if (!c) return;
          if (c.checked) { if (ft.cmp.length >= 4) { c.checked = false; return; } ft.cmp.push(c.dataset.cmp); } else ft.cmp = ft.cmp.filter((x) => x !== c.dataset.cmp);
          renderFantasy();
        });
        $("ftCompare").addEventListener("click", (e) => { if (e.target.closest("button[data-clear]")) { ft.cmp = []; renderFantasy(); } });
      }
      renderFantasy();
    });
  }
  function renderFantasy() {
    const f = fant, fmt = ft.fmt;
    const teams = [...new Set(f.players.filter((p) => p.week === ft.week).map((p) => p.team))].sort();
    if ($("ftTeam").options.length !== teams.length + 1) $("ftTeam").innerHTML = `<option value="">All teams</option>` + teams.map((t) => `<option ${t === ft.team ? "selected" : ""}>${t}</option>`).join("");
    $("ftMeta").textContent = `Week ${ft.week} · ${f.sims.toLocaleString()} sims per game · built ${f.generated}`;
    const gw = Object.fromEntries(f.games.map((g) => [g.game, g]));
    let list = f.players.filter((p) => p.week === ft.week)
      .filter((p) => (!ft.pos || (ft.pos === "FLEX" ? ["RB", "WR", "TE"].includes(p.pos) : p.pos === ft.pos)) && (!ft.team || p.team === ft.team) && (!ft.q || p.name.toLowerCase().includes(ft.q)));
    const val = (p) => { const q = p.q[fmt], [b] = thresholds(p.pos, fmt); return ft.sort === "ceil" ? q[18] : ft.sort === "floor" ? q[2] : ft.sort === "boom" ? pAtLeast(q, b) : p.mean[fmt]; };
    list.sort((a, b) => val(b) - val(a));
    if (!ft.pos && !ft.q && !ft.team) list = list.filter((p) => p.mean[fmt] >= 3);
    list = list.slice(0, 250);
    const maxC = Math.max(10, ...list.slice(0, 60).map((p) => p.q[fmt][18]));
    const wxIcon = (g) => { const w = g && g.weather; if (!w || !w.features) return ""; const fz = w.features; return fz.snow > 0 ? " ❄️" : fz.rain >= 0.5 ? " 🌧️" : fz.wind >= 8 ? " 💨" : fz.cold >= 15 ? " 🥶" : ""; };
    $("ftTable").innerHTML = `<tr><th>#</th><th>Player</th><th>Opp</th><th>Proj</th><th>Floor ─ median ─ ceiling</th><th>Floor</th><th>Ceiling</th><th>Boom</th><th>Bust</th><th title="Tick 2–4 players to compare">Compare</th></tr>` +
      list.map((p, i) => {
        const q = p.q[fmt], [b, d] = thresholds(p.pos, fmt), boom = pAtLeast(q, b), bust = 1 - pAtLeast(q, d), on = ft.cmp.includes(p.id + "|" + p.week);
        const X = (v) => Math.max(0, Math.min(100, (v / maxC) * 100));
        const name = p.pos === "DST" || p.pos === "K" ? p.name : `<span class="plink" data-pid="${p.id}" data-stat="fp">${p.name}</span>`;
        return `<tr class="${on ? "cmp" : ""}"><td>${i + 1}</td><td>${name}<span class="posb ${p.pos}">${p.pos === "DST" ? "D/ST" : p.pos}</span>${p.status ? `<span class="st" style="color:var(--bad);font-size:11px;margin-left:6px">${p.status}</span>` : ""}</td>
          <td class="opp"><span style="color:${col(p.team)}">${p.team}</span> ${p.home ? "vs" : "@"} ${p.opp}${wxIcon(gw[p.game])}</td>
          <td class="proj">${p.mean[fmt].toFixed(1)}</td>
          <td><div class="rbar"><i style="left:${X(q[2])}%;width:${X(q[18]) - X(q[2])}%"></i><b style="left:${X(q[10])}%"></b></div></td>
          <td>${q[2].toFixed(1)}</td><td>${q[18].toFixed(1)}</td>
          <td class="boom">${Math.round(boom * 100)}%</td><td class="bust">${Math.round(bust * 100)}%</td>
          <td><input type="checkbox" data-cmp="${p.id}|${p.week}" ${on ? "checked" : ""}></td></tr>`;
      }).join("");
    renderCompare();
  }
  function renderCompare() {
    const f = fant, fmt = ft.fmt;
    const ps = ft.cmp.map((k) => { const [id, w] = k.split("|"); return f.players.find((p) => p.id === id && p.week === +w); }).filter(Boolean);
    if (ps.length < 2) { $("ftCompare").innerHTML = ps.length ? `<div class="ftcmp"><h4>Start / sit <button data-clear>clear</button></h4><div class="dim">Tick one more player to compare.</div></div>` : ""; return; }
    // chance each player scores the most (independent draws from each distribution)
    const rand = NFLSim.mulberry32(7), wins = new Array(ps.length).fill(0), T = 20000;
    for (let t = 0; t < T; t++) { let best = -1, bi = 0; ps.forEach((p, i) => { const v = sampleQ(p.q[fmt], rand()); if (v > best) { best = v; bi = i; } }); wins[bi]++; }
    const top = wins.indexOf(Math.max(...wins));
    const floorI = ps.reduce((bi, p, i) => (p.q[fmt][2] > ps[bi].q[fmt][2] ? i : bi), 0), ceilI = ps.reduce((bi, p, i) => (p.q[fmt][18] > ps[bi].q[fmt][18] ? i : bi), 0);
    const maxV = Math.max(...ps.map((p) => p.q[fmt][19])) * 1.05, W = 900, rowH = 30, H = ps.length * rowH + 22;
    const X = (v) => 130 + (v / maxV) * (W - 150);
    let svg = "";
    for (let v = 0; v <= maxV; v += 5) svg += `<line x1="${X(v)}" x2="${X(v)}" y1="0" y2="${H - 18}" stroke="#1d2a38"/><text x="${X(v)}" y="${H - 4}" fill="#7d8ea1" font-size="10" font-family="monospace" text-anchor="middle">${v}</text>`;
    ps.forEach((p, i) => {
      const q = p.q[fmt], y = i * rowH + 15, c = col(p.team);
      svg += `<text x="0" y="${y + 4}" fill="#e8eef5" font-size="12" font-family="sans-serif">${p.name.length > 18 ? p.name.slice(0, 17) + "…" : p.name}</text>
        <line x1="${X(q[1])}" x2="${X(q[19])}" y1="${y}" y2="${y}" stroke="${c}" stroke-width="2" opacity=".6"/>
        <rect x="${X(q[5])}" y="${y - 8}" width="${X(q[15]) - X(q[5])}" height="16" rx="4" fill="${c}" opacity=".55"/>
        <rect x="${X(q[10]) - 1.5}" y="${y - 10}" width="3" height="20" fill="#fff"/>`;
    });
    $("ftCompare").innerHTML = `<div class="ftcmp"><h4>Start / sit · week ${ft.week} · ${fmt === "ppr" ? "PPR" : fmt === "half" ? "half PPR" : "standard"} <button data-clear>clear</button></h4>
      <div class="ftc-grid">${ps.map((p, i) => `<div class="ftc ${i === top ? "win" : ""}"><div class="nm">${p.name} <span class="posb ${p.pos}">${p.pos}</span></div>
        <div class="sb">${p.team} ${p.home ? "vs" : "@"} ${p.opp} · proj ${p.mean[fmt].toFixed(1)} · ${p.q[fmt][2].toFixed(1)}–${p.q[fmt][18].toFixed(1)}</div>
        <div class="big">${((wins[i] / T) * 100).toFixed(0)}%</div><div class="sb">chance to score the most</div>
        <div class="tags">${i === top ? '<span class="start">START</span>' : ""}${i === floorI ? "<span>SAFEST FLOOR</span>" : ""}${i === ceilI ? "<span>MOST UPSIDE</span>" : ""}</div></div>`).join("")}</div>
      <div class="ftc-box"><svg viewBox="0 0 ${W} ${H}">${svg}</svg></div>
      <div class="gd-note">Boxes cover the middle 50% of outcomes, whiskers 5th–95th percentile, white mark = median. Players in the same game are treated as independent.</div></div>`;
  }

  // ---------------- game day: live win probability + 4th-down helper ----------------
  let gd = null, gdTeams = null;
  function gdDefault() {
    return { away: 0, home: 0, q: 1, clock: "15:00", pos: "home", side: "own", yd: 35, down: 1, togo: 10, toA: 3, toH: 3 };
  }
  function gdFromReplay() {
    if (!game) return null;
    let i = idx >= 0 ? idx : 0;
    while (i < game.plays.length && !game.plays[i].down) i++;
    const p = game.plays[i]; if (!p) return null;
    return { away: p.score[0], home: p.score[1], q: p.q, clock: p.clock, pos: p.pos, side: p.yl > 50 ? "own" : "opp",
      yd: p.yl > 50 ? 100 - p.yl : p.yl, down: p.down, togo: p.togo, toA: p.to ? p.to.away : 3, toH: p.to ? p.to.home : 3 };
  }
  function gdState() {
    const [m, sx] = String(gd.clock).split(":").map((x) => parseInt(x, 10) || 0);
    const secs = Math.max(0, Math.min(gd.q >= 5 ? 600 : 900, m * 60 + sx));
    const yl = Math.max(1, Math.min(99, gd.side === "own" ? 100 - gd.yd : gd.yd));
    return { q: gd.q, secs, away: +gd.away, home: +gd.home, pos: gd.pos, yl, down: +gd.down, togo: Math.max(1, Math.min(+gd.togo, yl)), to: { away: +gd.toA, home: +gd.toH } };
  }
  function renderGameDay() {
    const key = cur.away + "@" + cur.home;
    if (!gd || gdTeams !== key) { gd = gdDefault(); gdTeams = key; }
    const A = cur.away, H = cur.home;
    const seg = (name, opts, val) => `<div class="seg" data-gd="${name}">${opts.map(([v, t]) => `<button data-v="${v}" class="${String(v) === String(val) ? "on" : ""}">${t}</button>`).join("")}</div>`;
    $("gdForm").innerHTML = `
      <div><h4>Score</h4><div class="gd-score">
        <div><b style="color:${col(A)}">${A}</b><input data-gdi="away" type="number" min="0" value="${gd.away}"></div>
        <div><b style="color:${col(H)}">${H}</b><input data-gdi="home" type="number" min="0" value="${gd.home}"></div></div></div>
      <div><h4>Clock</h4><div class="gd-row">${seg("q", [[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [5, "OT"]], gd.q)}<input data-gdi="clock" type="text" value="${gd.clock}" title="mm:ss left in the quarter"></div></div>
      <div><h4>Ball</h4>
        <div class="gd-row"><label>Possession</label>${seg("pos", [["away", A], ["home", H]], gd.pos)}</div>
        <div class="gd-row" style="margin-top:6px"><label>Ball on</label>${seg("side", [["own", "own"], ["opp", "opp"]], gd.side)}<input data-gdi="yd" type="number" min="1" max="50" value="${gd.yd}"></div>
        <div class="gd-row" style="margin-top:6px"><label>Down</label>${seg("down", [[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"]], gd.down)}</div>
        <div class="gd-row" style="margin-top:6px"><label>To go</label><input data-gdi="togo" type="number" min="1" max="99" value="${gd.togo}"></div></div>
      <div><h4>Timeouts left</h4>
        <div class="gd-row"><label style="color:${col(A)}">${A}</label>${seg("toA", [[0, "0"], [1, "1"], [2, "2"], [3, "3"]], gd.toA)}</div>
        <div class="gd-row" style="margin-top:6px"><label style="color:${col(H)}">${H}</label>${seg("toH", [[0, "0"], [1, "1"], [2, "2"], [3, "3"]], gd.toH)}</div></div>
      <div class="gd-btns"><button class="primary" id="gdRun">Simulate rest of game</button><button id="gdLoad" title="Use the situation from the current replay play">Load from replay</button><button id="gdReset">Kickoff</button></div>`;
    $("gdForm").querySelectorAll("[data-gd] button").forEach((b) => (b.onclick = () => { gd[b.parentElement.dataset.gd] = b.dataset.v === "away" || b.dataset.v === "home" || b.dataset.v === "own" || b.dataset.v === "opp" ? b.dataset.v : +b.dataset.v; renderGameDay(); }));
    $("gdForm").querySelectorAll("[data-gdi]").forEach((inp) => (inp.onchange = () => { gd[inp.dataset.gdi] = inp.type === "number" ? +inp.value : inp.value; drawGdField(); }));
    $("gdRun").onclick = runGameDay;
    $("gdLoad").onclick = () => { const r = gdFromReplay(); if (r) { gd = r; renderGameDay(); runGameDay(); } };
    $("gdReset").onclick = () => { gd = gdDefault(); renderGameDay(); };
    drawGdField();
    if (!$("gdResult").innerHTML) $("gdResult").innerHTML = `<div class="gd-card dim">Set the situation and press <b>Simulate rest of game</b>.</div>`;
    $("gd4th").innerHTML = "";
  }
  function drawGdField() {
    const st = gdState(), X = (abs) => 40 + abs * 9.2;
    const abs = st.pos === "away" ? 100 - st.yl : st.yl, dir = st.pos === "away" ? 1 : -1;
    const fd = st.pos === "away" ? 100 - Math.max(0, st.yl - st.togo) : Math.max(0, st.yl - st.togo);
    let h = `<rect x="0" y="0" width="1000" height="90" fill="#0d2414"/><rect x="0" y="0" width="40" height="90" fill="${col(cur.away)}" opacity=".45"/><rect x="960" y="0" width="40" height="90" fill="${col(cur.home)}" opacity=".45"/>`;
    for (let y = 10; y < 100; y += 10) h += `<line x1="${X(y)}" x2="${X(y)}" y1="0" y2="90" stroke="#fff" stroke-opacity=".15"/><text x="${X(y)}" y="84" fill="#fff" opacity=".35" font-size="11" font-family="monospace" text-anchor="middle">${y <= 50 ? y : 100 - y}</text>`;
    h += `<line x1="${X(abs)}" x2="${X(abs)}" y1="0" y2="90" stroke="#4aa3ff" stroke-width="3"/>`;
    if (st.yl > st.togo) h += `<line x1="${X(fd)}" x2="${X(fd)}" y1="0" y2="90" stroke="#f2c94c" stroke-width="3"/>`;
    h += `<ellipse cx="${X(abs)}" cy="42" rx="9" ry="6" fill="#f4efe6" stroke="#8a5a2b" stroke-width="2"/>`;
    h += `<text x="${X(abs) + dir * 26}" y="30" fill="${col(cur[st.pos])}" font-size="18" font-weight="700" font-family="monospace" text-anchor="middle">${dir > 0 ? "›››" : "‹‹‹"}</text>`;
    const ord2 = ["", "1st", "2nd", "3rd", "4th"][st.down];
    h += `<text x="500" y="18" fill="#e8eef5" font-size="13" font-family="monospace" text-anchor="middle">${cur[st.pos]} ball · ${ord2} & ${st.yl <= st.togo ? "goal" : st.togo} at ${st.yl === 50 ? "midfield" : (st.yl > 50 ? cur[st.pos] : cur[st.pos === "home" ? "away" : "home"]) + " " + (st.yl > 50 ? 100 - st.yl : st.yl)}</text>`;
    $("gdField").innerHTML = `<svg viewBox="0 0 1000 90" preserveAspectRatio="none">${h}</svg>`;
  }
  function runGameDay() {
    const st = gdState(), A = cur.away, H = cur.home;
    $("gdResult").innerHTML = `<div class="gd-card dim">Simulating…</div>`; $("gd4th").innerHTML = "";
    setTimeout(() => {
      const base = Object.assign(simOpts(), { start: st, seed: 31337 });
      const agg = NFLSim.simulateMany(model, base, 3000);
      const n = agg.n, pH = (agg.wins.home + agg.wins.tie / 2) / n, pA = 1 - pH;
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const sg = schedFor(A, H);
      const margin = agg.home.map((h, i) => h - agg.away[i]), total = agg.home.map((h, i) => h + agg.away[i]);
      const extra = [];
      if (sg && sg.spread != null) { const sp = sg.spread, fav = sp >= 0 ? H : A; const c = sp >= 0 ? margin.filter((m) => m > sp).length / n : margin.filter((m) => -m > -sp).length / n; extra.push(`<div class="card"><div class="k">${fav} −${Math.abs(sp)} (pregame)</div><div class="v">${pct(c)}</div><div class="s">chance to cover</div></div>`); }
      if (sg && sg.total != null) extra.push(`<div class="card"><div class="k">Over ${sg.total} (pregame)</div><div class="v">${pct(total.filter((t) => t > sg.total).length / n)}</div><div class="s">projected total ${mean(total).toFixed(1)}</div></div>`);
      $("gdResult").innerHTML = `<div class="gd-card"><h4>Win probability</h4>
        <div class="wpsplit"><div style="flex-basis:${(pA * 100).toFixed(1)}%;background:${col(A)}">${pA >= 0.12 ? A + " " + (pA * 100).toFixed(1) + "%" : ""}</div><div style="flex-basis:${(pH * 100).toFixed(1)}%;background:${col(H)}">${pH >= 0.12 ? H + " " + (pH * 100).toFixed(1) + "%" : ""}</div></div>
        <div class="cards" style="margin-top:10px">
          <div class="card"><div class="k">Projected final</div><div class="v">${mean(agg.away).toFixed(1)}–${mean(agg.home).toFixed(1)}</div><div class="s">${A}–${H} (average)</div></div>
          <div class="card"><div class="k">Fair live moneyline</div><div class="v">${american(pA)} / ${american(pH)}</div><div class="s">${A} / ${H}</div></div>
          ${extra.join("")}</div>
        <div class="gd-note">${n.toLocaleString()} simulations from this snap · uses this game's injuries, QB picks and weather settings.</div></div>`;
      if (st.down === 4) run4th(st, base);
      else $("gd4th").innerHTML = `<div class="gd-card dim">Set the down to <b>4th</b> to compare going for it, kicking and punting.</div>`;
    }, 30);
  }
  function run4th(st, base) {
    const side = st.pos, team = cur[side], fgDist = st.yl + 17, N = 4000;
    const opts = [["go", "Go for it"], ["fg", `Field goal (${fgDist} yd)`], ["punt", "Punt"]].filter(([d]) => !(d === "fg" && fgDist > 66) && !(d === "punt" && st.yl < 35));
    const res = opts.map(([d, label]) => {
      const a = NFLSim.simulateMany(model, Object.assign({}, base, { force4th: d, seed: 777 }), N);
      const p = (side === "home" ? a.wins.home : a.wins.away) / a.n + a.wins.tie / a.n / 2;
      const f = a.first;
      const detail = d === "go" ? `converts ${pct(f.converted / f.n)}` : d === "fg" ? `makes it ${pct(f.made / f.n)}` : "opponent takes over deep";
      return { d, label, p, detail };
    });
    const best = res.reduce((a, b) => (b.p > a.p ? b : a));
    const second = res.filter((r) => r !== best).reduce((a, b) => (!a || b.p > a.p ? b : a), null);
    const close = second && best.p - second.p < 0.02;   // inside the simulation noise
    // what teams usually do in this spot (league tendencies)
    const row = model.league.fourth[Math.max(0, Math.min(9, Math.floor((st.yl - 1) / 10)))][st.togo <= 1 ? 0 : st.togo <= 3 ? 1 : st.togo <= 6 ? 2 : 3];
    $("gd4th").innerHTML = `<div class="gd-card"><h4>4th-down decision · ${team} win probability by choice</h4>
      <div class="gd-opts">${res.map((r) => `<div class="gd-opt ${r === best ? "best" : ""}">${r === best ? `<span class="badge">${close ? "TOSS-UP" : "BEST CALL"}</span>` : close && r === second ? '<span class="badge" style="background:#7d8ea1">TOSS-UP</span>' : ""}
        <div class="k">${r.label}</div><div class="v" style="color:${col(team)}">${(r.p * 100).toFixed(1)}%</div>
        <div class="s">${r.detail}</div>
        ${r === best ? "" : `<div class="d edge-lo">−${((best.p - r.p) * 100).toFixed(1)} pts vs best</div>`}</div>`).join("")}</div>
      ${close ? `<div class="gd-note" style="color:var(--accent)">The top two options are within 2 points, which is inside the simulation's margin of error, so call it a toss-up.</div>` : ""}
      <div class="gd-note">What NFL teams usually do here: go for it ${Math.round(row[0] * 100)}% · punt ${Math.round(row[1] * 100)}% · kick ${Math.round(row[2] * 100)}% (normal game situations). ${N.toLocaleString()} sims per option.</div></div>`;
  }

  // ---------------- replay win-probability chart ----------------
  const elapsedOf = (q, secs) => (Math.min(q, 5) - 1) * 900 + (q >= 5 ? 600 - secs : 900 - secs);
  function startWP() {
    const id = ++wpJob, idx = [], states = [];
    game.plays.forEach((p, i) => {
      if (!p.down || p.secs == null) return;
      idx.push(i);
      states.push({ q: p.q, secs: p.secs, away: p.score[0], home: p.score[1], pos: p.pos, yl: p.yl, down: p.down, togo: p.togo, to: p.to, recv2: game.recv2 });
    });
    const endT = Math.max(3600, elapsedOf(game.plays[game.plays.length - 1].q, 0));
    wpData = { id, idx, states, vals: [], endT, final: game.score.home > game.score.away ? 1 : game.score.home < game.score.away ? 0 : 0.5 };
    $("wpStatus").textContent = "calculating…"; $("wpNow").textContent = "";
    renderWP(-1);
    try {
      if (!wpWorker) { wpWorker = new Worker("js/worker.js"); wpWorker.postMessage({ model }); wpWorker.onmessage = (e) => {
        if (!wpData || e.data.wpId !== wpData.id) return;
        wpData.vals = e.data.wp;
        $("wpStatus").textContent = e.data.wp.length < e.data.total ? `calculating… ${Math.round((e.data.wp.length / e.data.total) * 100)}%` : "300 sims from each snap";
        renderWP(idx >= 0 ? idx : -1);
      }; }
      const o = simOpts();
      wpWorker.postMessage({ wp: { id, states, opts: o, n: 300 } });
    } catch (err) { $("wpStatus").textContent = "needs a web server (see README)"; }
  }
  function renderWP(playIdx) {
    if (!wpData) return;
    if (playIdx != null) wpData.cur = playIdx;
    const W = 1200, H = 150, padT = 8, padB = 16, d = wpData, n = d.vals.length;
    const X = (t) => (t / d.endT) * W, Y = (p) => padT + (1 - p) * (H - padT - padB);
    const pts = [];
    for (let k = 0; k < n; k++) { const p = game.plays[d.idx[k]]; pts.push([X(elapsedOf(p.q, p.secs)), Y(d.vals[k]), d.vals[k], d.idx[k]]); }
    if (n === d.states.length && n) pts.push([X(elapsedOf(game.plays[game.plays.length - 1].q, 0)), Y(d.final), d.final, game.plays.length - 1]);
    let h = "";
    for (let q = 1; q <= 4; q++) h += `<line x1="${X(q * 900)}" x2="${X(q * 900)}" y1="${padT}" y2="${H - padB}" stroke="#1d2a38"/><text x="${X(q * 900 - 450)}" y="${H - 3}" fill="#7d8ea1" font-size="10" font-family="monospace" text-anchor="middle">Q${q}</text>`;
    h += `<line x1="0" x2="${W}" y1="${Y(0.5)}" y2="${Y(0.5)}" stroke="#33475c" stroke-dasharray="4 4"/>`;
    h += `<text x="4" y="${padT + 10}" fill="${col(cur.home)}" font-size="11" font-family="monospace">${cur.home}</text><text x="4" y="${H - padB - 3}" fill="${col(cur.away)}" font-size="11" font-family="monospace">${cur.away}</text>`;
    if (pts.length) {
      const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
      const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${Y(0.5)} L${pts[0][0].toFixed(1)},${Y(0.5)} Z`;
      h += `<defs><clipPath id="wpTop"><rect x="0" y="0" width="${W}" height="${Y(0.5)}"/></clipPath><clipPath id="wpBot"><rect x="0" y="${Y(0.5)}" width="${W}" height="${H}"/></clipPath></defs>`;
      h += `<path d="${area}" fill="${col(cur.home)}" opacity=".25" clip-path="url(#wpTop)"/><path d="${area}" fill="${col(cur.away)}" opacity=".25" clip-path="url(#wpBot)"/>`;
      h += `<path d="${line}" fill="none" stroke="#e8eef5" stroke-width="2"/>`;
      for (const p of pts) { const pl = game.plays[p[3]]; if (pl && pl.scoring && pl.scoring !== "Safety") h += `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${col(pl.pos === "home" ? cur.home : cur.away)}" stroke="#0b0f14"/>`; }
    }
    // current play marker
    const ci = d.cur;
    if (ci != null && ci >= 0 && game.plays[ci]) {
      const pl = game.plays[ci], x = X(elapsedOf(pl.q, pl.secs));
      h += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" stroke="#f2c94c" stroke-width="1.5"/>`;
      let k = -1; for (let j = 0; j < pts.length; j++) if (pts[j][3] <= ci) k = j;
      if (k >= 0) {
        const p = pts[k][2], fav = p >= 0.5 ? cur.home : cur.away;
        h += `<circle cx="${pts[k][0]}" cy="${pts[k][1]}" r="5" fill="#f2c94c" stroke="#0b0f14"/>`;
        $("wpNow").innerHTML = `<span style="color:${col(fav)}">${fav}</span> ${(Math.max(p, 1 - p) * 100).toFixed(0)}%`;
      }
    } else if (pts.length) {
      const p = pts[0][2], fav = p >= 0.5 ? cur.home : cur.away;
      $("wpNow").innerHTML = `<span style="color:${col(fav)}">${fav}</span> ${(Math.max(p, 1 - p) * 100).toFixed(0)}% at kickoff`;
    }
    $("wpChart").innerHTML = h;
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
    renderWP(i);
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
      const tr = (n, v, id) => `<tr><td>${id ? `<span class="plink" data-pid="${id}">${n}</span>` : n}</td><td>${v}</td></tr>`;
      return sec("PASSING", ps.filter((s) => s.pa).sort((x, y) => y.pa - x.pa).map((s) => tr(s.name, `${s.pc}/${s.pa}, ${s.py} YDS, ${s.ptd} TD, ${s.pint} INT`, s.id))) +
        sec("RUSHING", ps.filter((s) => s.ra).sort((x, y) => y.ry - x.ry).map((s) => tr(s.name, `${s.ra} CAR, ${s.ry} YDS, ${s.rtd} TD`, s.id))) +
        sec("RECEIVING", ps.filter((s) => s.tg).sort((x, y) => y.recy - x.recy).map((s) => tr(s.name, `${s.rec}/${s.tg} TGT, ${s.recy} YDS, ${s.rectd} TD`, s.id))) +
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
          return `<tr><td><span class="plink" data-pid="${p.id}" data-stat="td">${p.name}</span><span class="pos">${p.pos}</span></td><td><span class="teamtag" style="background:${col(p.team)}"></span>${p.team}</td><td>${m.toFixed(2)}</td><td>${pct(p1)}</td><td>${american(p1)}</td><td>${pct(p2)}</td><td><button class="addleg" data-pid="${p.id}" data-stat="td" title="Add to parlay">+</button></td></tr>`;
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
        return `<tr><td><span class="plink" data-pid="${p.id}" data-stat="${k}" data-line="${line}">${p.name}</span><span class="pos">${p.pos}</span></td><td><span class="teamtag" style="background:${col(p.team)}"></span>${p.team}</td>
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
      legs.map((l, i) => `<tr><td>${l.pid ? `<span class="plink" data-pid="${l.pid}" data-stat="${l.type === "td" ? "td" : l.stat}" data-line="${l.line != null ? l.line : ""}">${legLabel(l)}</span>` : legLabel(l)}</td><td></td><td>${pct(probs[i])}</td><td>${american(probs[i])}</td><td><button class="rm" data-i="${i}" title="Remove leg">✕</button></td></tr>`).join("");
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
      if (e.target.closest(".plink")) return;
      const open = e.target.closest(".eg-open"); if (open) return goGame(open, "watch");
      const head = e.target.closest(".eg-head"); if (head) goGame(head);
    });
    $("edTop").addEventListener("click", (e) => { if (e.target.closest(".plink")) return; const c = e.target.closest(".topcard"); if (c) goGame(c); });
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
    const bar = (b) => `<div class="pbar" title="Model ${(b.p * 100).toFixed(1)}% (bar) vs book ${(b.p_implied * 100).toFixed(1)}% (yellow marker)"><i class="${b.p >= b.p_implied ? "" : "neg"}" style="width:${(b.p * 100).toFixed(1)}%"></i><b style="left:${(b.p_implied * 100).toFixed(1)}%"></b></div>`;
    const tag = (b) => ({ ml: "ML", spread: "SPREAD", total: "TOTAL", prop: b.stat === "td" ? "TD" : "PROP" })[b.kind];
    const flags = (b) => (b.out_in_model ? `<span class="flag red" title="Ruled out or unused in the model">out in model</span>` : "");

    // top plays
    // top plays: the biggest Strong/Lean edges (huge "Check" gaps are usually missing news)
    let top = shown.filter((b) => ["Strong", "Lean"].includes(betConf(b))).slice(0, 4);
    if (!top.length) top = shown.filter((b) => b.ev > 0).slice(0, 4);
    $("edTop").innerHTML = top.map((b, i) => {
      const g = gameOf(b);
      return `<div class="topcard" style="--tier:${b.ev > 0.2 ? "var(--accent)" : "var(--good)"}" data-a="${g.away}" data-h="${g.home}" title="Open this game">
        <span class="rank">#${i + 1}</span><div class="tc-game">${g.away} @ ${g.home} · ${fmtT(b.commence)}</div>
        <div class="tc-bet">${b.pid ? `<span class="plink" data-pid="${b.pid}" data-stat="${b.stat}" data-line="${b.line}">${b.label}</span>` : b.label}${flags(b)}</div>
        <div class="tc-row"><span class="price">${priceTxt(b.price)}</span><span class="bookpill">${b.book || ""}</span>${conf(betConf(b))}<span class="tc-ev">${signed(b.ev)}%</span></div>
        ${bar(b)}<div class="tc-cap"><span>Model ${(b.p * 100).toFixed(0)}%</span><span style="color:#f2c94c">▼ Book ${(b.p_implied * 100).toFixed(0)}%</span><span>EV</span></div></div>`;
    }).join("");

    // grouped by game
    const games = e.games.filter((g) => !focus || g.game === focus).sort((a, b) => (a.commence < b.commence ? -1 : 1));
    const hdr = `<div class="erow hdr"><span>Bet</span><span>Best price</span><span>Model vs book <span class="plegend"><span class="sw"></span>model <span class="tri">▼</span>book</span></span><span style="text-align:right">Edge</span><span style="text-align:right">EV</span><span style="text-align:right">Median</span></div>`;
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
            <div class="ebet"><span class="tag">${tag(b)}</span>${b.pid ? `<span class="plink" data-pid="${b.pid}" data-stat="${b.stat}" data-line="${b.line}">${b.label}</span>` : b.label}${flags(b)}</div>
            <div><span class="price">${priceTxt(b.price)}</span> <span class="bookpill">${b.book || ""}</span></div>
            <div class="eprob">${bar(b)}<div class="lbl"><span>model ${(b.p * 100).toFixed(1)}%</span><span>book ${(b.p_implied * 100).toFixed(1)}%</span></div></div>
            <div class="eedge ${b.p >= b.p_implied ? "edge-hi" : "edge-lo"}">${signed(b.p - b.p_implied)}</div>
            <div class="evb t${tier(b.ev)}">${signed(b.ev)}% ${conf(betConf(b))}</div>
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

  // ---------------- player panel ----------------
  let plogs = null, plogsLoading = null;
  const pd = { pid: null, stat: null, line: null, range: "L10", cmp: null, picking: false };
  const PSTAT = { fp: "Fantasy pts", py: "Pass yds", pc: "Completions", ptd: "Pass TD", pint: "INT", ry: "Rush yds", ra: "Carries",
    recy: "Rec yds", rec: "Receptions", tg: "Targets", rry: "Rush+Rec yds", td: "TDs" };
  const statVal = (e, k) => (k === "fp" ? Math.round(NFLSim.fantasyPoints(e, ft.fmt) * 10) / 10 : k === "rry" ? (e.ry || 0) + (e.recy || 0) : k === "td" ? (e.rtd || 0) + (e.rectd || 0) : e[k] || 0);
  const projCache = {};
  function getLogs() {
    if (!plogsLoading) plogsLoading = fetch("data/players.json?" + (model ? model.generated : "")).then((r) => r.json()).then((d) => (plogs = d)).catch(() => (plogs = {}));
    return plogsLoading;
  }
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".plink");
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    openPlayer(el.dataset.pid, el.dataset.stat || null, el.dataset.line !== undefined && el.dataset.line !== "" ? +el.dataset.line : null);
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePlayer(); });
  function closePlayer() { $("pd").classList.add("hidden"); $("pdBack").classList.add("hidden"); }
  function openPlayer(pid, stat, line) {
    pd.pid = pid; pd.stat = stat; pd.line = line; pd.range = "L10"; pd.cmp = null; pd.picking = false;
    $("pd").innerHTML = `<div class="dim">Loading…</div>`;
    $("pd").classList.remove("hidden"); $("pdBack").classList.remove("hidden");
    $("pdBack").onclick = closePlayer;
    Promise.all([getLogs(), fetchFantasy()]).then(renderPlayer);
  }
  function playerMeta(pid) {
    for (const t in model.teams) { const p = model.teams[t].players.find((x) => x.id === pid); if (p) return Object.assign({ team: t }, p); }
    const L = plogs[pid]; return L ? { id: pid, name: L.name, team: L.team, pos: L.pos } : { id: pid, name: pid, team: "", pos: "" };
  }
  function nextGame(team) {
    const up = model.schedule.filter((g) => g.home_score == null && (g.away === team || g.home === team)).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
    return up[0] || null;
  }
  function projectionFor(pid, team) {
    // reuse the projections tab if it's this matchup; otherwise quick-sim the player's next game
    if (projResult && projResult.players[pid] && (team === cur.away || team === cur.home)) return { res: projResult, game: { away: cur.away, home: cur.home } };
    const g = nextGame(team); if (!g) return null;
    const key = g.away + "@" + g.home;
    if (!projCache[key]) {
      const w = g.weather && g.weather.features ? g.weather.features : null;
      projCache[key] = NFLSim.summarize(NFLSim.simulateMany(model, { away: g.away, home: g.home, seed: 4242, weather: w }, 2000));
    }
    return { res: projCache[key], game: g };
  }
  function defRank(team, key, lowIsTough = true) {
    const vals = Object.keys(model.teams).map((t) => [t, model.teams[t].def[key]]).sort((a, b) => (lowIsTough ? a[1] - b[1] : b[1] - a[1]));
    const i = vals.findIndex((x) => x[0] === team);
    return { rank: i + 1, val: model.teams[team].def[key] };
  }
  const ord = (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  function renderPlayer() {
    if (pd.cmp) return renderPlayerCompare();
    renderPlayerSingle();
    addCompareButton();
  }
  // ---------- head-to-head comparison ----------
  function addCompareButton() {
    const host = $("pd").querySelector(".pd-sub"); if (!host) return;
    const box = document.createElement("div");
    box.className = "pd-cmpbar";
    box.innerHTML = pd.picking
      ? `<input id="pdCmpQ" list="pdCmpList" placeholder="Compare with… (type a name)" autocomplete="off"><datalist id="pdCmpList">${Object.entries(plogs).filter(([id]) => id !== pd.pid)
          .sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, v]) => `<option value="${v.name} · ${v.team} ${v.pos}" data-id="${id}"></option>`).join("")}</datalist><button id="pdCmpCancel">cancel</button>`
      : `<button id="pdCmpBtn" title="Compare this player with another">⇄ Compare</button>`;
    host.after(box);
    if (pd.picking) {
      const q = $("pdCmpQ"); q.focus();
      q.onchange = () => {
        const opt = [...$("pdCmpList").options].find((o) => o.value === q.value);
        if (opt) { pd.cmp = opt.dataset.id; pd.picking = false; renderPlayer(); }
      };
      $("pdCmpCancel").onclick = () => { pd.picking = false; renderPlayer(); };
    } else $("pdCmpBtn").onclick = () => { pd.picking = true; renderPlayer(); };
  }
  function seriesFor(pid, k) {
    const L = (plogs[pid] && plogs[pid].log) || [], season = model.season;
    let games = L.slice();
    if (pd.range === "L5") games = L.filter((e) => e.s === season).slice(-5);
    else if (pd.range === "L10") games = L.slice(-10);
    else if (pd.range === "season") games = L.filter((e) => e.s === season);
    else if (pd.range === "last") games = L.filter((e) => e.s === season - 1);
    return { games, vals: games.map((e) => statVal(e, k)) };
  }
  function modelDist(pid, team, k) {
    const proj = projectionFor(pid, team); if (!proj || !proj.res.players[pid]) return { proj, mp: null };
    if (k === "fp") {
      const r = proj.res.players[pid].r, n = r.py.length, arr = new Float64Array(n);
      for (let i = 0; i < n; i++) arr[i] = NFLSim.fantasyPoints({ py: r.py[i], ptd: r.ptd[i], pint: r.pint[i], ry: r.ry[i], rtd: r.td[i], rec: r.rec[i], recy: r.recy[i] }, ft.fmt);
      return { proj, mp: arr.sort() };
    }
    return { proj, mp: proj.res.players[pid].d[k] || null };
  }
  function renderPlayerCompare() {
    const ids = [pd.pid, pd.cmp], metas = ids.map(playerMeta), colors = [col(metas[0].team), col(metas[1].team) === col(metas[0].team) ? "#e8eef5" : col(metas[1].team)];
    const posOf = (m, id) => m.pos || (plogs[id] || {}).pos || "";
    const statsAll = ["fp", "py", "pc", "ptd", "pint", "ry", "ra", "recy", "rec", "tg", "rry", "td"];
    // only stats that are a real part of at least one player's game (2+ games with a nonzero value)
    const avail = statsAll.filter((k) => ids.some((id) => ((plogs[id] && plogs[id].log) || []).filter((e) => statVal(e, k) > 0).length >= 2));
    if (!pd.stat || !avail.includes(pd.stat)) pd.stat = avail.includes("fp") ? "fp" : avail[0];
    const k = pd.stat;
    const S = ids.map((id) => seriesFor(id, k));
    const M = ids.map((id, i) => modelDist(id, metas[i].team, k));
    if (pd.line == null || isNaN(pd.line)) {
      const meds = M.map((m) => (m.mp ? m.mp[Math.floor(m.mp.length / 2)] : null)).filter((x) => x != null);
      pd.line = k === "td" ? 0.5 : Math.floor(meds.length ? meds.reduce((a, b) => a + b, 0) / meds.length : 10) + 0.5;
    }
    const line = pd.line;
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const med = (a) => { const s2 = [...a].sort((x, y) => x - y); return s2.length ? s2[Math.floor((s2.length - 1) / 2)] : 0; };
    const fmt1 = (v) => (Number.isInteger(v) ? v : v.toFixed(1));
    // grouped bars, aligned by "games ago"
    const n = Math.max(S[0].vals.length, S[1].vals.length), W = 520, H = 200, padL = 30, padB = 22, padT = 12;
    const maxV = Math.max(line * 1.15, ...S[0].vals, ...S[1].vals, 1), gw = n ? (W - padL - 4) / n : 0, Y = (v) => H - padB - (v / maxV) * (H - padB - padT);
    let svg = "";
    for (let t = 0; t <= 4; t++) { const v = (maxV * t) / 4; svg += `<line x1="${padL}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="#1d2a38"/><text x="${padL - 4}" y="${Y(v) + 3}" fill="#7d8ea1" font-size="9" font-family="monospace" text-anchor="end">${Math.round(v)}</text>`; }
    for (let g = 0; g < n; g++) {
      [0, 1].forEach((pi) => {
        const arr = S[pi].vals, idx = arr.length - n + g; if (idx < 0) return;
        const v = arr[idx], x = padL + g * gw + gw * 0.12 + pi * gw * 0.38, w = gw * 0.36;
        svg += `<rect x="${x}" y="${Y(v)}" width="${w}" height="${Math.max(1, H - padB - Y(v))}" rx="2" fill="${colors[pi]}" opacity="${v > line ? 0.95 : 0.4}"><title>${metas[pi].name}: ${v}</title></rect>`;
      });
      svg += `<text x="${padL + g * gw + gw / 2}" y="${H - 6}" fill="#7d8ea1" font-size="9" font-family="monospace" text-anchor="middle">${n - g === 1 ? "last" : "-" + (n - g - 1)}</text>`;
    }
    svg += `<line x1="${padL}" x2="${W}" y1="${Y(line)}" y2="${Y(line)}" stroke="#f2c94c" stroke-width="2" stroke-dasharray="6 4"/><text x="${W - 2}" y="${Y(line) - 5}" fill="#f2c94c" font-size="11" font-family="monospace" text-anchor="end">line ${line}</text>`;
    // metrics
    const rows = [];
    const add = (label, vals, better = "high", show = (v) => fmt1(v)) => rows.push({ label, vals, better, show });
    add("Average", S.map((s2) => avg(s2.vals)));
    add("Median", S.map((s2) => med(s2.vals)));
    add(`Over ${line}`, S.map((s2) => (s2.vals.length ? s2.vals.filter((v) => v > line).length / s2.vals.length : 0)), "high", (v) => Math.round(v * 100) + "%");
    add("Last 5 avg", ids.map((id) => avg(((plogs[id] && plogs[id].log) || []).filter((e) => e.s === model.season).slice(-5).map((e) => statVal(e, k)))));
    add("Best game", S.map((s2) => (s2.vals.length ? Math.max(...s2.vals) : 0)));
    add("Worst game", S.map((s2) => (s2.vals.length ? Math.min(...s2.vals) : 0)));
    const shareOf = (id, pos) => { const g = seriesFor(id, k).games; const x = g.map((e) => (pos === "RB" ? (e.tra ? (e.ra || 0) / e.tra : 0) : e.ttg ? (e.tg || 0) / e.ttg : 0)); return avg(x); };
    const pos0 = posOf(metas[0], ids[0]), pos1 = posOf(metas[1], ids[1]);
    if (pos0 !== "QB" && pos1 !== "QB") add("Target / carry share", [shareOf(ids[0], pos0), shareOf(ids[1], pos1)], "high", (v) => Math.round(v * 100) + "%");
    add("Model next game (median)", M.map((m) => (m.mp ? m.mp[Math.floor(m.mp.length / 2)] : NaN)));
    add(`Model over ${line}`, M.map((m) => (m.mp ? m.mp.filter((v) => v > line).length / m.mp.length : NaN)), "high", (v) => Math.round(v * 100) + "%");
    if (fant) {
      const fp = ids.map((id) => fant.players.filter((p) => p.id === id).sort((a, b) => a.week - b.week)[0]);
      if (fp[0] || fp[1]) add(`Fantasy proj (${ft.fmt === "ppr" ? "PPR" : ft.fmt === "half" ? "half" : "std"})`, fp.map((p) => (p ? p.mean[ft.fmt] : NaN)));
    }
    const nx = metas.map((m) => nextGame(m.team));
    const tbl = rows.map((r) => {
      const [a, b] = r.vals, ok = !isNaN(a) && !isNaN(b) && a !== b, win = ok ? ((r.better === "high") === (a > b) ? 0 : 1) : -1;
      return `<tr><td>${r.label}</td>${[a, b].map((v, i) => `<td class="${win === i ? "hi" : ""}">${isNaN(v) ? "–" : r.show(v)}</td>`).join("")}</tr>`;
    }).join("");
    $("pd").innerHTML = `<button class="pd-x" title="Close (Esc)">✕</button>
      <h3 class="pd-name" style="font-size:18px"><span class="plink" data-pid="${ids[0]}" style="color:${colors[0]}">${metas[0].name}</span> <span class="dim">vs</span> <span class="plink" data-pid="${ids[1]}" style="color:${colors[1]}">${metas[1].name}</span></h3>
      <div class="pd-sub">${metas.map((m, i) => `${m.team} ${posOf(m, ids[i])}${nx[i] ? " · next " + (nx[i].away === m.team ? "@ " + nx[i].home : "vs " + nx[i].away) : ""}`).join(" &nbsp;|&nbsp; ")}</div>
      <div class="pd-cmpbar"><button id="pdCmpEnd">✕ end comparison</button></div>
      <div class="pd-chips">${avail.map((s2) => `<button data-s="${s2}" class="${s2 === k ? "on" : ""}">${PSTAT[s2]}</button>`).join("")}</div>
      <div class="pd-ctl"><label>Line <input id="pdLine" type="number" step="0.5" value="${line}"></label>
        <div class="seg" id="pdRange">${[["L5", "Last 5"], ["L10", "Last 10"], ["season", String(model.season)], ["last", String(model.season - 1)]].map(([v, t]) => `<button data-v="${v}" class="${pd.range === v ? "on" : ""}">${t}</button>`).join("")}</div></div>
      <div class="pd-chart"><svg viewBox="0 0 ${W} ${H}">${svg}</svg>
        <div class="gd-note" style="margin:2px 6px 6px"><span style="color:${colors[0]}">■</span> ${metas[0].name} &nbsp; <span style="color:${colors[1]}">■</span> ${metas[1].name} · faded bars = under the line · aligned by games ago</div></div>
      <div class="sec"><h4>Head to head · ${PSTAT[k]}</h4><table class="pd-h2h"><tr><th></th><th style="color:${colors[0]}">${metas[0].short || metas[0].name}</th><th style="color:${colors[1]}">${metas[1].short || metas[1].name}</th></tr>${tbl}</table></div>`;
    $("pd").querySelector(".pd-x").onclick = closePlayer;
    $("pdCmpEnd").onclick = () => { pd.cmp = null; pd.line = null; renderPlayer(); };
    $("pd").querySelectorAll(".pd-chips button").forEach((b) => (b.onclick = () => { pd.stat = b.dataset.s; pd.line = null; renderPlayer(); }));
    $("pd").querySelectorAll("#pdRange button").forEach((b) => (b.onclick = () => { pd.range = b.dataset.v; renderPlayer(); }));
    $("pdLine").onchange = () => { pd.line = +$("pdLine").value; renderPlayer(); };
  }
  function renderPlayerSingle() {
    const pid = pd.pid, meta = playerMeta(pid), L = (plogs[pid] && plogs[pid].log) || [];
    const pos = meta.pos || (plogs[pid] || {}).pos || "";
    const statsFor = pos === "QB" ? ["py", "pc", "ptd", "pint", "ry", "fp"] : pos === "RB" ? ["ry", "ra", "recy", "rec", "rry", "td", "fp"] : ["recy", "rec", "tg", "rry", "td", "fp"];
    const avail = statsFor.filter((k) => L.some((e) => statVal(e, k) > 0));
    if (!pd.stat || !PSTAT[pd.stat]) pd.stat = avail[0] || statsFor[0];
    const k = pd.stat;
    const season = model.season;
    let games = L.slice();
    if (pd.range === "L5") games = L.filter((e) => e.s === season).slice(-5);
    else if (pd.range === "L10") games = L.slice(-10);
    else if (pd.range === "season") games = L.filter((e) => e.s === season);
    else if (pd.range === "last") games = L.filter((e) => e.s === season - 1);
    const vals = games.map((e) => statVal(e, k));
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
    const proj = projectionFor(pid, meta.team);
    let mp = proj && proj.res.players[pid] && proj.res.players[pid].d[k] ? proj.res.players[pid].d[k] : null;
    if (k === "fp" && proj && proj.res.players[pid]) {   // fantasy points per simulated game
      const r = proj.res.players[pid].r, n = r.py.length, arr = new Float64Array(n);
      for (let i = 0; i < n; i++) arr[i] = Math.round(NFLSim.fantasyPoints({ py: r.py[i], ptd: r.ptd[i], pint: r.pint[i], ry: r.ry[i], rtd: r.td[i] - 0, rec: r.rec[i], recy: r.recy[i] }, ft.fmt) * 10) / 10;
      // r.td = rush+rec TDs; scoring is 6 either way, so put them all under rtd
      mp = arr.sort();
    }
    const mMed = mp ? mp[Math.floor(mp.length / 2)] : null;
    if (pd.line == null || isNaN(pd.line)) pd.line = k === "td" ? 0.5 : Math.floor(mMed != null ? mMed : med) + 0.5;
    const line = pd.line;
    const over = vals.filter((v) => v > line).length;
    const all = L.filter((e) => e.s === season).map((e) => statVal(e, k));
    const l5 = all.slice(-5);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const bookProp = edges && edges.bets.find((b) => b.pid === pid && b.stat === k && (b.side === "over" || b.side === "yes"));
    const g = proj && proj.game, opp = g ? (g.home === meta.team ? g.away : g.home) : null;

    // chart
    const W = 520, H = 210, padL = 30, padB = 34, padT = 14, n = vals.length;
    const maxV = Math.max(line * 1.15, ...vals, 1), bw = n ? (W - padL - 6) / n : 0;
    const Y = (v) => H - padB - (v / maxV) * (H - padB - padT);
    let svg = "";
    for (let t = 0; t <= 4; t++) { const v = (maxV * t) / 4; svg += `<line x1="${padL}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="#1d2a38"/><text x="${padL - 4}" y="${Y(v) + 3}" fill="#7d8ea1" font-size="9" font-family="monospace" text-anchor="end">${Math.round(v)}</text>`; }
    games.forEach((e, i) => {
      const v = vals[i], x = padL + i * bw + bw * 0.15, w = bw * 0.7, c = v > line ? "#3ecf8e" : v === line ? "#7d8ea1" : "#ef5b5b";
      svg += `<rect x="${x}" y="${Y(v)}" width="${w}" height="${Math.max(1, H - padB - Y(v))}" rx="3" fill="${c}" opacity="${e.s === season ? 0.9 : 0.5}"><title>${e.s} wk ${e.w} ${e.h ? "vs" : "@"} ${e.opp}: ${v}</title></rect>`;
      if (n <= 14) svg += `<text x="${x + w / 2}" y="${Y(v) - 4}" fill="#e8eef5" font-size="10" font-family="monospace" text-anchor="middle">${v}</text>`;
      const every = Math.ceil(n / 10);
      if ((n - 1 - i) % every === 0) svg += `<text x="${x + w / 2}" y="${H - padB + 13}" fill="#7d8ea1" font-size="9" font-family="monospace" text-anchor="middle">${e.s !== season ? "'" + String(e.s).slice(2) + " " : ""}W${e.w}</text>
              <text x="${x + w / 2}" y="${H - padB + 25}" fill="${col(e.opp)}" font-size="9" font-family="monospace" text-anchor="middle">${e.h ? "" : "@"}${e.opp}</text>`;
    });
    svg += `<line x1="${padL}" x2="${W}" y1="${Y(line)}" y2="${Y(line)}" stroke="#f2c94c" stroke-width="2" stroke-dasharray="6 4"/>
            <text x="${W - 2}" y="${Y(line) - 5}" fill="#f2c94c" font-size="11" font-family="monospace" text-anchor="end">line ${line}</text>`;
    if (!n) svg += `<text x="${W / 2}" y="${H / 2}" fill="#7d8ea1" font-size="13" font-family="monospace" text-anchor="middle">No games in this range</text>`;

    // model card
    let modelHtml = "";
    if (proj && mp) {
      const pOver = mp.filter((v) => v > line).length / mp.length;
      const nx = proj.game, at = nx.home === meta.team ? "vs" : "@";
      const defKey = ["ry", "ra", "rry"].includes(k) ? "ypr" : "ypc";
      const dr = opp ? defRank(opp, defKey) : null;
      modelHtml = `<div class="pd-model"><h4>Model · next game ${at} ${opp}</h4><div class="row">
        <span>median <b>${mMed}</b></span><span>mean <b>${(mp.reduce((a, b) => a + b, 0) / mp.length).toFixed(1)}</b></span>
        <span>80% range <b>${mp[Math.floor(mp.length * 0.1)]}–${mp[Math.floor(mp.length * 0.9)]}</b></span>
        <span>over ${line}: <b style="color:${pOver >= 0.5 ? "var(--good)" : "var(--bad)"}">${(pOver * 100).toFixed(0)}%</b> (fair ${american(pOver)})</span></div>
        ${bookProp ? `<div class="pd-opp">Book: ${bookProp.line != null && k !== "td" ? "o" + bookProp.line + " " : ""}${bookProp.price > 0 ? "+" + bookProp.price : bookProp.price} at ${bookProp.book} · model ${(bookProp.p * 100).toFixed(0)}% vs book ${(bookProp.p_implied * 100).toFixed(0)}%</div>` : ""}
        ${dr ? `<div class="pd-opp">${opp} defense allows ${dr.val.toFixed(1)} ${defKey === "ypr" ? "yds/carry" : "yds/completion"}, ${dr.rank === 1 ? "the fewest" : dr.rank === 32 ? "the most" : dr.rank <= 16 ? `the ${ord(dr.rank)} fewest` : `the ${ord(33 - dr.rank)} most`} in the league${dr.rank <= 8 ? " (tough matchup)" : dr.rank >= 25 ? " (soft matchup)" : ""}.</div>` : ""}
      </div>`;
    } else if (proj) {
      modelHtml = `<div class="pd-model"><h4>Model</h4><div class="pd-opp">Not projected for the next game${meta.out ? " (ruled out on the injury report)" : ""}.</div></div>`;
    }

    // game log
    const cols = pos === "QB" ? [["pc", "CMP"], ["pa", "ATT"], ["py", "YDS"], ["ptd", "TD"], ["pint", "INT"], ["ra", "CAR"], ["ry", "RYD"]]
      : pos === "RB" ? [["ra", "CAR"], ["ry", "YDS"], ["rtd", "TD"], ["tg", "TGT"], ["rec", "REC"], ["recy", "RCYD"], ["share", "CAR %"]]
      : [["tg", "TGT"], ["rec", "REC"], ["recy", "YDS"], ["rectd", "TD"], ["share", "TGT %"], ["ra", "CAR"], ["ry", "RYD"]];
    const cell = (e, c) => c === "share" ? (pos === "RB" ? (e.tra ? Math.round(((e.ra || 0) / e.tra) * 100) + "%" : "–") : (e.ttg ? Math.round(((e.tg || 0) / e.ttg) * 100) + "%" : "–")) : e[c] || 0;
    const rows = L.slice().reverse().map((e) => {
      const v = statVal(e, k), res = e.pf > e.pa_ ? "W" : e.pf < e.pa_ ? "L" : "T";
      return `<tr><td>${e.s !== season ? "'" + String(e.s).slice(2) + " " : ""}W${e.w}</td><td>${e.h ? "vs" : "@"} <span style="color:${col(e.opp)}">${e.opp}</span></td><td>${res} ${e.pf}–${e.pa_}</td>
        ${cols.map(([c]) => `<td class="${(c === k || (k === "rry" && (c === "ry" || c === "recy"))) ? (v > line ? "hi" : "lo") : ""}">${cell(e, c)}</td>`).join("")}</tr>`;
    }).join("");

    const nx = nextGame(meta.team);
    $("pd").style.setProperty("--tm", col(meta.team));
    $("pd").innerHTML = `<button class="pd-x" title="Close (Esc)">✕</button>
      <h3 class="pd-name">${meta.name}</h3>
      <div class="pd-sub"><span style="color:${col(meta.team)}">${meta.team}</span> · ${pos}${meta.status ? `<span class="st">${meta.status}</span>` : ""}${meta.out && !meta.status ? `<span class="st">not active</span>` : ""}</div>
      ${nx ? `<div class="pd-next">Next: ${nx.away === meta.team ? "@ " + nx.home : "vs " + nx.away} · ${new Date(nx.date + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${nx.time || ""}</div>` : ""}
      <div class="pd-chips">${avail.map((s) => `<button data-s="${s}" class="${s === k ? "on" : ""}">${PSTAT[s]}</button>`).join("") || '<span class="dim">No stats recorded yet</span>'}</div>
      <div class="pd-ctl"><label>Line <input id="pdLine" type="number" step="0.5" value="${line}"></label>
        <div class="seg" id="pdRange">${[["L5", "Last 5"], ["L10", "Last 10"], ["season", String(season)], ["last", String(season - 1)]].map(([v, t]) => `<button data-v="${v}" class="${pd.range === v ? "on" : ""}">${t}</button>`).join("")}</div></div>
      <div class="pd-chart"><svg viewBox="0 0 ${W} ${H}">${svg}</svg></div>
      <div class="pd-cards">
        <div class="card"><div class="k">Over ${line}</div><div class="v ${over / (n || 1) >= 0.5 ? "good" : "bad"}">${over}/${n}</div><div class="s">${n ? Math.round((over / n) * 100) : 0}% of games shown</div></div>
        <div class="card"><div class="k">Last 5 (${season})</div><div class="v">${l5.filter((v) => v > line).length}/${l5.length}</div><div class="s">${l5.join(" · ") || "–"}</div></div>
        <div class="card"><div class="k">Avg / median</div><div class="v">${avg.toFixed(1)}</div><div class="s">median ${med} · high ${sorted[sorted.length - 1] ?? "–"}</div></div>
      </div>
      ${modelHtml}
      <div class="sec"><h4>Game log</h4><table><tr><th>Wk</th><th>Opp</th><th>Result</th>${cols.map(([, t]) => `<th>${t}</th>`).join("")}</tr>${rows || '<tr><td colspan="10" class="dim">No games yet</td></tr>'}</table></div>`;
    $("pd").querySelector(".pd-x").onclick = closePlayer;
    $("pd").querySelectorAll(".pd-chips button").forEach((b) => (b.onclick = () => { pd.stat = b.dataset.s; pd.line = null; renderPlayer(); }));
    $("pd").querySelectorAll("#pdRange button").forEach((b) => (b.onclick = () => { pd.range = b.dataset.v; renderPlayer(); }));
    $("pdLine").onchange = () => { pd.line = +$("pdLine").value; renderPlayer(); };
  }

  // ---------------- roster ----------------
  function renderRoster() {
    const block = (t) => {
      const ps = model.teams[t].players;
      return `<div class="team"><h3 style="color:${col(t)}">${t}</h3><div class="hdr"><span></span><span>Player</span><span>Status</span><span>Carry %</span><span>Target %</span></div>` +
        ps.map((p) => `<label class="${outSet.has(p.id) ? "off" : ""}"><input type="checkbox" data-id="${p.id}" ${outSet.has(p.id) ? "" : "checked"}>
          <span><span class="plink" data-pid="${p.id}">${p.name}</span> <span class="pos">${p.pos}</span></span><span class="st">${p.status || (p.gone ? "Inactive" : p.out ? "Not active" : "")}</span>
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
