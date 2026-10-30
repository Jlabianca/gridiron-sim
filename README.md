# Gridiron Sim

A play-by-play NFL game simulator that runs in the browser. Pick a matchup and you can:

https://jlabianca.github.io/gridiron-sim/

- **Watch a sim**: an animated, drive-by-drive replay of one simulated game, with a scoreboard, field view, line score and final box score. Every game comes from a seed, and *Copy link* shares that exact game (for example `#CAR@GB/42`).
- **Projections & props**: re-run the game 1,000–20,000 times to get win probability, fair moneylines, cover and over/under odds against the market line, the margin and total distributions, and per-player prop distributions. Type in a sportsbook line and it shows the model's over/under probability and fair odds.
- **Injuries / usage**: toggle players in or out. Players listed Out or Doubtful on the injury report, or not on the active roster, start out. Their carries and targets are re-split among the remaining players.

The site is fully static: one JSON model file and plain JavaScript, with no server. It's hosted on GitHub Pages, and a scheduled GitHub Action rebuilds the model from fresh nflverse data every day.

## How the model works

`scripts/build_data.py` reads nflverse play-by-play, weekly rosters, injury reports and the schedule (with closing lines), then writes `site/data/model.json`:

- **Team rates (offense and defense)**: sack, scramble, interception and completion rates, yards per completion and per carry, and pass rate over expected (by down, distance and game script). Rates are recency-weighted (half-life of 4 games), the prior season counts at a small weight, and everything is shrunk toward league average.
- **Matchups**: offense and defense rates are combined with log5, and yards are scaled by the defense's yards allowed. Home teams get about 1.5 points of edge.
- **Players**: carry and target shares come from recent games (half-life of 3 games), with separate red-zone and goal-line shares. Each player has a catch rate and their own yardage samples, so a deep threat and a check-down back produce different stat lines.
- **Situations**: league tables cover 4th-down go/punt/FG decisions, field-goal make rate by distance, kickoff and punt field position, penalties, field-zone yardage near the goal line, the clock (normal pace, hurry-up, milking the clock), kneel-downs, timeouts and overtime.

`site/js/sim.js` plays the game one snap at a time from those tables. `scripts/calibrate.js` then adjusts two global constants so the simulated league matches the real season's plays per game and points per game.

### Backtest (2026 weeks 5–7, 43 games, each week using only data available before it)

| | Model | Closing market |
|---|---|---|
| Margin error (MAE) | 9.35 | 9.07 |
| Total error (MAE) | 10.80 | 10.34 |
| Mean total | 46.0 | 45.1 (actual 45.8) |

The model's margins correlate 0.71 with the closing spreads. Its rushing-yard projections correlate 0.69 with actual results, receiving yards 0.42 and passing yards 0.30. **Bottom line: it's sensible, but it doesn't beat the closing line.** Treat a gap between the model and the market as a reason to dig in, not as a bet. To rerun the backtest:

```bash
for w in 5 6 7; do python scripts/build_data.py --week $w --out backtest/model_w$w.json; node scripts/calibrate.js backtest/model_w$w.json; done
python scripts/export_actuals.py --season 2026 --weeks 5 6 7
node scripts/backtest.js 5 6 7
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

## Known limitations / ideas

- No weather, rest days, coaching changes or QB-specific adjustments beyond the team's recent dropbacks.
- Two-point conversions, onside kicks and return touchdowns on kicks aren't modelled.
- Receiver yardage samples are small early in the season and get shrunk toward the team average.
- Ideas: pulling live prop lines from an odds API, a per-week comparison table of model vs. market, and tracking the model's results over the season.

## Data and credits

Play-by-play, rosters, injury reports and the player directory come from [nflverse](https://github.com/nflverse/nflverse-data) (CC BY 4.0). The schedule and closing lines come from [nflverse/nfldata](https://github.com/nflverse/nfldata). This project isn't affiliated with the NFL. It's for entertainment and research.
