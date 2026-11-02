"""Stadium info and game-day weather (Open-Meteo forecast, free, no API key).

Used by build_data.py. Domes and retractable roofs are treated as indoor (teams close the
roof in bad weather), so only open-air stadiums get a forecast.
"""
import json
import urllib.parse
import urllib.request

# stadium_id -> (lat, lon, roof)   roof: outdoor | dome | retractable
STADIUMS = {
    "ATL97": (33.7554, -84.4008, "retractable"), "BAL00": (39.2780, -76.6227, "outdoor"),
    "BOS00": (42.0909, -71.2643, "outdoor"), "BUF00": (42.7738, -78.7870, "outdoor"),
    "BUF01": (42.8640, -78.7880, "outdoor"),  # new Highmark Stadium (Orchard Park)
    "CAR00": (35.2258, -80.8528, "outdoor"), "CHI98": (41.8623, -87.6167, "outdoor"),
    "CIN00": (39.0955, -84.5161, "outdoor"), "CLE00": (41.5061, -81.6995, "outdoor"),
    "DAL00": (32.7473, -97.0945, "retractable"), "DEN00": (39.7439, -105.0201, "outdoor"),
    "DET00": (42.3400, -83.0456, "dome"), "GNB00": (44.5013, -88.0622, "outdoor"),
    "HOU00": (29.6847, -95.4107, "retractable"), "IND00": (39.7601, -86.1639, "retractable"),
    "JAX00": (30.3239, -81.6373, "outdoor"), "KAN00": (39.0489, -94.4839, "outdoor"),
    "LAX01": (33.9535, -118.3392, "dome"), "MIA00": (25.9580, -80.2389, "outdoor"),
    "MIN01": (44.9737, -93.2577, "dome"), "NAS00": (36.1665, -86.7713, "outdoor"),
    "NOR00": (29.9511, -90.0812, "dome"), "NYC01": (40.8135, -74.0745, "outdoor"),
    "PHI00": (39.9008, -75.1675, "outdoor"), "PHO00": (33.5276, -112.2626, "retractable"),
    "PIT00": (40.4468, -80.0158, "outdoor"), "SEA00": (47.5952, -122.3316, "outdoor"),
    "SFO01": (37.4030, -121.9700, "outdoor"), "TAM00": (27.9759, -82.5033, "outdoor"),
    "VEG00": (36.0909, -115.1833, "dome"), "WAS00": (38.9076, -76.8645, "outdoor"),
    # international / neutral sites
    "LON00": (51.5560, -0.2796, "outdoor"), "LON02": (51.6043, -0.0664, "outdoor"),
    "MEX00": (19.3029, -99.1505, "outdoor"), "MAD01": (40.4531, -3.6883, "retractable"),
    "MUN01": (48.2188, 11.6247, "outdoor"), "PAR00": (48.9244, 2.3601, "outdoor"),
    "MEL00": (-37.8200, 144.9834, "outdoor"), "RIO00": (-22.9121, -43.2302, "outdoor"),
    "SAO00": (-23.5455, -46.4742, "outdoor"), "DUB00": (53.3351, -6.2286, "outdoor"),
    "BER00": (52.5147, 13.2395, "outdoor"), "FRA00": (50.0686, 8.6455, "outdoor"),
}
ROOF_FROM_NFLVERSE = {"dome": "dome", "closed": "retractable", "open": "retractable", "outdoors": "outdoor"}


def roof_for(stadium_id, nflverse_roof):
    if stadium_id in STADIUMS:
        return STADIUMS[stadium_id][2]
    return ROOF_FROM_NFLVERSE.get(nflverse_roof, "outdoor")


def features(temp_f, wind_mph, rain, snow, indoor):
    """Same feature definitions as scripts/fit_weather.py."""
    if indoor:
        return {"wind": 0.0, "cold": 0.0, "rain": 0.0, "snow": 0.0}
    return {
        "wind": round(max(0.0, min(30.0, (wind_mph if wind_mph is not None else 8) - 10)), 2),
        "cold": round(max(0.0, min(45.0, 40 - (temp_f if temp_f is not None else 60))), 2),
        "rain": round(rain or 0.0, 3),
        "snow": round(snow or 0.0, 3),
    }


def forecast(lat, lon, date, kickoff_hour, timeout=20):
    """Average conditions over the ~3 hours of the game. Returns dict or None."""
    q = urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "start_date": date, "end_date": date,
        "hourly": "temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation,snowfall",
        "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "precipitation_unit": "inch",
        "timezone": "America/New_York",
    })
    with urllib.request.urlopen("https://api.open-meteo.com/v1/forecast?" + q, timeout=timeout) as r:
        h = json.load(r)["hourly"]
    hours = [i for i, t in enumerate(h["time"]) if kickoff_hour <= int(t[11:13]) <= kickoff_hour + 3]
    if not hours:
        return None
    avg = lambda k: sum((h[k][i] or 0) for i in hours) / len(hours)
    temp, wind = avg("temperature_2m"), avg("wind_speed_10m")
    pprob = avg("precipitation_probability") / 100.0
    precip, snow = avg("precipitation"), avg("snowfall")
    wet = pprob if precip > 0.005 or pprob >= 0.5 else pprob * 0.5
    is_snow = snow > 0 or (temp <= 33 and precip > 0)
    return {"temp": round(temp), "wind": round(wind), "gusts": round(avg("wind_gusts_10m")),
            "precip_prob": round(pprob * 100), "rain": 0.0 if is_snow else round(wet, 2),
            "snow": round(wet, 2) if is_snow else 0.0}
