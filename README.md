# Gridiron Sim

A play-by-play NFL game simulator that runs in the browser. Pick a matchup and you can:

https://jlabianca.github.io/gridiron-sim/

- **Watch a sim**: an animated, drive-by-drive replay of one simulated game, with a scoreboard, field view, line score and final box score. Every game comes from a seed, and *Copy link* shares that exact game (for example `#CAR@GB/42`).
- **Projections & props**: re-run the game 1,000–20,000 times to get win probability, fair moneylines, cover and over/under odds against the market line, the margin and total distributions, and per-player prop distributions. Type in a sportsbook line and it shows the model's over/under probability and fair odds.
- **Injuries / usage**: toggle players in or out. Players listed Out or Doubtful on the injury report, or not on the active roster, start out. Their carries and targets are re-split among the remaining players.

- **Same-game parlay builder** (Projections tab): add moneyline, spread, total, team total, player prop and anytime-TD legs. The model prices the parlay by counting how often *all* legs hit in the same simulated game, so correlated legs are priced as a combination, and shows that next to the "if independent" price and the EV against your book's odds.
- **Edge board**: every game with sportsbook lines is simulated 10,000 times and compared with the best price across major US books (lines from [The Odds API](https://the-odds-api.com)), ranked by expected value. Bets with very large gaps are flagged "check news".
- **Player panel**: click any player name (props, edge board, rosters, box scores, parlay legs) to see a chart of their recent games against a prop line you choose, hit rates, a game log with target and carry shares, and the model's projection and odds for their next game. It also shows the sportsbook line when there is one, plus how the opponent's defense ranks.
- **Scorecard**: every projection is saved before kickoff and graded afterwards, covering straight-up, against the spread, totals, strong picks, units at −110, and a Brier score against the market. Weeks 3–8 were backfilled from models rebuilt with only the data available before each week.

The site is fully static: one JSON model file and plain JavaScript, with no server. It's hosted on GitHub Pages, and a scheduled GitHub Action rebuilds the model from fresh nflverse data every day.

## How the model works

`scripts/build_data.py` reads nflverse play-by-play, weekly rosters, injury reports and the schedule (with closing lines), then writes `site/data/model.json`:

- **Team rates (offense and defense)**: sack, scramble, interception and completion rates, yards per completion and per carry, and pass rate over expected (by down, distance and game script). Rates are recency-weighted (half-life of 4 games), the prior season counts at a small weight, and everything is shrunk toward league average.
- **Matchups**: offense and defense rates are combined with log5, and yards are scaled by the defense's yards allowed. Home teams get about 1.5 points of edge.
- **Players**: carry and target shares come from recent games (half-life of 3 games), with separate red-zone and goal-line shares. Each player has a catch rate and their own yardage samples, so a deep threat and a check-down back produce different stat lines.
- **Situations**: league tables cover 4th-down go/punt/FG decisions, field-goal make rate by distance, kickoff and punt field position, penalties, field-zone yardage near the goal line, the clock (normal pace, hurry-up, milking the clock), kneel-downs, timeouts and overtime.

- **Weather**: the effects of wind (above 10 mph), cold (below 40°F), rain and snow on pass rate, sacks, completions, interceptions, yards per completion and carry, fumbles, and field-goal and extra-point accuracy. These are measured from 2018–2026 play-by-play by `scripts/fit_weather.py`, which compares every offense and defense with its own season average so that cold-weather teams being good or bad doesn't skew the results. Noisy effects are shrunk toward zero. Upcoming games get a forecast for kickoff ±3 hours from [Open-Meteo](https://open-meteo.com) (free, no API key). Domes and retractable roofs are treated as indoor. Completed games use the conditions that were actually reported. On the site you can also ignore the weather or enter your own.
- **Quarterbacks**: each QB's own sack, scramble, completion and interception rates and yards per completion, shrunk toward a "backup QB" baseline. The team's passing numbers are adjusted by how the starter compares with the QB mix that produced them, so a backup starting lowers the offense. Every active QB on the roster can be picked as the starter in the Injuries / usage tab.

`site/js/sim.js` plays the game one snap at a time from those tables. `scripts/calibrate.js` then adjusts two global constants so the simulated league matches the real season's plays per game and points per game.

### Backtest (2026 weeks 5–8, 56 games, each week using only data available before it)

| | v1 (no QB or weather) | v2 (QB + weather) | Closing market |
|---|---|---|---|
| Margin error (MAE) | 9.67 | 9.65 | 9.31 |
| Total error (MAE) | 10.97 | 10.69 | 10.68 |
| Picked the winner | 55% | 63% | 68% |

v2's margins correlate 0.74 with the closing spreads. Its rushing-yard projections correlate 0.69 with actual results, receiving yards 0.42 and passing yards 0.30. **Bottom line: it's sensible, but it doesn't beat the closing line.** Treat a gap between the model and the market as a reason to dig in, not as a bet. To rerun the backtest:

```bash
for w in 5 6 7 8; do python scripts/build_data.py --week $w --out backtest/model_w$w.json; node scripts/calibrate.js backtest/model_w$w.json; done
python scripts/export_actuals.py --season 2026 --weeks 5 6 7 8
node scripts/backtest.js 5 6 7 8          # add --no-weather / --no-qb to compare
```

## Run locally

```bash
pip install -r requirements.txt
python scripts/build_data.py          # downloads nflverse data into data_raw/, writes site/data/model.json
node scripts/calibrate.js             # tunes clock/scoring constants
cd site && python -m http.server 8000 # open http://localhost:8000
```

Opening `index.html` straight from disk won't work, because the page has to fetch the JSON file. Use the local server above.

## Deploy on GitHub Pages

1. Create a new repository on GitHub, then push this folder to it (`git init && git add . && git commit -m "Gridiron Sim" && git branch -M main && git remote add origin https://github.com/<you>/<repo>.git && git push -u origin main`).
2. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. The workflow in `.github/workflows/update.yml` runs on every push, daily at about 7am ET, and on demand from the **Actions** tab. It rebuilds the model and deploys the site to `https://<you>.github.io/<repo>/`.

### Sportsbook lines (optional)

The edge board needs a free API key from [The Odds API](https://the-odds-api.com), saved as the repository secret `ODDS_API_KEY` (Settings → Secrets and variables → Actions). The free plan allows 500 credits a month. Each daily run spends 3 credits on game lines. Player props (passing, rushing and receiving yards, receptions, anytime TD) cost 5 credits per game, so they're only fetched once a game is within about 30 hours of kickoff. That comes to roughly 100 credits a week. Without a key, everything else still works.

## Known limitations / ideas

- No rest days, travel or coaching changes. QB effects only cover passing efficiency, not play-calling.
- Weather effects are averages over every regular-season game from 2018 to 2026. Snow is rare (around 0.7% of games), so its effects are uncertain and shrunk heavily.
- Two-point conversions, onside kicks and return touchdowns on kicks aren't modelled.
- Receiver yardage samples are small early in the season and get shrunk toward the team average.
- Lines refresh once a day (around 6–7am ET). Click "Run workflow" in the Actions tab to refresh them on demand, which costs credits.

## Data and credits

Play-by-play, rosters, injury reports and the player directory come from [nflverse](https://github.com/nflverse/nflverse-data) (CC BY 4.0). The schedule and closing lines come from [nflverse/nfldata](https://github.com/nflverse/nfldata). This project isn't affiliated with the NFL. It's for entertainment and research.
