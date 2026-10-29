"""Build the simulator's model file (site/data/model.json) from nflverse data.

Usage:
    python scripts/build_data.py                 # current season, all completed weeks
    python scripts/build_data.py --week 7        # only use games before week 7 (for backtests)
    python scripts/build_data.py --season 2026 --raw data_raw --out site/data/model.json

Data comes from nflverse (CC BY 4.0): play-by-play, weekly rosters, injury reports,
player directory and the nfldata schedule (with closing spread/total lines).
"""
import argparse
import json
import math
import os
import urllib.request
from collections import defaultdict

import numpy as np
import pandas as pd

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
FILES = {
    "pbp_{s}.parquet": NFLVERSE + "/pbp/play_by_play_{s}.parquet",
    "pbp_{p}.parquet": NFLVERSE + "/pbp/play_by_play_{p}.parquet",
    "rosters_w_{s}.csv": NFLVERSE + "/weekly_rosters/roster_weekly_{s}.csv",
    "injuries_{s}.csv": NFLVERSE + "/injuries/injuries_{s}.csv",
    "players.csv": NFLVERSE + "/players/players.csv",
    "games.csv": "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv",
}

PRIOR_SEASON_WEIGHT = 0.15   # weight of each prior-season game in team rates
TEAM_HALF_LIFE = 4.0         # games; recency decay for team rates
PLAYER_HALF_LIFE = 3.0       # games; recency decay for player usage


def download(raw, season, refresh):
    os.makedirs(raw, exist_ok=True)
    for name, url in FILES.items():
        name = name.format(s=season, p=season - 1)
        url = url.format(s=season, p=season - 1)
        path = os.path.join(raw, name)
        if refresh or not os.path.exists(path):
            print("downloading", url)
            try:
                urllib.request.urlretrieve(url, path)
            except Exception as e:  # injury file can be missing early in a season
                print("  could not download:", e)


def logit(p):
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def wmean(x, w):
    w = np.asarray(w, float)
    return float(np.sum(np.asarray(x, float) * w) / np.sum(w)) if np.sum(w) > 0 else float("nan")


def shrink(rate, n, prior, k):
    """Bayesian-style shrinkage of a rate measured on n (weighted) trials toward prior."""
    if not np.isfinite(rate):
        return prior
    return (rate * n + prior * k) / (n + k)


def dist_bucket(d):
    if d <= 2: return 0
    if d <= 5: return 1
    if d <= 9: return 2
    if d == 10: return 3
    return 4


def script_bucket(score_diff, qtr, half_secs):
    """Game-script bucket for the offense: 0 neutral, 1 leading late, 2 trailing late, 3 two-minute."""
    if half_secs <= 120:
        return 3
    if qtr >= 3 and score_diff >= 9: return 1
    if qtr >= 3 and score_diff <= -9: return 2
    if qtr == 4 and score_diff > 0: return 1
    if qtr == 4 and score_diff < 0: return 2
    return 0


def load(raw, season, week):
    cur = pd.read_parquet(os.path.join(raw, f"pbp_{season}.parquet"))
    prev = pd.read_parquet(os.path.join(raw, f"pbp_{season - 1}.parquet"))
    cur = cur[cur.season_type == "REG"]
    prev = prev[prev.season_type == "REG"]
    if week is not None:
        cur = cur[cur.week < week]
    return cur, prev


def add_flags(d):
    d = d.copy()
    d["dropback"] = (d["pass"] == 1) & d.play_type.isin(["pass", "run"])
    d["scramble"] = d.dropback & (d.qb_scramble == 1)
    d["is_sack"] = d.dropback & (d.sack == 1)
    d["attempt"] = d.dropback & (d.play_type == "pass") & (d.sack != 1)
    d["designed_rush"] = (d.play_type == "run") & (d["pass"] != 1)
    d["scrimmage"] = d.dropback | d.designed_rush
    d["neutral"] = d.down.isin([1, 2, 3]) & (d.qtr <= 3) & (d.half_seconds_remaining > 120) & (d.score_differential.abs() <= 10)
    return d


def game_weights(d, team_col, half_life, base=1.0):
    """weight per (team, game_id): base * 0.5 ** (games_ago / half_life)."""
    out = {}
    g = d[["game_id", "week", team_col]].dropna().drop_duplicates()
    for team, grp in g.groupby(team_col):
        order = grp.sort_values("week", ascending=False).game_id.tolist()
        for k, gid in enumerate(order):
            out[(team, gid)] = base * 0.5 ** (k / half_life)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--week", type=int, default=None, help="use only games before this week")
    ap.add_argument("--raw", default="data_raw")
    ap.add_argument("--out", default="site/data/model.json")
    ap.add_argument("--refresh", action="store_true", help="re-download data files")
    a = ap.parse_args()

    games = None
    if a.season is None:
        if not os.path.exists(os.path.join(a.raw, "games.csv")):
            os.makedirs(a.raw, exist_ok=True)
            urllib.request.urlretrieve(FILES["games.csv"], os.path.join(a.raw, "games.csv"))
        games = pd.read_csv(os.path.join(a.raw, "games.csv"))
        played = games[games.home_score.notna()]
        a.season = int(played.season.max())
    download(a.raw, a.season, a.refresh)
    games = pd.read_csv(os.path.join(a.raw, "games.csv"))

    cur, prev = load(a.raw, a.season, a.week)
    cur, prev = add_flags(cur), add_flags(prev)
    through_week = int(cur.week.max())
    target_week = a.week if a.week is not None else through_week + 1
    print(f"season {a.season}: using weeks 1-{through_week}, building for week {target_week}")

    both = pd.concat([cur, prev], ignore_index=True)
    sc = both[both.scrimmage & both.down.notna()]

    # ---------------- league-wide tables ----------------
    league = {}
    # pass-rate base table by down x distance bucket (downs 1-3)
    sc3 = sc[sc.down.isin([1, 2, 3])].copy()
    sc3["db"] = sc3.ydstogo.apply(dist_bucket)
    base = np.zeros((3, 5))
    for dn in (1, 2, 3):
        for b in range(5):
            s = sc3[(sc3.down == dn) & (sc3.db == b)]
            base[dn - 1, b] = logit(s.dropback.mean()) if len(s) > 30 else 0.0
    league["pass_base"] = np.round(base, 3).tolist()
    sc3["script"] = [script_bucket(x, q, h) for x, q, h in zip(sc3.score_differential, sc3.qtr, sc3.half_seconds_remaining)]
    sc3["exp_logit"] = [base[int(dn) - 1, b] for dn, b in zip(sc3.down, sc3.db)]
    script_adj = []
    for sb in range(4):
        s = sc3[sc3.script == sb]
        exp_p = np.mean(1 / (1 + np.exp(-s.exp_logit)))
        script_adj.append(round(logit(s.dropback.mean()) - logit(exp_p), 3))
    league["pass_script"] = script_adj

    c = cur  # league rates from current season (more relevant), prior season as backup
    ccur = c[c.scrimmage]
    db = ccur[ccur.dropback]
    att = ccur[ccur.attempt]
    ru = ccur[ccur.designed_rush]
    league.update(
        sack_rate=float(db.is_sack.mean()),
        scramble_rate=float(db.scramble.mean()),
        int_rate=float(att.interception.mean()),
        comp_rate=float(att.complete_pass.mean()),
        ypc=float(att[att.complete_pass == 1].yards_gained.mean()),
        ypr=float(ru.yards_gained.mean()),
        fumble_rate_rush=float(ru.fumble_lost.mean()),
        fumble_rate_rec=float(att[att.complete_pass == 1].fumble_lost.mean()),
    )
    # completion-rate multiplier by field zone (inside 5, 6-10, 11-20, rest)
    def zone(y):
        return 0 if y <= 5 else 1 if y <= 10 else 2 if y <= 20 else 3
    att_b = both[both.attempt].copy()
    att_b["z"] = att_b.yardline_100.apply(zone)
    allc = att_b.complete_pass.mean()
    league["comp_zone_mult"] = [round(float(att_b[att_b.z == z].complete_pass.mean() / allc), 3) for z in range(4)]

    def ints(series, n=None):
        v = series.dropna().astype(int).tolist()
        if n and len(v) > n:
            v = list(np.random.default_rng(1).choice(v, n, replace=False))
        return [int(x) for x in v]

    bsc = both[both.scrimmage]
    league["sack_yards"] = ints(bsc[bsc.is_sack].yards_gained, 400)
    league["scramble_yards"] = ints(bsc[bsc.scramble].yards_gained, 600)
    league["rush_yards"] = ints(bsc[bsc.designed_rush].yards_gained, 1500)
    league["comp_yards"] = ints(bsc[bsc.attempt & (bsc.complete_pass == 1)].yards_gained, 1500)
    # yards gained by field zone (1-5, 6-10, 11-20, 21-30, 31-40 yards from goal): near the goal
    # line the field compresses, so team-wide samples would turn too many long gains into TDs
    zones = [(1, 5), (6, 10), (11, 20), (21, 30), (31, 40)]
    league["zone_rush"] = [ints(bsc[bsc.designed_rush & bsc.yardline_100.between(lo, hi)].yards_gained, 800) for lo, hi in zones]
    league["zone_comp"] = [ints(bsc[bsc.attempt & (bsc.complete_pass == 1) & bsc.yardline_100.between(lo, hi)].yards_gained, 800) for lo, hi in zones]

    # 4th-down decisions: by field bucket (10 yd) x distance bucket
    fourth = both[(both.down == 4) & (both.half_seconds_remaining > 120) & (both.qtr <= 4)].copy()
    fourth["dec"] = np.where(fourth.play_type == "punt", "punt",
                     np.where(fourth.play_type == "field_goal", "fg",
                     np.where(fourth.scrimmage, "go", None)))
    fourth = fourth[fourth.dec.notna()]
    def d4(d):
        return 0 if d <= 1 else 1 if d <= 3 else 2 if d <= 6 else 3
    fourth["fb"] = (fourth.yardline_100.clip(1, 99) - 1) // 10
    fourth["db"] = fourth.ydstogo.apply(d4)
    table = []
    for fb in range(10):
        row = []
        for b in range(4):
            s = fourth[(fourth.fb == fb) & (fourth.db == b)]
            n = len(s)
            go = (s.dec == "go").sum() + 0.5
            pu = (s.dec == "punt").sum() + (0.5 if fb >= 4 else 0.01)
            fg = (s.dec == "fg").sum() + (0.5 if fb <= 3 else 0.01)
            t = go + pu + fg
            row.append([round(go / t, 3), round(pu / t, 3), round(fg / t, 3)])
        table.append(row)
    league["fourth"] = table

    # field goals: make rate by kick distance (5-yard bins, 18..67)
    fg = both[both.play_type == "field_goal"].copy()
    fg["dist"] = fg.yardline_100 + 18
    bins = []
    for lo in range(18, 70, 5):
        s = fg[(fg.dist >= lo) & (fg.dist < lo + 5)]
        made = (s.field_goal_result == "made").sum()
        prior = 0.98 if lo < 30 else 0.9 if lo < 40 else 0.78 if lo < 50 else 0.6 if lo < 60 else 0.3
        bins.append(round(float((made + prior * 5) / (len(s) + 5)), 3))
    league["fg_make"] = bins
    xp = both[both.play_type == "extra_point"]
    league["xp_make"] = float((xp.extra_point_result == "good").mean())

    # kickoffs -> receiving team's starting yardline_100 (from the next scrimmage play)
    def next_start(d, kind):
        out = []
        d = d.sort_values(["game_id", "play_id"])
        for gid, g in d.groupby("game_id", sort=False):
            types = g.play_type.tolist(); yl = g.yardline_100.tolist(); pos = g.posteam.tolist(); scr = g.scrimmage.tolist()
            for i, t in enumerate(types):
                if t != kind:
                    continue
                for j in range(i + 1, min(i + 6, len(types))):
                    if scr[j]:
                        if pos[j] != pos[i] and not math.isnan(yl[j]):
                            out.append((yl[i], yl[j]))
                        break
        return out
    ko = next_start(both, "kickoff")
    league["kickoff_start"] = [int(b) for _, b in ko if b >= 20 or True][:1500]
    pu = next_start(both, "punt")
    punts = defaultdict(list)
    for before, after in pu:
        punts[int(min(9, (before - 1) // 10))].append(int(after))
    league["punt_start"] = {str(k): v[:400] for k, v in punts.items()}

    # penalties as separate snap events (accepted penalties that wipe the play: no_play)
    snaps = both[both.scrimmage | ((both.play_type == "no_play") & (both.penalty == 1))]
    np_pen = snaps[(snaps.play_type == "no_play") & (snaps.penalty == 1) & snaps.penalty_yards.notna()]
    off_pen = np_pen[np_pen.penalty_team == np_pen.posteam]
    def_pen = np_pen[np_pen.penalty_team == np_pen.defteam]
    league["pen_off_rate"] = float(len(off_pen) / len(snaps))
    league["pen_def_rate"] = float(len(def_pen) / len(snaps))
    league["pen_off_yards"] = ints(off_pen.penalty_yards, 300)
    league["pen_def"] = [[int(y), int(f)] for y, f in zip(def_pen.penalty_yards.fillna(5), def_pen.first_down_penalty.fillna(0))][:400]

    # clock: seconds consumed per snap (time to next snap, same drive & quarter)
    b2 = both.sort_values(["game_id", "play_id"]).copy()
    b2["next_gsr"] = b2.groupby("game_id").game_seconds_remaining.shift(-1)
    b2["next_qtr"] = b2.groupby("game_id").qtr.shift(-1)
    b2["next_drive"] = b2.groupby("game_id").fixed_drive.shift(-1)
    s2 = b2[b2.scrimmage & (b2.next_qtr == b2.qtr) & (b2.next_drive == b2.fixed_drive)].copy()
    s2["dt"] = (s2.game_seconds_remaining - s2.next_gsr).clip(0, 60)
    s2["inc"] = s2.incomplete_pass == 1
    nonin = s2[~s2.inc]
    league["clock_incomplete"] = float(s2[s2.inc & (s2.half_seconds_remaining > 120)].dt.median())
    league["clock_neutral"] = ints(nonin[(nonin.half_seconds_remaining > 300) & (nonin.score_differential.abs() <= 8)].dt, 800)
    league["clock_hurry"] = ints(nonin[(nonin.half_seconds_remaining <= 120) & (nonin.score_differential <= 0)].dt, 500)
    league["clock_milk"] = ints(nonin[(nonin.qtr == 4) & (nonin.score_differential > 0)].dt, 500)
    neutral_mean = float(np.mean(league["clock_neutral"]))
    npen = b2[(b2.play_type == "no_play") & (b2.penalty == 1) & (b2.next_qtr == b2.qtr)]
    league["clock_penalty"] = float((npen.game_seconds_remaining - npen.next_gsr).clip(0, 60).mean())
    reg = cur[cur.play_type.isin(["pass", "run"])]
    league["target_plays_per_team"] = float(len(reg) / (cur.game_id.nunique() * 2))
    league["clock_scale"] = 1.0  # tuned by scripts/calibrate.js
    league["yds_scale"] = 1.0    # tuned by scripts/calibrate.js
    league["home_yds"] = 1.012   # home-field edge on yards gained (about 1.5 points)
    gp = games[(games.season == a.season) & (games.game_type == "REG") & (games.week < target_week) & games.home_score.notna()]
    league["target_pts_per_team"] = float((gp.home_score.sum() + gp.away_score.sum()) / (2 * len(gp)))

    # ---------------- per-team rates ----------------
    w_cur_off = game_weights(cur, "posteam", TEAM_HALF_LIFE)
    w_prev_off = {k: PRIOR_SEASON_WEIGHT for k in game_weights(prev, "posteam", 1e9)}
    w_cur_def = game_weights(cur, "defteam", TEAM_HALF_LIFE)
    w_prev_def = {k: PRIOR_SEASON_WEIGHT for k in game_weights(prev, "defteam", 1e9)}

    def weighted(d, side):
        wc = w_cur_off if side == "posteam" else w_cur_def
        wp = w_prev_off if side == "posteam" else w_prev_def
        w = [wc.get((t, g), wp.get((t, g), 0.0)) for t, g in zip(d[side], d.game_id)]
        return d.assign(w=w)

    scb = both[both.scrimmage].copy()
    scb["db"] = scb.ydstogo.fillna(10).apply(dist_bucket)
    scb["script"] = [script_bucket(x, q, h) for x, q, h in zip(scb.score_differential.fillna(0), scb.qtr, scb.half_seconds_remaining)]
    dn = scb.down.fillna(1).clip(1, 3).astype(int) - 1
    scb["exp_p"] = 1 / (1 + np.exp(-(base[dn, scb.db] + np.array(script_adj)[scb.script])))

    teams = sorted(set(cur.posteam.dropna()))
    out_teams = {}
    s2w_off = weighted(s2[~s2.inc & s2.neutral], "posteam")

    for side in ("posteam", "defteam"):
        dsc = weighted(scb[scb.down.isin([1, 2, 3])], side)
        for t in teams:
            g = dsc[dsc[side] == t]
            row = out_teams.setdefault(t, {"off": {}, "def": {}})
            key = "off" if side == "posteam" else "def"
            n = g.w.sum()
            act = wmean(g.dropback, g.w)
            exp = wmean(g.exp_p, g.w)
            row[key]["pass_oe"] = round(shrink(logit(act) - logit(exp), n, 0.0, 40), 3)

    for side in ("posteam", "defteam"):
        key = "off" if side == "posteam" else "def"
        d = weighted(scb, side)
        for t in teams:
            g = d[d[side] == t]
            dbk = g[g.dropback]; at = g[g.attempt]; r = g[g.designed_rush]
            comp = at[at.complete_pass == 1]
            o = out_teams[t][key]
            o["sack_rate"] = round(shrink(wmean(dbk.is_sack, dbk.w), dbk.w.sum(), league["sack_rate"], 60), 4)
            o["scramble_rate"] = round(shrink(wmean(dbk.scramble, dbk.w), dbk.w.sum(), league["scramble_rate"], 60), 4)
            o["int_rate"] = round(shrink(wmean(at.interception, at.w), at.w.sum(), league["int_rate"], 150), 4)
            o["comp_rate"] = round(shrink(wmean(at.complete_pass, at.w), at.w.sum(), league["comp_rate"], 60), 4)
            o["ypc"] = round(shrink(wmean(comp.yards_gained, comp.w), comp.w.sum(), league["ypc"], 60), 3)
            o["ypr"] = round(shrink(wmean(r.yards_gained, r.w), r.w.sum(), league["ypr"], 80), 3)
            if key == "off":
                o["rush_yards"] = ints(r[r.season == a.season].yards_gained)
                o["comp_yards"] = ints(comp[comp.season == a.season].yards_gained)
                pace = s2w_off[s2w_off.posteam == t]
                o["pace"] = round(shrink(wmean(pace.dt, pace.w), pace.w.sum(), neutral_mean, 60) / neutral_mean, 3)

    # ---------------- players ----------------
    players = pd.read_csv(os.path.join(a.raw, "players.csv"), low_memory=False).set_index("gsis_id")
    rost = pd.read_csv(os.path.join(a.raw, f"rosters_w_{a.season}.csv"), low_memory=False)
    rweek = min(target_week, int(rost.week.max()))
    rost = rost[rost.week == rweek]
    roster_team = dict(zip(rost.gsis_id, rost.team))
    roster_status = dict(zip(rost.gsis_id, rost.status))
    inj = {}
    ipath = os.path.join(a.raw, f"injuries_{a.season}.csv")
    if os.path.exists(ipath):
        ij = pd.read_csv(ipath, low_memory=False)
        ij = ij[(ij.week == target_week) & ij.report_status.notna()]
        inj = dict(zip(ij.gsis_id, ij.report_status))

    def pinfo(pid, fallback):
        if pid in players.index:
            p = players.loc[pid]
            name = p.display_name if isinstance(p.display_name, str) else fallback
            pos = p.position if isinstance(p.position, str) else ""
        else:
            name, pos = fallback, ""
        parts = name.split(" ")
        short = (parts[0][0] + ". " + " ".join(parts[1:])) if len(parts) > 1 else name
        return name, short, pos

    pw = game_weights(cur, "posteam", PLAYER_HALF_LIFE)
    cs = cur[cur.scrimmage].copy()
    cs["w"] = [pw.get((t, g), 0) for t, g in zip(cs.posteam, cs.game_id)]

    for t in teams:
        g = cs[cs.posteam == t]
        team_comp = out_teams[t]["off"]["comp_rate"]
        roster = {}

        def P(pid, fallback):
            if pid not in roster:
                name, short, pos = pinfo(pid, fallback)
                status = inj.get(pid, "")
                on_team = roster_team.get(pid) == t
                active = roster_status.get(pid) == "ACT"
                roster[pid] = dict(id=pid, name=name, short=short, pos=pos, status=status,
                                   out=bool((not on_team) or (not active) or status in ("Out", "Doubtful")),
                                   gone=bool(not on_team or roster_status.get(pid) in ("CUT", "RES", "RET", "TRD", "TRT")),
                                   rush=0.0, rush_rz=0.0, tgt=0.0, tgt_rz=0.0, catch=None, rush_y=[], rec_y=[], db=0.0)
            return roster[pid]

        # QBs: weighted dropbacks
        for pid, nm, w in zip(g[g.dropback].passer_player_id, g[g.dropback].passer_player_name, g[g.dropback].w):
            if isinstance(pid, str):
                P(pid, nm)["db"] += w
        r = g[g.designed_rush & g.rusher_player_id.notna()]
        for pid, nm, w, y, yl in zip(r.rusher_player_id, r.rusher_player_name, r.w, r.yards_gained, r.yardline_100):
            p = P(pid, nm); p["rush"] += w; p["rush_y"].append(int(y))
            if yl <= 10: p["rush_rz"] += w
        at = g[g.attempt & g.receiver_player_id.notna()]
        caught = defaultdict(float)
        for pid, nm, w, c, y, yl in zip(at.receiver_player_id, at.receiver_player_name, at.w, at.complete_pass, at.yards_gained, at.yardline_100):
            p = P(pid, nm); p["tgt"] += w
            if yl <= 20: p["tgt_rz"] += w
            if c == 1:
                caught[pid] += w; p["rec_y"].append(int(y))
        tot = {k: sum(p[k] for p in roster.values()) or 1 for k in ("rush", "rush_rz", "tgt", "tgt_rz")}
        plist = []
        for pid, p in roster.items():
            if p["gone"] and p["db"] == 0 and p["rush"] + p["tgt"] < 0.5:
                continue
            rs = p["rush"] / tot["rush"]; ts = p["tgt"] / tot["tgt"]
            p["rush_share"] = round(rs, 4)
            p["rush_rz_share"] = round((p["rush_rz"] + 6 * rs) / (tot["rush_rz"] + 6), 4)
            p["tgt_share"] = round(ts, 4)
            p["tgt_rz_share"] = round((p["tgt_rz"] + 8 * ts) / (tot["tgt_rz"] + 8), 4)
            p["catch"] = round(shrink(caught[pid] / p["tgt"] if p["tgt"] else float("nan"), p["tgt"], team_comp, 12), 4)
            p["db"] = round(p["db"], 3)
            for k in ("rush", "rush_rz", "tgt", "tgt_rz"):
                del p[k]
            if p["rush_share"] < 0.002 and p["tgt_share"] < 0.002 and p["db"] == 0:
                continue
            plist.append(p)
        plist.sort(key=lambda p: -(p["db"] * 3 + p["rush_share"] + p["tgt_share"]))
        out_teams[t]["players"] = plist

        # kicker: most recent kicker on roster
        k = cur[(cur.posteam == t) & cur.play_type.isin(["field_goal", "extra_point"]) & cur.kicker_player_id.notna()].sort_values(["week", "play_id"])
        kick = None
        for pid, nm in zip(k.kicker_player_id[::-1], k.kicker_player_name[::-1]):
            if roster_team.get(pid, t) == t and roster_status.get(pid, "ACT") == "ACT":
                kick = pid; kname = nm; break
        if kick is None and len(k):
            kick, kname = k.kicker_player_id.iloc[-1], k.kicker_player_name.iloc[-1]
        if kick is not None:
            name, short, pos = pinfo(kick, kname)
            out_teams[t]["kicker"] = dict(id=kick, name=name, short=short)
        else:
            out_teams[t]["kicker"] = dict(id=t + "-K", name=t + " K", short=t + " K")

    # ---------------- schedule ----------------
    gs = games[(games.season == a.season) & (games.game_type == "REG")]
    sched = []
    for _, x in gs.iterrows():
        sched.append(dict(game_id=x.game_id, week=int(x.week), date=str(x.gameday), time=str(x.gametime),
                          away=x.away_team, home=x.home_team,
                          away_score=None if pd.isna(x.away_score) else int(x.away_score),
                          home_score=None if pd.isna(x.home_score) else int(x.home_score),
                          spread=None if pd.isna(x.spread_line) else float(x.spread_line),
                          total=None if pd.isna(x.total_line) else float(x.total_line)))

    model = dict(
        generated=pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d %H:%M UTC"),
        season=a.season, through_week=through_week, target_week=target_week,
        league=league, teams=out_teams, schedule=sched,
        source="nflverse play-by-play, rosters, injuries (CC BY 4.0); nfldata schedule",
    )
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)

    def clean(o):
        if isinstance(o, dict): return {str(k): clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)): return [clean(v) for v in o]
        if isinstance(o, (np.integer,)): return int(o)
        if isinstance(o, (np.floating, float)):
            return None if not np.isfinite(o) else round(float(o), 4)
        if isinstance(o, np.bool_): return bool(o)
        return o
    with open(a.out, "w") as f:
        json.dump(clean(model), f, separators=(",", ":"))
    print("wrote", a.out, round(os.path.getsize(a.out) / 1e6, 2), "MB")


if __name__ == "__main__":
    main()
