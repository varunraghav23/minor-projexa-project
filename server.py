"""
Projexa — IoT Smart Environmental Monitoring System
server.py  |  Live Weather API Edition

K.R. Mangalam University · Team 26E1153 · Jan 2026

---------------------------------------------------------
PURPOSE
---------------------------------------------------------
This Python backend fetches live data from two free
OpenWeatherMap (OWM) endpoints every 60 seconds:

  Current Weather  → temperature, humidity, pressure,
                     wind speed, visibility, conditions
  Air Pollution    → PM2.5, CO, NO2, O3, PM10, AQI index

It stores a rolling history and exposes a local REST API
that the frontend dashboard consumes.

Use this server.py when you want a Python backend for:
  - Logging data to a CSV / database
  - Running threshold checks server-side
  - Sending email / SMS alerts (add SMTP below)
  - Deploying on a Raspberry Pi or cloud VM

If you just want the browser dashboard without a backend,
open index.html directly — it calls OWM directly from JS.

---------------------------------------------------------
QUICK START
---------------------------------------------------------
  pip install flask flask-cors requests

  # Set your credentials:
  export OWM_API_KEY="your_key_here"
  export OWM_CITY="Gurugram"          # or any city name

  python server.py

  API available at http://localhost:5000
  Open index.html (no changes needed — it auto-detects mode)

---------------------------------------------------------
OWM FREE API ENDPOINTS USED
---------------------------------------------------------
  Weather:  api.openweathermap.org/data/2.5/weather
  Air:      api.openweathermap.org/data/2.5/air_pollution
  Geo:      api.openweathermap.org/geo/1.0/direct

  Free tier: 1000 calls/day, no credit card needed
  Sign up:   https://home.openweathermap.org/users/sign_up
---------------------------------------------------------
"""

import os
import time
import threading
import logging
import json
import requests
from datetime import datetime, timezone
from dataclasses import dataclass, asdict, field
from typing import Optional, Dict, List

try:
    from flask import Flask, jsonify, request
    from flask_cors import CORS
    FLASK_AVAILABLE = True
except ImportError:
    FLASK_AVAILABLE = False
    print("[WARN] Flask not installed. Run:  pip install flask flask-cors requests")


# ===========================================================================
# CONFIGURATION
# ===========================================================================

class Config:
    # ── Server ────────────────────────────────────────────────────────────
    HOST  = "0.0.0.0"
    PORT  = 5000
    DEBUG = True

    # ── OpenWeatherMap ─────────────────────────────────────────────────────
    OWM_API_KEY = os.getenv("OWM_API_KEY", "")          # Set via env var
    OWM_CITY    = os.getenv("OWM_CITY", "Gurugram")     # Default city
    OWM_UNITS   = "metric"                               # celsius

    OWM_WEATHER_URL = "https://api.openweathermap.org/data/2.5/weather"
    OWM_AIR_URL     = "https://api.openweathermap.org/data/2.5/air_pollution"
    OWM_GEO_URL     = "https://api.openweathermap.org/geo/1.0/direct"

    # ── Fetch interval ──────────────────────────────────────────────────────
    FETCH_INTERVAL_SEC = 60          # OWM free tier: 1000 calls/day = 1 per 86s
    HISTORY_MAX_POINTS = 300

    # ── Alert thresholds ────────────────────────────────────────────────────
    THRESHOLDS = {
        "temp": {"warn": 35.0,    "danger": 40.0  },
        "hum":  {"warn": 70.0,    "danger": 90.0  },
        "pm25": {"warn": 25.0,    "danger": 75.0  },   # WHO guideline
        "co":   {"warn": 4000.0,  "danger": 9400.0},   # µg/m³ 8h WHO limit
    }


# ===========================================================================
# DATA MODELS
# ===========================================================================

@dataclass
class WeatherSnapshot:
    """One complete reading from both OWM endpoints."""
    timestamp:   str
    city:        str
    country:     str
    lat:         float
    lon:         float

    # Weather
    temp:         float
    feels_like:   float
    humidity:     int
    pressure:     int
    wind_speed:   float
    wind_deg:     int
    visibility:   float        # km
    weather_main: str
    weather_desc: str
    weather_icon: str

    # Air Pollution
    aqi_index:   int            # OWM 1-5 scale
    pm2_5:       float
    pm10:        float
    co:          float          # µg/m³
    no2:         float
    o3:          float
    so2:         float
    nh3:         float

    # Derived
    temp_status:  str = "normal"
    hum_status:   str = "normal"
    pm25_status:  str = "normal"
    co_status:    str = "normal"
    alerts:       list = field(default_factory=list)


# ===========================================================================
# OWM FETCHER
# ===========================================================================

class OWMFetcher:
    """Fetches and parses data from OpenWeatherMap's free APIs."""

    def __init__(self, api_key: str, city: str):
        self.api_key  = api_key
        self.city     = city
        self._lat: Optional[float] = None
        self._lon: Optional[float] = None
        self._log = logging.getLogger("OWMFetcher")

    # ── Geocoding ─────────────────────────────────────────────────────────

    def geocode(self) -> tuple:
        """Resolve city name to lat/lon. Called once on startup."""
        url = (f"{Config.OWM_GEO_URL}"
               f"?q={requests.utils.quote(self.city)}&limit=1&appid={self.api_key}")
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        data = r.json()
        if not data:
            raise ValueError(f"City not found: {self.city!r}")
        self._lat = data[0]["lat"]
        self._lon = data[0]["lon"]
        self._log.info("Geocoded %r → lat=%.4f lon=%.4f", self.city, self._lat, self._lon)
        return self._lat, self._lon

    # ── Single fetch ──────────────────────────────────────────────────────

    def fetch(self) -> WeatherSnapshot:
        """Fetch current weather + air pollution, return a WeatherSnapshot."""
        if self._lat is None:
            self.geocode()

        # Parallel requests (sequential here for simplicity)
        w_url = (f"{Config.OWM_WEATHER_URL}"
                 f"?lat={self._lat}&lon={self._lon}"
                 f"&units={Config.OWM_UNITS}&appid={self.api_key}")
        a_url = (f"{Config.OWM_AIR_URL}"
                 f"?lat={self._lat}&lon={self._lon}&appid={self.api_key}")

        w_res = requests.get(w_url, timeout=10)
        w_res.raise_for_status()
        w = w_res.json()

        a_res = requests.get(a_url, timeout=10)
        a_res.raise_for_status()
        a = a_res.json()

        comp      = a["list"][0]["components"]
        aqi_index = a["list"][0]["main"]["aqi"]

        snap = WeatherSnapshot(
            timestamp    = datetime.now(timezone.utc).isoformat(),
            city         = w.get("name", self.city),
            country      = w.get("sys", {}).get("country", ""),
            lat          = self._lat,
            lon          = self._lon,
            temp         = w["main"]["temp"],
            feels_like   = w["main"]["feels_like"],
            humidity     = w["main"]["humidity"],
            pressure     = w["main"]["pressure"],
            wind_speed   = w.get("wind", {}).get("speed", 0),
            wind_deg     = w.get("wind", {}).get("deg", 0),
            visibility   = round(w.get("visibility", 0) / 1000, 2),
            weather_main = w["weather"][0]["main"],
            weather_desc = w["weather"][0]["description"],
            weather_icon = w["weather"][0]["icon"],
            aqi_index    = aqi_index,
            pm2_5        = comp.get("pm2_5",  0.0),
            pm10         = comp.get("pm10",   0.0),
            co           = comp.get("co",     0.0),
            no2          = comp.get("no2",    0.0),
            o3           = comp.get("o3",     0.0),
            so2          = comp.get("so2",    0.0),
            nh3          = comp.get("nh3",    0.0),
        )

        # Classify statuses and collect alerts
        snap.temp_status, temp_alert = self._classify("temp", snap.temp)
        snap.hum_status,  hum_alert  = self._classify("hum",  snap.humidity)
        snap.pm25_status, pm25_alert = self._classify("pm25", snap.pm2_5)
        snap.co_status,   co_alert   = self._classify("co",   snap.co)

        snap.alerts = [a for a in [temp_alert, hum_alert, pm25_alert, co_alert] if a]
        return snap

    @staticmethod
    def _classify(key: str, value: float) -> tuple:
        t = Config.THRESHOLDS.get(key, {"warn": 9999, "danger": 99999})
        if value >= t["danger"]:
            return "danger", f"{key.upper()} CRITICAL: {value:.1f}"
        if value >= t["warn"]:
            return "warn",   f"{key.upper()} warning: {value:.1f}"
        return "normal", None


# ===========================================================================
# DATA STORE
# ===========================================================================

class DataStore:
    def __init__(self):
        self._snapshots: List[WeatherSnapshot] = []
        self._lock = threading.Lock()
        self.alert_count   = 0
        self.fetch_count   = 0
        self.last_error: Optional[str] = None

    def add(self, snap: WeatherSnapshot):
        with self._lock:
            self._snapshots.append(snap)
            if len(self._snapshots) > Config.HISTORY_MAX_POINTS:
                self._snapshots.pop(0)
            self.alert_count += len(snap.alerts)
            self.fetch_count += 1
            self.last_error   = None

    def latest(self) -> Optional[dict]:
        with self._lock:
            return asdict(self._snapshots[-1]) if self._snapshots else None

    def history(self, n: int = 30) -> list:
        with self._lock:
            return [asdict(s) for s in self._snapshots[-n:]]

    def set_error(self, msg: str):
        with self._lock:
            self.last_error = msg


# ===========================================================================
# BACKGROUND FETCH LOOP
# ===========================================================================

store:   DataStore  = DataStore()
fetcher: OWMFetcher = None  # Initialised in main

log = logging.getLogger("projexa")


def _fetch_loop():
    """Runs in a daemon thread — fetches OWM data every FETCH_INTERVAL_SEC."""
    log.info("Fetch loop started — interval: %ds", Config.FETCH_INTERVAL_SEC)

    while True:
        try:
            snap = fetcher.fetch()
            store.add(snap)

            log.info(
                "%s | T:%.1f°C  H:%d%%  PM2.5:%.1f  CO:%.0f  AQI:%d",
                snap.city, snap.temp, snap.humidity,
                snap.pm2_5, snap.co, snap.aqi_index,
            )

            for alert in snap.alerts:
                log.warning("ALERT — %s", alert)

        except requests.exceptions.HTTPError as e:
            msg = f"HTTP {e.response.status_code}: {e.response.text[:200]}"
            log.error("OWM HTTP error: %s", msg)
            store.set_error(msg)

        except Exception as e:
            log.error("Fetch failed: %s", e)
            store.set_error(str(e))

        time.sleep(Config.FETCH_INTERVAL_SEC)


# ===========================================================================
# FLASK REST API
# ===========================================================================

def create_app() -> "Flask":
    app = Flask(__name__)
    CORS(app)

    @app.route("/")
    def index():
        return jsonify({
            "project":   "Projexa IoT Environmental Monitoring",
            "edition":   "Live Weather API",
            "team":      "26E1153",
            "version":   "3.0.0",
            "city":      Config.OWM_CITY,
            "source":    "OpenWeatherMap",
            "endpoints": [
                "GET /api/current    — latest snapshot",
                "GET /api/history    — last N snapshots (?n=30)",
                "GET /api/status     — system health",
                "POST /api/city      — change city {\"city\":\"Mumbai\"}",
            ],
        })

    @app.route("/api/current")
    def api_current():
        """Latest full weather + air quality snapshot."""
        data = store.latest()
        if not data:
            return jsonify({"error": "No data yet — still fetching"}), 503
        return jsonify(data)

    @app.route("/api/history")
    def api_history():
        """Rolling history of snapshots. Query param: ?n=30"""
        try:
            n = min(int(request.args.get("n", 30)), Config.HISTORY_MAX_POINTS)
        except ValueError:
            n = 30
        return jsonify(store.history(n))

    @app.route("/api/status")
    def api_status():
        """System health endpoint."""
        return jsonify({
            "online":       True,
            "version":      "3.0.0",
            "city":         Config.OWM_CITY,
            "fetch_count":  store.fetch_count,
            "alert_count":  store.alert_count,
            "last_error":   store.last_error,
            "fetch_interval_sec": Config.FETCH_INTERVAL_SEC,
            "timestamp":    datetime.now(timezone.utc).isoformat(),
        })

    @app.route("/api/city", methods=["POST"])
    def api_city():
        """
        Switch to a different city without restarting the server.
        Body: { "city": "Mumbai" }
        """
        body = request.get_json(silent=True) or {}
        city = body.get("city", "").strip()
        if not city:
            return jsonify({"error": "Provide {\"city\": \"CityName\"}"}), 400

        Config.OWM_CITY  = city
        fetcher.city     = city
        fetcher._lat     = None   # force re-geocode
        fetcher._lon     = None
        log.info("City changed to: %s", city)
        return jsonify({"ok": True, "city": city})

    return app


# ===========================================================================
# CSV LOGGING (optional — uncomment to save data)
# ===========================================================================

# import csv, pathlib
#
# CSV_FILE = pathlib.Path("projexa_log.csv")
#
# def log_to_csv(snap: WeatherSnapshot):
#     write_header = not CSV_FILE.exists()
#     with open(CSV_FILE, "a", newline="") as f:
#         w = csv.DictWriter(f, fieldnames=asdict(snap).keys())
#         if write_header: w.writeheader()
#         w.writerow(asdict(snap))


# ===========================================================================
# ENTRY POINT
# ===========================================================================

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    api_key = Config.OWM_API_KEY
    if not api_key:
        print("\n[ERROR] OpenWeatherMap API key not set!")
        print("        Set it as an environment variable:")
        print("          export OWM_API_KEY='your_key_here'")
        print("        or edit Config.OWM_API_KEY directly in this file.\n")
        exit(1)

    fetcher = OWMFetcher(api_key=api_key, city=Config.OWM_CITY)

    # Geocode once on startup so we fail early if city is wrong
    try:
        lat, lon = fetcher.geocode()
    except Exception as e:
        print(f"\n[ERROR] Geocoding failed for '{Config.OWM_CITY}': {e}\n")
        exit(1)

    # First fetch before starting the loop
    try:
        first = fetcher.fetch()
        store.add(first)
        print(f"[OK] First fetch: {first.city}, {first.country} — T:{first.temp}°C  AQI:{first.aqi_index}")
    except Exception as e:
        print(f"[WARN] First fetch failed: {e} — will retry in background")

    # Start background fetch thread
    threading.Thread(target=_fetch_loop, daemon=True).start()

    if FLASK_AVAILABLE:
        app = create_app()

        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
        except Exception:
            local_ip = "127.0.0.1"

        print("\n" + "=" * 56)
        print("  Projexa Server v3 — Live Weather API Edition")
        print("=" * 56)
        print(f"  API running at  : http://localhost:{Config.PORT}")
        print(f"  Local IP        : {local_ip}")
        print(f"  City            : {Config.OWM_CITY}")
        print(f"  Refresh rate    : every {Config.FETCH_INTERVAL_SEC}s")
        print(f"  Endpoints:")
        print(f"    GET  /api/current")
        print(f"    GET  /api/history?n=30")
        print(f"    GET  /api/status")
        print(f"    POST /api/city  body: {{\"city\":\"Mumbai\"}}")
        print("=" * 56 + "\n")

        app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG, use_reloader=False)
    else:
        print("[INFO] Running in headless mode — no Flask, just logging to console.")
        print("[INFO] Install Flask for the API:  pip install flask flask-cors requests")
        try:
            while True:
                time.sleep(Config.FETCH_INTERVAL_SEC)
        except KeyboardInterrupt:
            print("\nStopped.")
