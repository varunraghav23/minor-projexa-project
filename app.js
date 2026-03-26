/**
 * Projexa — IoT Smart Environmental Monitoring System
 * app.js  |  Dashboard logic: chart, sensor simulation, alerts
 * K.R. Mangalam University · Team 26E1153 · Jan 2026
 *
 * In a real deployment this file would:
 *  - Connect to Firebase Realtime DB / ThingSpeak REST API
 *  - Subscribe to MQTT broker for live ESP32 sensor pushes
 *  - Send alert emails / push notifications via cloud functions
 * For the demo, sensor values are simulated with random walks.
 */

'use strict';

/* ============================================================
   CONSTANTS & CONFIGURATION
   ============================================================ */

const CONFIG = {
  UPDATE_INTERVAL_MS: 2000,   // How often to refresh sensor readings
  HISTORY_POINTS: 30,         // Data points shown on chart
  HISTORY_WINDOW_MIN: 60,     // Minutes represented in the chart
  ALERT_TOAST_DURATION: 4000, // Toast visible for 4 seconds
};

/** Sensor definitions: id, DOM ids, base value, random-walk variance,
 *  physical range, warning & danger thresholds, and status labels. */
const SENSOR_CONFIG = {
  temp: {
    el: 'tempVal', bar: 'tempBar', status: 'tempStatus',
    base: 28.4, variance: 1.2,
    range: [10, 50],
    thresholds: { warn: 35, danger: 40 },
    labels: ['Normal Range', 'High Temp', 'CRITICAL HEAT'],
    decimals: 1,
  },
  hum: {
    el: 'humVal', bar: 'humBar', status: 'humStatus',
    base: 62.1, variance: 3,
    range: [0, 100],
    thresholds: { warn: 70, danger: 90 },
    labels: ['Comfortable', 'High Humidity', 'CRITICAL HUMIDITY'],
    decimals: 1,
  },
  aqi: {
    el: 'aqiVal', bar: 'aqiBar', status: 'aqiStatus',
    base: 87, variance: 8,
    range: [0, 300],
    thresholds: { warn: 120, danger: 200 },
    labels: ['Good', 'Moderate', 'POOR AIR QUALITY'],
    decimals: 0,
  },
  gas: {
    el: 'gasVal', bar: 'gasBar', status: 'gasStatus',
    base: 42, variance: 5,
    range: [0, 300],
    thresholds: { warn: 100, danger: 200 },
    labels: ['Safe Level', 'Caution', 'DANGER GAS LEVEL'],
    decimals: 0,
  },
};

/** Chart accent colours per sensor key */
const CHART_COLORS = {
  temp: '#ff6b35',
  hum:  '#7c6fe0',
  aqi:  '#00ffd4',
  gas:  '#ffce3e',
};

/** Alert scenarios cycled on "Simulate Alert" clicks */
const ALERT_SCENARIOS = [
  { icon: '🚨', type: 'danger', msg: 'Gas concentration exceeded safe threshold!',       sensor: 'Sensor #01' },
  { icon: '⚠️', type: 'warn',   msg: 'Temperature above 35 °C — check ventilation',      sensor: 'Sensor #02' },
  { icon: '⚠️', type: 'warn',   msg: 'AQI rising — 148 ppm detected (Moderate)',          sensor: 'Sensor #02' },
  { icon: '🚨', type: 'danger', msg: 'CO₂ concentration dangerously high!',               sensor: 'Sensor #03' },
];

/* ============================================================
   STATE
   ============================================================ */

/** Current live readings (updated every CONFIG.UPDATE_INTERVAL_MS) */
const sensorState = {
  temp: 28.4,
  hum:  62.1,
  aqi:  87,
  gas:  42,
};

/** Circular history buffers for the chart (one per sensor) */
const chartData = {};

/** Chart.js instance and the currently displayed sensor key */
let chartInstance = null;
let activeChartKey = 'temp';

/** Alert counter for the badge */
let alertCount = 2;

/** Cycles through ALERT_SCENARIOS */
let alertScenarioIndex = 0;

/* ============================================================
   UTILITY HELPERS
   ============================================================ */

/**
 * Generates a random-walk series for a sensor's initial history.
 * @param {number} base     - Starting / centre value
 * @param {number} variance - Max step per tick
 * @param {number} n        - Number of data points
 * @returns {number[]}
 */
function generateSeries(base, variance, n = CONFIG.HISTORY_POINTS) {
  const arr = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v += (Math.random() - 0.5) * variance;
    v = Math.max(base - variance * 3, Math.min(base + variance * 3, v));
    arr.push(+v.toFixed(2));
  }
  return arr;
}

/**
 * Clamps a value between min and max.
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Returns chart time-axis labels: ["60m", "58m", … "2m", "now"]
 */
function buildTimeLabels() {
  return Array.from(
    { length: CONFIG.HISTORY_POINTS },
    (_, i) => i === CONFIG.HISTORY_POINTS - 1 ? 'now' : `${CONFIG.HISTORY_WINDOW_MIN - i * 2}m`
  ).reverse();
}

/* ============================================================
   CHART INITIALISATION
   ============================================================ */

/**
 * Builds (or rebuilds) the Chart.js line chart for the given sensor key.
 * Called on page load and whenever the user switches tabs.
 * @param {string} key - One of 'temp' | 'hum' | 'aqi' | 'gas'
 */
function buildChart(key) {
  const ctx = document.getElementById('envChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: buildTimeLabels(),
      datasets: [{
        data: chartData[key],
        borderColor: CHART_COLORS[key],
        backgroundColor: CHART_COLORS[key] + '18',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#181c24',
          borderColor: '#232736',
          borderWidth: 1,
          titleColor: '#6b7280',
          bodyColor: '#e8eaf2',
          titleFont: { family: 'Space Mono', size: 11 },
          bodyFont:  { family: 'Space Mono', size: 13 },
        },
      },
      scales: {
        x: {
          grid: { color: '#23273622' },
          ticks: { color: '#6b7280', font: { family: 'Space Mono', size: 10 }, maxTicksLimit: 8 },
        },
        y: {
          grid: { color: '#23273622' },
          ticks: { color: '#6b7280', font: { family: 'Space Mono', size: 10 } },
        },
      },
    },
  });
}

/**
 * Switches the active chart tab and re-renders the chart.
 * @param {string} key  - Sensor key to display
 * @param {HTMLElement} btn - The clicked tab button
 */
function switchChart(key, btn) {
  activeChartKey = key;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  buildChart(key);
}

/* ============================================================
   SENSOR UPDATE LOOP
   ============================================================ */

/**
 * Advances each sensor value one random-walk step, updates the DOM,
 * pushes new data to the chart buffer, and refreshes the chart.
 * Called by setInterval every CONFIG.UPDATE_INTERVAL_MS.
 */
function updateSensors() {
  const now = new Date();
  document.getElementById('lastUpdate').textContent =
    `Last update: ${now.toLocaleTimeString()}`;

  let anyWarn   = false;
  let anyDanger = false;

  Object.entries(SENSOR_CONFIG).forEach(([key, cfg]) => {
    /* ── random walk ── */
    let v = sensorState[key];
    v += (Math.random() - 0.48) * cfg.variance;
    v  = clamp(v, cfg.range[0], cfg.range[1]);
    sensorState[key] = v;

    /* ── DOM: value ── */
    document.getElementById(cfg.el).textContent =
      cfg.decimals > 0 ? v.toFixed(cfg.decimals) : Math.round(v);

    /* ── DOM: progress bar ── */
    const pct = ((v - cfg.range[0]) / (cfg.range[1] - cfg.range[0])) * 100;
    document.getElementById(cfg.bar).style.width = pct.toFixed(1) + '%';

    /* ── DOM: status label ── */
    const statusEl = document.getElementById(cfg.status);
    if (v >= cfg.thresholds.danger) {
      statusEl.className = 'sensor-status danger';
      statusEl.textContent = '⚠ ' + cfg.labels[2];
      anyDanger = true;
    } else if (v >= cfg.thresholds.warn) {
      statusEl.className = 'sensor-status warning';
      statusEl.textContent = '⚡ ' + cfg.labels[1];
      anyWarn = true;
    } else {
      statusEl.className = 'sensor-status normal';
      statusEl.textContent = '✓ ' + cfg.labels[0];
    }

    /* ── Chart buffer ── */
    chartData[key].shift();
    chartData[key].push(+v.toFixed(2));

    if (activeChartKey === key && chartInstance) {
      chartInstance.data.datasets[0].data = chartData[key];
      chartInstance.update('none');
    }
  });

  /* ── Status bar ── */
  updateStatusBar(anyDanger, anyWarn);
}

/**
 * Updates the global status indicator bar.
 */
function updateStatusBar(anyDanger, anyWarn) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');

  if (anyDanger) {
    dot.className = 'status-dot danger';
    txt.textContent = '⚠ HAZARDOUS CONDITIONS DETECTED — Immediate action required';
  } else if (anyWarn) {
    dot.className = 'status-dot warn';
    txt.textContent = '⚡ Warning threshold exceeded — Monitor closely';
  } else {
    dot.className = 'status-dot';
    txt.textContent = 'All systems normal — ESP32 connected via Wi-Fi';
  }
}

/* ============================================================
   ALERT SYSTEM
   ============================================================ */

/**
 * Simulates an incoming hazardous-condition alert:
 *  1. Shows a toast notification
 *  2. Prepends a new item to the alerts list
 *  3. Spikes gas / AQI to trigger threshold visuals
 */
function triggerAlert() {
  const scenario = ALERT_SCENARIOS[alertScenarioIndex % ALERT_SCENARIOS.length];
  alertScenarioIndex++;

  /* Toast */
  document.getElementById('toastMsg').textContent = scenario.msg;
  const toast = document.getElementById('alertToast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), CONFIG.ALERT_TOAST_DURATION);

  /* Badge counter */
  alertCount++;
  document.getElementById('alertCountBadge').textContent = alertCount;

  /* Prepend alert list item */
  const list = document.getElementById('alertsList');
  const item = document.createElement('div');
  item.className = 'alert-item';
  item.innerHTML = `
    <div class="alert-icon ${scenario.type}">${scenario.icon}</div>
    <div class="alert-text">
      <div class="alert-msg">${scenario.msg}</div>
      <div class="alert-time">just now · ${scenario.sensor}</div>
    </div>`;
  list.insertBefore(item, list.firstChild);

  /* Spike sensors to make thresholds fire visually */
  sensorState.gas = 220;
  sensorState.aqi = 185;
}

/**
 * Clears all alerts from the list and resets the counter.
 */
function clearAlerts() {
  alertCount = 0;
  document.getElementById('alertCountBadge').textContent = 0;
  document.getElementById('alertsList').innerHTML = `
    <div class="alert-item">
      <div class="alert-icon info">ℹ️</div>
      <div class="alert-text">
        <div class="alert-msg">No active alerts</div>
        <div class="alert-time">All readings within normal range</div>
      </div>
    </div>`;
}

/* ============================================================
   SCROLL REVEAL
   ============================================================ */

/**
 * Uses IntersectionObserver to fade-up elements with class "reveal"
 * as they enter the viewport.
 */
function initScrollReveal() {
  const observer = new IntersectionObserver(
    (entries) => entries.forEach(e => {
      if (e.isIntersecting) e.target.classList.add('visible');
    }),
    { threshold: 0.12 }
  );
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

/* ============================================================
   SERVER POLLING (optional — connects to server.py)
   When server.py is running, the dashboard shows REAL ESP32
   data instead of the JavaScript simulation.
   Set USE_SERVER = true and make sure server.py is running.
   ============================================================ */

const SERVER_URL = 'http://localhost:5000';  // Change if server is on another machine
const USE_SERVER = false;                    // Set true when server.py is running

/**
 * Fetch the latest readings from the Python server and update the DOM.
 * Falls back to JS simulation if the server is unreachable.
 */
async function fetchFromServer() {
  try {
    const res  = await fetch(`${SERVER_URL}/api/sensors/current`, { signal: AbortSignal.timeout(1800) });
    const data = await res.json();

    const keyMap = { temp: 'temp', hum: 'hum', aqi: 'aqi', gas: 'gas' };
    let anyWarn = false, anyDanger = false;

    Object.entries(keyMap).forEach(([key, serverKey]) => {
      const r   = data[serverKey];
      if (!r) return;

      const cfg = SENSOR_CONFIG[key];
      const v   = r.value;
      sensorState[key] = v;

      document.getElementById(cfg.el).textContent =
        cfg.decimals > 0 ? v.toFixed(cfg.decimals) : Math.round(v);

      const pct = ((v - cfg.range[0]) / (cfg.range[1] - cfg.range[0])) * 100;
      document.getElementById(cfg.bar).style.width = pct.toFixed(1) + '%';

      const statusEl = document.getElementById(cfg.status);
      if (r.status === 'danger') {
        statusEl.className = 'sensor-status danger';
        statusEl.textContent = '⚠ ' + cfg.labels[2];
        anyDanger = true;
      } else if (r.status === 'warn') {
        statusEl.className = 'sensor-status warning';
        statusEl.textContent = '⚡ ' + cfg.labels[1];
        anyWarn = true;
      } else {
        statusEl.className = 'sensor-status normal';
        statusEl.textContent = '✓ ' + cfg.labels[0];
      }

      chartData[key].shift();
      chartData[key].push(+v.toFixed(2));
      if (activeChartKey === key && chartInstance) {
        chartInstance.data.datasets[0].data = chartData[key];
        chartInstance.update('none');
      }
    });

    // Show source mode in status bar
    const mode = data._meta?.mode || 'unknown';
    const dot  = document.getElementById('statusDot');
    const txt  = document.getElementById('statusText');
    if (anyDanger) {
      dot.className = 'status-dot danger';
      txt.textContent = '[REAL DATA] HAZARDOUS CONDITIONS DETECTED';
    } else if (anyWarn) {
      dot.className = 'status-dot warn';
      txt.textContent = `[${mode.toUpperCase()}] Warning threshold exceeded`;
    } else {
      dot.className = 'status-dot';
      txt.textContent = mode === 'esp32'
        ? 'ESP32 connected — live sensor readings'
        : 'Simulation mode — connect ESP32 for real data';
    }

    document.getElementById('lastUpdate').textContent =
      `Last update: ${new Date().toLocaleTimeString()} [${mode}]`;

  } catch (err) {
    // Server unreachable — fall back to JS simulation silently
    updateSensors();
  }
}

/* ============================================================
   INITIALISATION
   ============================================================ */

/**
 * Entry point — called once the DOM is fully loaded.
 */
function init() {
  /* Seed history buffers for all sensors */
  Object.entries(SENSOR_CONFIG).forEach(([key, cfg]) => {
    chartData[key] = generateSeries(cfg.base, cfg.variance);
  });

  /* Render default chart (temperature) */
  buildChart(activeChartKey);

  /* Choose data source: server or built-in JS simulation */
  if (USE_SERVER) {
    setInterval(fetchFromServer, CONFIG.UPDATE_INTERVAL_MS);
    fetchFromServer(); // immediate first fetch
  } else {
    setInterval(updateSensors, CONFIG.UPDATE_INTERVAL_MS);
  }

  /* Scroll-reveal observer */
  initScrollReveal();
}

/* Run when DOM is ready */
document.addEventListener('DOMContentLoaded', init);
