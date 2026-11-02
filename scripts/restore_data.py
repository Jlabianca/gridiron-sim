"""Restore the latest scorecard history and odds from the live site before a build.

The deployed site is the running store: each build downloads the current history.json and
odds.json from GitHub Pages, merges them with the copies in the repo, and redeploys.
    python scripts/restore_data.py https://<user>.github.io/<repo>
"""
import json
import os
import sys
import urllib.request

base = sys.argv[1].rstrip("/")


def fetch(name):
    try:
        with urllib.request.urlopen(f"{base}/data/{name}", timeout=30) as r:
            return json.load(r)
    except Exception as e:
        print(f"restore: no live {name} ({e})")
        return None


def load(path):
    try:
        return json.load(open(path))
    except Exception:
        return None


# history: union of games; a final (graded) entry wins, otherwise the live (newer) snapshot
path = "site/data/history.json"
live, repo = fetch("history.json"), load(path)
if live or repo:
    out = repo or live
    if live and repo and live.get("season") == repo.get("season"):
        games = dict(repo["games"])
        for gid, g in live["games"].items():
            r = games.get(gid)
            if r is None or (g.get("final") or not r.get("final")):
                games[gid] = g
        out = dict(live, games=games)
    elif live:
        out = live
    json.dump(out, open(path, "w"))
    print(f"restore: history has {len(out['games'])} games")

# odds: keep whichever copy is newer (props fetched earlier in the week live here)
path = "site/data/odds.json"
live, repo = fetch("odds.json"), load(path)
best = max([x for x in (live, repo) if x], key=lambda x: x.get("updated", ""), default=None)
if best:
    json.dump(best, open(path, "w"))
    print(f"restore: odds from {best.get('updated')}")

# power-rating history: union of weeks (live copy wins for the same week)
path = "site/data/ratings_history.json"
live, repo = fetch("ratings_history.json"), load(path)
if live or repo:
    out = repo or live
    if live and repo and live.get("season") == repo.get("season"):
        out = dict(repo, weeks=dict(repo.get("weeks", {}), **live.get("weeks", {})))
    elif live:
        out = live
    json.dump(out, open(path, "w"))
    print(f"restore: ratings history weeks {sorted(out['weeks'], key=int)}")
