"""
Projexa — IoT Smart Environmental Monitoring System
server.py  (v2 — Real Hardware Support)

K.R. Mangalam University · Team 26E1153 · Jan 2026

---------------------------------------------------------
WHAT'S NEW IN v2
---------------------------------------------------------
  POST /api/sensors/ingest  <- ESP32 pushes real data here
  GET  /api/sensors/current <- Frontend reads latest values
  GET  /api/sensors/history <- Frontend reads history chart
  GET  /api/status          <- System health
  POST /api/alerts/trigger  <- Manual alert from browser

  MODE SWITCHING (automatic):
    - If no real data received for >10s  -> simulation mode
    - As soon as ESP32 POSTs             -> real data mode
    - Browser dashboard works the same in both modes

---------------------------------------------------------
QUICK START
---------------------------------------------------------
  pip install flask flask-cors

  # Start the server (keep this terminal open)
  python server.py

  Then open index.html in your browser.
  Flash firmware.ino to your ESP32 with your Wi-Fi details
  and this PC's local IP set as SERVER_IP.
---------------------------------------------------------
"""

import random
import time
import threading
import logging
import socket
from datetime import datetime, timezone
from dataclasses import dataclass, asdict
from typing import Optional

try:
    from flask import Flask, jsonify, request
    from flask_cors import CORS
    FLASK_AVAILABLE = True
except ImportError:
    FLASK_AVAILABLE = False
    print("[WARN] Flask not installed. Run:  pip install flask flask-cors")


# ===========================================================================
# CONFIGURATION
# ===========================================================================

class Config:
    HOST  = "0.0.0.0"
    PORT  = 5000
    DEBUG = True

    REAL_DATA_TIMEOUT_SEC = 10.0
    SIM_TICK_SECONDS      = 2.0
    HISTORY_MAX_POINTS    = 300

    THRESHOLDS = {
        "temp": {"warn": 35.0,  "danger": 40.0},
        "hum":  {"warn": 70.0,  "danger": 90.0},
        "aqi":  {"warn": 120.0, "danger": 200.0},
        "gas":  {"warn": 100.0, "danger": 200.0},
    }

    SENSOR_PARAMS = {
        "temp": {"base": 28.4, "variance": 0.8, "min": 10.0, "max": 50.0,  "unit": "C",   "name": "Temperature"},
        "hum":  {"base": 62.1, "variance": 2.0, "min": 0.0,  "max": 100.0, "unit": "% RH","name": "Humidity"},
        "aqi":  {"base": 87.0, "variance": 5.0, "min": 0.0,  "max": 300.0, "unit": "ppm", "name": "Air Quality"},
        "gas":  {"base": 42.0, "variance": 3.0, "min": 0.0,  "max": 300.0, "unit": "ppm", "name": "Gas Conc."},
    }


# ===========================================================================
# DATA MODEL
# ===========================================================================

@dataclass
class SensorReading:
    sensor_id:  str
    value:      float
    unit:       str
    timestamp:  str
    status:     str
    source:     str = "simulation"
    alert_msg:  Optional[str] = None


# ===========================================================================
# DATA STORE (thread-safe)
# ===========================================================================

class DataStore:
    def __init__(self):
        self._latest:              dict = {}
        self._history:             dict = {k: [] for k in Config.SENSOR_PARAMS}
        self._last_real_data_time: float = 0.0
        self._alert_count:         int = 0
        self._reading_count:       int = 0
        self._lock = threading.Lock()

    def ingest(self, key: str, value: float, source: str = "simulation") -> SensorReading:
        params = Config.SENSOR_PARAMS[key]
        ts     = datetime.now(timezone.utc).isoformat()
        status, alert = self._classify(key, value)

        reading = SensorReading(
            sensor_id = key,
            value     = round(value, 2),
            unit      = params["unit"],
            timestamp = ts,
            status    = status,
            source    = source,
            alert_msg = alert,
        )

        with self._lock:
            self._latest[key] = reading
            self._history[key].append(reading)
            if len(self._history[key]) > Config.HISTORY_MAX_POINTS:
                self._history[key].pop(0)
            self._reading_count += 1
            if alert:
                self._alert_count += 1
            if source == "esp32":
                self._last_real_data_time = time.monotonic()

        return reading

    def get_current(self) -> dict:
        with self._lock:
            return {k: asdict(v) for k, v in self._latest.items()}

    def get_history(self, n: int = 30) -> dict:
        with self._lock:
            return {k: [asdict(r) for r in v[-n:]] for k, v in self._history.items()}

    def is_receiving_real_data(self) -> bool:
        elapsed = time.monotonic() - self._last_real_data_time
        return self._last_real_data_time > 0 and elapsed < Config.REAL_DATA_TIMEOUT_SEC

    def get_stats(self) -> dict:
        return {"reading_count": self._reading_count, "alert_count": self._alert_count}

    @staticmethod
    def _classify(key: str, value: float):
        t = Config.THRESHOLDS[key]
        n = Config.SENSOR_PARAMS[key]["name"]
        u = Config.SENSOR_PARAMS[key]["unit"]
        if value >= t["danger"]:
            return "danger", f"{n} CRITICAL: {value:.1f} {u}"
        if value >= t["warn"]:
            return "warn", f"{n} above warning: {value:.1f} {u}"
        return "normal", None


# ===========================================================================
# SENSOR SIMULATOR
# ===========================================================================

class SensorSimulator:
    def __init__(self, store: DataStore):
        self._store  = store
        self._values = {k: v["base"] for k, v in Config.SENSOR_PARAMS.items()}

    def tick(self):
        if self._store.is_receiving_real_data():
            return
        for key, params in Config.SENSOR_PARAMS.items():
            v = self._values[key]
            v += random.gauss(0, params["variance"])
            v  = max(params["min"], min(params["max"], v))
            self._values[key] = v
            self._store.ingest(key, v, source="simulation")

    def spike(self, key: str, value: float):
        self._values[key] = value


# ===========================================================================
# GLOBAL INSTANCES
# ===========================================================================

store     = DataStore()
simulator = SensorSimulator(store)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("projexa")


def _simulation_loop():
    while True:
        simulator.tick()
        time.sleep(Config.SIM_TICK_SECONDS)


# ===========================================================================
# FLASK APP
# ===========================================================================

def create_app():
    app = Flask(__name__)
    CORS(app)

    @app.route("/")
    def index():
        mode = "esp32" if store.is_receiving_real_data() else "simulation"
        return jsonify({
            "project": "Projexa IoT Environmental Monitoring",
            "team":    "26E1153",
            "version": "2.0.0",
            "mode":    mode,
        })

    @app.route("/api/sensors/ingest", methods=["POST"])
    def sensors_ingest():
        """
        ESP32 firmware POSTs JSON here every 2 seconds.
        Body: { "temp": "28.4", "hum": "62.1", "aqi": "87", "gas": "42", ... }
        """
        body = request.get_json(silent=True)
        if not body:
            return jsonify({"error": "Invalid or missing JSON"}), 400

        results = {}
        for key in ["temp", "hum", "aqi", "gas"]:
            if key not in body:
                return jsonify({"error": f"Missing field: {key}"}), 400
            try:
                value = float(body[key])
            except (ValueError, TypeError):
                return jsonify({"error": f"Non-numeric value for {key}"}), 400
            results[key] = asdict(store.ingest(key, value, source="esp32"))

        log.info(
            "ESP32 -> T:%.1fC  H:%.1f%%  AQI:%.0fppm  Gas:%.0fppm",
            float(body["temp"]), float(body["hum"]),
            float(body["aqi"]),  float(body["gas"]),
        )
        return jsonify({"ok": True, "readings": results})

    @app.route("/api/sensors/current")
    def sensors_current():
        data = store.get_current()
        data["_meta"] = {
            "mode":      "esp32" if store.is_receiving_real_data() else "simulation",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        return jsonify(data)

    @app.route("/api/sensors/history")
    def sensors_history():
        try:
            n = min(int(request.args.get("n", 30)), Config.HISTORY_MAX_POINTS)
        except ValueError:
            n = 30
        return jsonify(store.get_history(n))

    @app.route("/api/alerts/trigger", methods=["POST"])
    def alerts_trigger():
        body   = request.get_json(silent=True) or {}
        sensor = body.get("sensor", "gas")
        value  = float(body.get("value", 220))
        if sensor not in Config.SENSOR_PARAMS:
            return jsonify({"error": f"Unknown sensor: {sensor}"}), 400
        simulator.spike(sensor, value)
        return jsonify({"ok": True, "spiked": {sensor: value}})

    @app.route("/api/status")
    def system_status():
        return jsonify({
            "online":    True,
            "mode":      "esp32" if store.is_receiving_real_data() else "simulation",
            "version":   "2.0.0",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **store.get_stats(),
        })

    return app


# ===========================================================================
# ENTRY POINT
# ===========================================================================

if __name__ == "__main__":
    # Seed initial data
    for key, params in Config.SENSOR_PARAMS.items():
        store.ingest(key, params["base"], source="simulation")

    # Background simulation thread
    threading.Thread(target=_simulation_loop, daemon=True).start()

    if FLASK_AVAILABLE:
        app = create_app()

        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
        except Exception:
            local_ip = "127.0.0.1"

        print("\n" + "=" * 54)
        print("  Projexa Server v2 - Real Hardware + Simulation")
        print("=" * 54)
        print(f"  Dashboard API  : http://localhost:{Config.PORT}")
        print(f"  Your local IP  : {local_ip}")
        print(f"\n  In firmware.ino set:")
        print(f'    const char* SERVER_IP = "{local_ip}";')
        print(f"\n  Waiting for ESP32 on POST /api/sensors/ingest")
        print(f"  Using simulation until ESP32 connects...")
        print("=" * 54 + "\n")

        app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG, use_reloader=False)
    else:
        print("[ERROR] Install Flask:  pip install flask flask-cors")
