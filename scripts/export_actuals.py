"""Export actual player rushing/receiving/passing yards per week for backtests.
Usage: python scripts/export_actuals.py --season 2026 --weeks 5 6 7"""
import argparse, json, os
import pandas as pd
ap = argparse.ArgumentParser()
ap.add_argument("--season", type=int, required=True)
ap.add_argument("--weeks", type=int, nargs="+", required=True)
ap.add_argument("--raw", default="data_raw")
a = ap.parse_args()
d = pd.read_parquet(os.path.join(a.raw, f"pbp_{a.season}.parquet"))
r = d[(d.season_type == "REG") & d.week.isin(a.weeks) & d.play_type.isin(["pass", "run"])]
out = {}
for (w, pid), g in r[r.rusher_player_id.notna() & (r["pass"] != 1)].groupby(["week", "rusher_player_id"]):
    out.setdefault(str(w), {}).setdefault(pid, {})["ry"] = int(g.yards_gained.sum())
for (w, pid), g in r[r.receiver_player_id.notna()].groupby(["week", "receiver_player_id"]):
    o = out.setdefault(str(w), {}).setdefault(pid, {})
    o["recy"] = int(g[g.complete_pass == 1].yards_gained.sum()); o["rec"] = int(g.complete_pass.sum())
for (w, pid), g in r[r.passer_player_id.notna()].groupby(["week", "passer_player_id"]):
    out.setdefault(str(w), {}).setdefault(pid, {})["py"] = int(g[g.sack != 1].passing_yards.fillna(0).sum())
os.makedirs("backtest", exist_ok=True)
json.dump(out, open("backtest/actual_players.json", "w"))
print("wrote backtest/actual_players.json")
