/**
 * Projexa — IoT Smart Environmental Monitoring System
 * app.js  |  Live Weather API Edition
 * K.R. Mangalam University · Team 26E1153 · Jan 2026
 *
 * Data Sources:
 *   Current Weather  → api.openweathermap.org/data/2.5/weather
 *   Air Pollution    → api.openweathermap.org/data/2.5/air_pollution
 *
 * How it works:
 *   1. User enters their free OWM API key + city name
 *   2. fetchAllData() calls both OWM endpoints in parallel
 *   3. Real values update all sensor cards, mini cards, and the chart
 *   4. Threshold checks fire alerts automatically
 *   5. Auto-refreshes every 60 seconds
 */

'use strict';

/* ============================================================
   CONFIGURATION
   ============================================================ */

const OWM_BASE_WEATHER = 'https://api.openweathermap.org/data/2.5/weather';
const OWM_BASE_AIR     = 'https://api.openweathermap.org/data/2.5/air_pollution';
const OWM_GEO_BASE     = 'https://api.openweathermap.org/geo/1.0/direct';

const REFRESH_INTERVAL_MS = 60000;   // 60 seconds
const HISTORY_POINTS      = 30;

/** Thresholds — same as the original sensor config */
const THRESHOLDS = {
  temp: { warn: 35,   danger: 40  },
  hum:  { warn: 70,   danger: 90  },
  aqi:  { warn: 25,   danger: 75  },   // PM2.5 µg/m³ (WHO guidelines)
  gas:  { warn: 4000, danger: 9400 },  // CO µg/m³ (WHO 8h limit ~9400)
};

const SENSOR_RANGES = {
  temp: [0,  50 ],
  hum:  [0,  100],
  aqi:  [0,  150],   // PM2.5 µg/m³
  gas:  [0,  12000], // CO µg/m³
};

const STATUS_LABELS = {
  temp: ['Normal Range',  'High Temp',       'CRITICAL HEAT'    ],
  hum:  ['Comfortable',  'High Humidity',    'CRITICAL HUMIDITY'],
  aqi:  ['Good Air',     'Moderate PM2.5',   'POOR AIR QUALITY' ],
  gas:  ['Safe CO Level','Elevated CO',      'DANGEROUS CO'     ],
};

const CHART_COLORS = {
  temp: '#ff6b35',
  hum:  '#7c6fe0',
  aqi:  '#00ffd4',
  gas:  '#ffce3e',
};

/** OWM AQI index label map (1=Good … 5=Very Poor) */
const AQI_LABELS = ['', 'Good', 'Fair', 'Moderate', 'Poor', 'Very Poor'];

/** Weather condition code → emoji */
const WEATHER_ICONS = {
  2: '⛈️', 3: '🌦️', 5: '🌧️', 6: '🌨️', 7: '🌫️',
  800: '☀️', 801: '🌤️', 802: '⛅', 803: '🌥️', 804: '☁️',
};

/* ============================================================
   STATE
   ============================================================ */

let OWM_API_KEY  = localStorage.getItem('owm_api_key') || '';
let CURRENT_CITY = localStorage.getItem('owm_city')    || 'Gurugram';
let CURRENT_LAT  = parseFloat(localStorage.getItem('owm_lat') || '28.4595');
let CURRENT_LON  = parseFloat(localStorage.getItem('owm_lon') || '77.0266');

let refreshTimer    = null;
let alertCount      = 0;
let chartInstance   = null;
let activeChartKey  = 'temp';

const chartData = { temp: [], hum: [], aqi: [], gas: [] };
const timeLabels = [];

/* ============================================================
   SETUP: API KEY + CITY
   ============================================================ */

/** Called when user clicks "Connect" in the setup banner */
function applyApiKey() {
  const key  = document.getElementById('apiKeyInput').value.trim();
  const city = document.getElementById('cityInput').value.trim();

  if (!key) { showToast('Please paste your OpenWeatherMap API key.'); return; }

  OWM_API_KEY  = key;
  CURRENT_CITY = city || 'Gurugram';

  localStorage.setItem('owm_api_key', OWM_API_KEY);
  localStorage.setItem('owm_city',    CURRENT_CITY);

  document.getElementById('setupBanner').classList.add('hidden');
  startLiveFeed();
}

/** City switch from the dashboard toolbar */
function switchCity() {
  const city = document.getElementById('citySwitchInput').value.trim();
  if (!city) return;
  CURRENT_CITY = city;
  localStorage.setItem('owm_city', CURRENT_CITY);
  document.getElementById('citySwitchInput').value = '';
  // Reset stored coords so geocoding runs fresh
  CURRENT_LAT = null;
  CURRENT_LON = null;
  fetchAllData(true);
}

/* ============================================================
   GEOCODING  — city name → lat/lon
   ============================================================ */

async function geocodeCity(city) {
  const url = `${OWM_GEO_BASE}?q=${encodeURIComponent(city)}&limit=1&appid=${OWM_API_KEY}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Geocode HTTP ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error(`City not found: "${city}"`);
  return { lat: data[0].lat, lon: data[0].lon, name: data[0].name, country: data[0].country };
}

/* ============================================================
   DATA FETCHING — both OWM endpoints in parallel
   ============================================================ */

async function fetchAllData(force = false) {
  if (!OWM_API_KEY) return;

  setStatusLoading();

  try {
    // 1. Geocode city if we don't have coords yet
    if (!CURRENT_LAT || !CURRENT_LON) {
      const geo = await geocodeCity(CURRENT_CITY);
      CURRENT_LAT  = geo.lat;
      CURRENT_LON  = geo.lon;
      CURRENT_CITY = geo.name;
      localStorage.setItem('owm_lat',  CURRENT_LAT);
      localStorage.setItem('owm_lon',  CURRENT_LON);
      localStorage.setItem('owm_city', CURRENT_CITY);
    }

    // 2. Parallel fetch: current weather + air pollution
    const [weatherRes, airRes] = await Promise.all([
      fetch(`${OWM_BASE_WEATHER}?lat=${CURRENT_LAT}&lon=${CURRENT_LON}&units=metric&appid=${OWM_API_KEY}`),
      fetch(`${OWM_BASE_AIR}?lat=${CURRENT_LAT}&lon=${CURRENT_LON}&appid=${OWM_API_KEY}`),
    ]);

    if (!weatherRes.ok) {
      const err = await weatherRes.json().catch(() => ({}));
      throw new Error(err.message || `Weather API error ${weatherRes.status}`);
    }
    if (!airRes.ok) {
      throw new Error(`Air Pollution API error ${airRes.status}`);
    }

    const weatherData = await weatherRes.json();
    const airData     = await airRes.json();

    processAndDisplay(weatherData, airData);

  } catch (err) {
    setStatusError(err.message);
    console.error('[Projexa] Fetch error:', err);
  }
}

/* ============================================================
   DATA PROCESSING — map OWM fields → sensor cards
   ============================================================ */

function processAndDisplay(w, air) {
  const now  = new Date();
  const comp = air.list[0]?.components || {};
  const aqiIndex = air.list[0]?.main?.aqi || 0;

  // ── Map OWM fields to our 4 sensor keys ──
  const readings = {
    temp: w.main.temp,
    hum:  w.main.humidity,
    aqi:  comp.pm2_5   ?? 0,  // PM2.5 µg/m³
    gas:  comp.co      ?? 0,  // Carbon Monoxide µg/m³
  };

  // ── Update 4 main sensor cards ──
  let anyWarn = false, anyDanger = false;

  Object.entries(readings).forEach(([key, value]) => {
    const thr    = THRESHOLDS[key];
    const range  = SENSOR_RANGES[key];
    const labels = STATUS_LABELS[key];

    // Value display
    const displayVal = key === 'temp' ? value.toFixed(1) : Math.round(value);
    document.getElementById(key === 'temp' ? 'tempVal' :
                            key === 'hum'  ? 'humVal'  :
                            key === 'aqi'  ? 'aqiVal'  : 'gasVal').textContent = displayVal;

    // Progress bar
    const pct = Math.min(100, ((value - range[0]) / (range[1] - range[0])) * 100);
    document.getElementById(key === 'temp' ? 'tempBar' :
                            key === 'hum'  ? 'humBar'  :
                            key === 'aqi'  ? 'aqiBar'  : 'gasBar').style.width = pct.toFixed(1) + '%';

    // Status label
    const statusId = key === 'temp' ? 'tempStatus' :
                     key === 'hum'  ? 'humStatus'  :
                     key === 'aqi'  ? 'aqiStatus'  : 'gasStatus';
    const statusEl = document.getElementById(statusId);

    if (value >= thr.danger) {
      statusEl.className = 'sensor-status danger';
      statusEl.textContent = '⚠ ' + labels[2];
      anyDanger = true;
      fireAlert('danger', key, value);
    } else if (value >= thr.warn) {
      statusEl.className = 'sensor-status warning';
      statusEl.textContent = '⚡ ' + labels[1];
      anyWarn = true;
      fireAlert('warn', key, value);
    } else {
      statusEl.className = 'sensor-status normal';
      statusEl.textContent = '✓ ' + labels[0];
    }

    // Chart history
    chartData[key].push(+parseFloat(displayVal));
    if (chartData[key].length > HISTORY_POINTS) chartData[key].shift();

    if (activeChartKey === key && chartInstance) {
      chartInstance.data.datasets[0].data = chartData[key];
      chartInstance.update('none');
    }
  });

  // ── Update time-axis labels ──
  timeLabels.push(now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
  if (timeLabels.length > HISTORY_POINTS) timeLabels.shift();
  if (chartInstance) {
    chartInstance.data.labels = [...timeLabels];
    chartInstance.update('none');
  }

  // ── Mini extra cards ──
  setMini('no2Val',      comp.no2,           1);
  setMini('o3Val',       comp.o3,            1);
  setMini('pressVal',    w.main.pressure,    0);
  setMini('windVal',     w.wind?.speed,      1);
  setMini('visVal',      (w.visibility/1000),1);
  setMini('aqiIndexVal', aqiIndex,           0, AQI_LABELS[aqiIndex] || '');

  // ── Weather condition bar ──
  const cond     = w.weather[0];
  const iconCode = cond?.id;
  const iconKey  = iconCode >= 800 ? iconCode : Math.floor(iconCode / 100);
  const emoji    = WEATHER_ICONS[iconKey] || '🌡️';
  const cityName = w.name + (w.sys?.country ? ', ' + w.sys.country : '');

  document.getElementById('weatherIcon').textContent     = emoji;
  document.getElementById('weatherDesc').textContent     = cond?.description || '';
  document.getElementById('weatherFeels').textContent    = `Feels like ${w.main.feels_like?.toFixed(1)}°C`;
  document.getElementById('weatherWind').textContent     = `Wind ${w.wind?.speed} m/s`;
  document.getElementById('weatherLocation').textContent = cityName.toUpperCase();
  document.getElementById('conditionBar').style.display  = 'flex';

  // ── Hero city stat ──
  document.getElementById('heroCity').textContent = w.name;

  // ── Status bar ──
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (anyDanger) {
    dot.className  = 'status-dot danger';
    txt.textContent = '⚠ HAZARDOUS CONDITIONS — Real data from OpenWeatherMap';
  } else if (anyWarn) {
    dot.className  = 'status-dot warn';
    txt.textContent = '⚡ Warning threshold exceeded — ' + cityName;
  } else {
    dot.className  = 'status-dot';
    txt.textContent = 'Live data · ' + cityName + ' · OpenWeatherMap';
  }

  document.getElementById('lastUpdate').textContent =
    `Updated: ${now.toLocaleTimeString()} · OWM Weather + Air Pollution APIs`;
}

/** Safely update a mini-card value */
function setMini(id, val, decimals, suffix = '') {
  const el = document.getElementById(id);
  if (!el) return;
  if (val == null || isNaN(val)) { el.textContent = '--'; return; }
  el.textContent = (decimals > 0 ? parseFloat(val).toFixed(decimals) : Math.round(val)) + (suffix ? ' ' + suffix : '');
}

/* ============================================================
   STATUS HELPERS
   ============================================================ */

function setStatusLoading() {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  dot.className  = 'status-dot idle';
  txt.textContent = 'Fetching live data from OpenWeatherMap…';
}

function setStatusError(msg) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  dot.className  = 'status-dot danger';
  txt.textContent = 'API Error — ' + msg;
  document.getElementById('lastUpdate').textContent = 'Last attempt: ' + new Date().toLocaleTimeString();

  addAlertItem('danger', '🚨', 'API Error: ' + msg, 'OpenWeatherMap');
}

/* ============================================================
   ALERTS
   ============================================================ */

const recentAlerts = new Set(); // prevent duplicate alerts within one fetch

function fireAlert(type, sensorKey, value) {
  const alertKey = `${type}-${sensorKey}`;
  if (recentAlerts.has(alertKey)) return;
  recentAlerts.add(alertKey);
  setTimeout(() => recentAlerts.delete(alertKey), REFRESH_INTERVAL_MS);

  const icon = type === 'danger' ? '🚨' : '⚠️';
  const label = { temp: 'Temperature', hum: 'Humidity', aqi: 'PM2.5', gas: 'CO Concentration' };
  const units = { temp: '°C', hum: '%', aqi: ' µg/m³', gas: ' µg/m³' };
  const msg   = `${label[sensorKey]} ${type === 'danger' ? 'CRITICAL' : 'Warning'}: ${parseFloat(value).toFixed(1)}${units[sensorKey]}`;

  showToast(msg);
  addAlertItem(type, icon, msg, CURRENT_CITY + ' · OpenWeatherMap');
}

function addAlertItem(type, icon, msg, source) {
  alertCount++;
  document.getElementById('alertCountBadge').textContent = alertCount;

  const list = document.getElementById('alertsList');
  const item = document.createElement('div');
  item.className = 'alert-item';
  item.innerHTML = `
    <div class="alert-icon ${type}">${icon}</div>
    <div class="alert-text">
      <div class="alert-msg">${msg}</div>
      <div class="alert-time">${new Date().toLocaleTimeString()} · ${source}</div>
    </div>`;
  list.insertBefore(item, list.firstChild);

  // Keep max 20 alerts
  while (list.children.length > 20) list.removeChild(list.lastChild);
}

function clearAlerts() {
  alertCount = 0;
  document.getElementById('alertCountBadge').textContent = 0;
  document.getElementById('alertsList').innerHTML = `
    <div class="alert-item">
      <div class="alert-icon info">ℹ️</div>
      <div class="alert-text">
        <div class="alert-msg">All alerts cleared</div>
        <div class="alert-time">${new Date().toLocaleTimeString()} · System</div>
      </div>
    </div>`;
  recentAlerts.clear();
}

function showToast(msg) {
  document.getElementById('toastMsg').textContent = msg;
  const toast = document.getElementById('alertToast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4500);
}

/* ============================================================
   CHART
   ============================================================ */

function buildChart(key) {
  const ctx = document.getElementById('envChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [...timeLabels],
      datasets: [{
        data: chartData[key],
        borderColor: CHART_COLORS[key],
        backgroundColor: CHART_COLORS[key] + '18',
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#181c24', borderColor: '#232736', borderWidth: 1,
          titleColor: '#6b7280', bodyColor: '#e8eaf2',
          titleFont: { family: 'Space Mono', size: 11 },
          bodyFont:  { family: 'Space Mono', size: 13 },
        },
      },
      scales: {
        x: { grid: { color: '#23273622' }, ticks: { color: '#6b7280', font: { family: 'Space Mono', size: 10 }, maxTicksLimit: 8 } },
        y: { grid: { color: '#23273622' }, ticks: { color: '#6b7280', font: { family: 'Space Mono', size: 10 } } },
      },
    },
  });
}

function switchChart(key, btn) {
  activeChartKey = key;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  buildChart(key);
}

/* ============================================================
   LIVE FEED LIFECYCLE
   ============================================================ */

function startLiveFeed() {
  // Clear any existing timer
  if (refreshTimer) clearInterval(refreshTimer);

  // Immediate first fetch
  fetchAllData(true);

  // Then every 60 seconds
  refreshTimer = setInterval(() => fetchAllData(false), REFRESH_INTERVAL_MS);

  addAlertItem('info', 'ℹ️',
    `Live feed started — ${CURRENT_CITY} · Refreshes every 60 seconds`,
    'OpenWeatherMap');
}

/* ============================================================
   SCROLL REVEAL
   ============================================================ */

function initScrollReveal() {
  const observer = new IntersectionObserver(
    entries => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); }),
    { threshold: 0.12 }
  );
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

/* ============================================================
   INITIALISATION
   ============================================================ */

function init() {
  buildChart(activeChartKey);
  initScrollReveal();

  // Restore saved API key / city if available
  if (OWM_API_KEY) {
    document.getElementById('apiKeyInput').value = OWM_API_KEY;
    document.getElementById('cityInput').value   = CURRENT_CITY;
    document.getElementById('setupBanner').classList.add('hidden');
    document.getElementById('heroCity').textContent = CURRENT_CITY;
    startLiveFeed();
  } else {
    // Show idle state
    document.getElementById('statusDot').className = 'status-dot idle';
    document.getElementById('statusText').textContent = 'Waiting for API key — enter it in the banner above';
  }
}

document.addEventListener('DOMContentLoaded', init);
