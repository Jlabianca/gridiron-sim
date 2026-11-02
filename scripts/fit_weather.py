"""Estimate how weather changes play outcomes, from multi-season nflverse play-by-play.

Writes scripts/weather_effects.json, which build_data.py copies into the model.
Run occasionally (it needs several seasons of pbp in data_raw/):
    python scripts/fit_weather.py --seasons 2018-2026

Method: for every play, subtract what that offense and that defense (in that season) normally
produce, then regress what's left on weather features. Comparing each team with itself removes
the "cold-weather teams are just better/worse" problem.
Features (0 in domes / closed roofs):
    wind = max(0, wind_mph - 10)     cold = max(0, 40 - temp_F)
    rain = rain/showers/drizzle in the weather text    snow = snow/flurries in the weather text
"""
import argparse
import json
import os
import re

import numpy as np
import pandas as pd

COLS = ["season", "season_type", "game_id", "posteam", "defteam", "play_type", "pass", "sack", "qb_scramble",
        "complete_pass", "interception", "yards_gained", "fumble_lost", "field_goal_result", "extra_point_result",
        "yardline_100", "roof", "temp", "wind", "weather", "down", "half_seconds_remaining", "score_differential", "qtr"]


def features(df):
    outdoor = df.roof.isin(["outdoors", "open"])
    w = df.weather.fillna("").str.lower()
    # the weather text often says "Wind: 9 mph"; use it when the wind column is missing
    wind = df.wind.copy()
    parsed = w.str.extract(r"wind:\s*\w*\s*(\d+)\s*mph")[0].astype(float)
    wind = wind.fillna(parsed)
    temp = df.temp.copy()
    temp = temp.fillna(w.str.extract(r"temp:\s*(-?\d+)")[0].astype(float))
    f = pd.DataFrame(index=df.index)
    f["f_wind"] = np.where(outdoor, np.clip(wind.fillna(8) - 10, 0, 30), 0.0)
    f["f_cold"] = np.where(outdoor, np.clip(40 - temp.fillna(60), 0, 45), 0.0)
    rain = w.str.contains(r"rain|shower|drizzle|storm") & ~w.str.contains(r"chance|no rain|0% chance")
    snow = w.str.contains(r"snow|flurr|sleet")
    f["f_rain"] = (outdoor & rain & ~snow).astype(float)
    f["f_snow"] = (outdoor & snow).astype(float)
    return f


def residualize(d, y, by_off=True):
    """y minus offense-season mean minus defense-season mean plus league mean."""
    lm = d[y].mean()
    om = d.groupby(["season", "posteam"])[y].transform("mean")
    dm = d.groupby(["season", "defteam"])[y].transform("mean")
    return d[y] - om - dm + lm


def ols(X, y):
    X = np.column_stack([np.ones(len(X)), X])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    s2 = resid @ resid / (len(y) - X.shape[1])
    se = np.sqrt(np.diag(s2 * np.linalg.inv(X.T @ X)))
    return beta[1:], se[1:]


def logit_fit(X, y, iters=50):
    X = np.column_stack([np.ones(len(X)), X])
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ b))
        W = p * (1 - p)
        H = X.T @ (X * W[:, None]) + 1e-6 * np.eye(len(b))
        b += np.linalg.solve(H, X.T @ (y - p))
    se = np.sqrt(np.diag(np.linalg.inv(H)))
    return b, se


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2018-2026")
    ap.add_argument("--raw", default="data_raw")
    ap.add_argument("--out", default="scripts/weather_effects.json")
    a = ap.parse_args()
    lo, hi = map(int, a.seasons.split("-"))
    frames = []
    for s in range(lo, hi + 1):
        p = os.path.join(a.raw, f"pbp_{s}.parquet")
        if os.path.exists(p):
            frames.append(pd.read_parquet(p, columns=COLS))
    d = pd.concat(frames, ignore_index=True)
    for c in ["temp", "wind", "yards_gained", "yardline_100", "sack", "complete_pass", "interception", "fumble_lost", "pass", "down", "qtr", "score_differential"]:
        d[c] = pd.to_numeric(d[c], errors="coerce").astype(float)
    d = d[d.season_type == "REG"]
    F = features(d)
    d = pd.concat([d, F], axis=1)
    cols = ["f_wind", "f_cold", "f_rain", "f_snow"]
    names = ["wind", "cold", "rain", "snow"]
    d = d.rename(columns={"wind": "wind_mph", "temp": "temp_f"})
    d = d.rename(columns=dict(zip(cols, names)))
    out = {"seasons": a.seasons, "features": names, "effects": {}, "se": {}, "n": {}}

    sc = d[d.play_type.isin(["pass", "run"])].copy()
    sc["dropback"] = (sc["pass"] == 1).astype(float)
    neutral = sc[sc.down.isin([1, 2]) & (sc.qtr <= 3) & (sc.score_differential.abs() <= 10)].copy()
    db = sc[sc.dropback == 1].copy()
    att = db[(db.play_type == "pass") & (db.sack != 1)].copy()
    comp = att[att.complete_pass == 1].copy()
    rush = sc[(sc.play_type == "run") & (sc["pass"] != 1)].copy()

    targets = [
        ("pass_rate", neutral, "dropback"),        # additive change in dropback probability
        ("sack_rate", db.assign(s=db.sack.astype(float)), "s"),
        ("comp_rate", att.assign(c=att.complete_pass.astype(float)), "c"),
        ("int_rate", att.assign(i=att.interception.astype(float)), "i"),
        ("comp_yards", comp, "yards_gained"),      # yards per completion
        ("rush_yards", rush, "yards_gained"),      # yards per carry
        ("fumble_rate", rush.assign(f=rush.fumble_lost.astype(float)), "f"),
    ]
    for key, df, y in targets:
        df = df[df[y].notna() & df.posteam.notna() & df.defteam.notna()]
        r = residualize(df, y)
        b, se = ols(df[names].to_numpy(float, na_value=0.0), r.to_numpy(float, na_value=0.0))
        base = df[y].mean()
        out["effects"][key] = {n: round(float(v), 5) for n, v in zip(names, b)}
        out["se"][key] = {n: round(float(v), 5) for n, v in zip(names, se)}
        out["n"][key] = int(len(df))
        out.setdefault("base", {})[key] = round(float(base), 4)

    # field goals: logistic on distance + weather
    fg = d[d.play_type == "field_goal"].copy()
    fg["made"] = (fg.field_goal_result == "made").astype(float)
    fg["dist"] = fg.yardline_100 + 18
    X = np.column_stack([fg.dist.values, fg[names].to_numpy(float)])
    b, se = logit_fit(X, fg.made.values)
    out["effects"]["fg_logit"] = {n: round(float(v), 5) for n, v in zip(names, b[2:])}
    out["se"]["fg_logit"] = {n: round(float(v), 5) for n, v in zip(names, se[2:])}
    out["n"]["fg_logit"] = int(len(fg))
    xp = d[d.play_type == "extra_point"].copy()
    xp["made"] = (xp.extra_point_result == "good").astype(float)
    b, se = logit_fit(xp[names].values, xp.made.values)
    out["effects"]["xp_logit"] = {n: round(float(v), 5) for n, v in zip(names, b[1:])}
    out["se"]["xp_logit"] = {n: round(float(v), 5) for n, v in zip(names, se[1:])}

    # games-level sanity: share of outdoor games with each condition
    g = d.drop_duplicates("game_id")
    out["share_games"] = {n: round(float((g[n] > 0).mean()), 3) for n in names}
    json.dump(out, open(a.out, "w"), indent=1)
    for k in out["effects"]:
        print(f"{k:12s}", "  ".join(f"{n} {out['effects'][k][n]:+.4f} (±{out['se'][k][n]:.4f})" for n in names))
    print("share of games:", out["share_games"])


if __name__ == "__main__":
    main()
