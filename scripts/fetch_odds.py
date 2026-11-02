"""Fetch NFL game lines and player props from The Odds API into site/data/odds.json.

    ODDS_API_KEY=... python scripts/fetch_odds.py [--out site/data/odds.json] [--props-hours 30]

Credit budget (free plan = 500 credits/month): game lines cost 3 credits per run
(h2h + spreads + totals, US books). Player props cost 1 credit per market per game, so they're
only fetched for games kicking off within --props-hours (default 30h). With one run per day
that's each game once: ~16 games x 5 markets + 3/day ~= 100 credits a week.
Props already fetched earlier are kept, so the board stays filled between runs.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.the-odds-api.com/v4"
SPORT = "americanfootball_nfl"
PROP_MARKETS = ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions", "player_anytime_td"]
BOOKS = "draftkings,fanduel,betmgm,williamhill_us,espnbet,betrivers,fanatics"
TEAMS = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF",
    "Carolina Panthers": "CAR", "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE",
    "Dallas Cowboys": "DAL", "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX", "Kansas City Chiefs": "KC",
    "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LA", "Miami Dolphins": "MIA",
    "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "San Francisco 49ers": "SF",
    "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}


def get(path, key, **params):
    params["apiKey"] = key
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        remaining = r.headers.get("x-requests-remaining")
        return json.load(r), (int(float(remaining)) if remaining else None)


def books_view(event):
    """{market: [(book, outcome), ...]} flattened across bookmakers."""
    out = {}
    for b in event.get("bookmakers", []):
        for m in b.get("markets", []):
            for o in m.get("outcomes", []):
                out.setdefault(m["key"], []).append((b.get("title", b["key"]), o))
    return out


def best(outcomes, pred):
    """Best (highest) American price among outcomes matching pred -> (price, book)."""
    c = [(o["price"], book) for book, o in outcomes if pred(o)]
    return max(c, key=lambda x: x[0]) if c else (None, None)


def consensus_point(outcomes, pred):
    pts = [o.get("point") for _, o in outcomes if pred(o) and o.get("point") is not None]
    return max(set(pts), key=pts.count) if pts else None


def game_lines(ev, away, home):
    bv = books_view(ev)
    g = {}
    h2h = bv.get("h2h", [])
    for side, name in (("away", ev["away_team"]), ("home", ev["home_team"])):
        g[f"ml_{side}"], g[f"ml_{side}_book"] = best(h2h, lambda o, n=name: o["name"] == n)
    sp = bv.get("spreads", [])
    hp = consensus_point(sp, lambda o: o["name"] == ev["home_team"])
    if hp is not None:
        g["spread_home"] = hp  # e.g. -3.5 = home favored by 3.5
        g["spread_home_price"], g["spread_home_book"] = best(sp, lambda o: o["name"] == ev["home_team"] and o.get("point") == hp)
        g["spread_away_price"], g["spread_away_book"] = best(sp, lambda o: o["name"] == ev["away_team"] and o.get("point") == -hp)
    tt = bv.get("totals", [])
    tp = consensus_point(tt, lambda o: o["name"] == "Over")
    if tp is not None:
        g["total"] = tp
        g["over_price"], g["over_book"] = best(tt, lambda o: o["name"] == "Over" and o.get("point") == tp)
        g["under_price"], g["under_book"] = best(tt, lambda o: o["name"] == "Under" and o.get("point") == tp)
    return g


def props(ev):
    bv = books_view(ev)
    out = []
    for market in PROP_MARKETS:
        oc = bv.get(market, [])
        players = sorted({o.get("description") for _, o in oc if o.get("description")})
        for pl in players:
            mine = [(b, o) for b, o in oc if o.get("description") == pl]
            if market == "player_anytime_td":
                price, book = best(mine, lambda o: o["name"] in ("Yes", "Over"))
                if price is not None:
                    out.append(dict(player=pl, market=market, line=0.5, over_price=price, over_book=book))
                continue
            pt = consensus_point(mine, lambda o: o["name"] == "Over")
            if pt is None:
                continue
            op, ob = best(mine, lambda o: o["name"] == "Over" and o.get("point") == pt)
            up, ub = best(mine, lambda o: o["name"] == "Under" and o.get("point") == pt)
            out.append(dict(player=pl, market=market, line=pt, over_price=op, over_book=ob, under_price=up, under_book=ub,
                            books=len({b for b, _ in mine})))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data/odds.json")
    ap.add_argument("--props-hours", type=float, default=30)
    ap.add_argument("--min-credits", type=int, default=40, help="skip props when fewer credits remain")
    a = ap.parse_args()
    key = os.environ.get("ODDS_API_KEY")
    if not key:
        print("odds: ODDS_API_KEY not set, skipping"); return
    old = {}
    if os.path.exists(a.out):
        try:
            old = json.load(open(a.out))
        except Exception:
            old = {}
    now = datetime.now(timezone.utc)
    events, remaining = get(f"/sports/{SPORT}/odds", key, regions="us", markets="h2h,spreads,totals",
                            oddsFormat="american", bookmakers=BOOKS)
    games = {}
    n_props = 0
    for ev in events:
        away, home = TEAMS.get(ev["away_team"]), TEAMS.get(ev["home_team"])
        if not away or not home:
            continue
        ko = datetime.fromisoformat(ev["commence_time"].replace("Z", "+00:00"))
        gid = f"{away}@{home}"
        g = dict(event_id=ev["id"], away=away, home=home, commence=ev["commence_time"], lines_updated=now.isoformat(timespec="minutes"))
        g.update(game_lines(ev, away, home))
        prev = old.get("games", {}).get(gid, {})
        if prev.get("event_id") == ev["id"] and prev.get("props"):
            g["props"], g["props_updated"] = prev["props"], prev.get("props_updated")
        if timedelta(0) < ko - now <= timedelta(hours=a.props_hours) and (remaining is None or remaining >= a.min_credits):
            try:
                pe, remaining = get(f"/sports/{SPORT}/events/{ev['id']}/odds", key, regions="us",
                                    markets=",".join(PROP_MARKETS), oddsFormat="american", bookmakers=BOOKS)
                g["props"] = props(pe)
                g["props_updated"] = now.isoformat(timespec="minutes")
                n_props += 1
            except Exception as e:
                print(f"odds: props failed for {gid}: {e}")
        games[gid] = g
    json.dump(dict(updated=now.isoformat(timespec="minutes"), credits_remaining=remaining, games=games), open(a.out, "w"))
    print(f"odds: {len(games)} games with lines, props refreshed for {n_props}, credits remaining {remaining}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never break the site build over odds
        print("odds: failed:", e)
        sys.exit(0)
