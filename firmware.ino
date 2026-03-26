/*
 * ============================================================
 *  Projexa — IoT Smart Environmental Monitoring System
 *  firmware.ino  |  ESP32 / ESP8266 Arduino Sketch
 *
 *  K.R. Mangalam University · Team 26E1153 · Jan 2026
 *
 *  SENSORS CONNECTED:
 *    DHT11  → GPIO 4        (Temperature + Humidity)
 *    MQ-135 → GPIO 34 (ADC) (Air Quality / CO2 / AQI)
 *    MQ-2   → GPIO 35 (ADC) (LPG / Smoke / Gas)
 *    Buzzer → GPIO 5        (Alert output)
 *    LED    → GPIO 2        (Built-in LED, blinks on alert)
 *
 *  DEPENDENCIES (install via Arduino Library Manager):
 *    - DHT sensor library by Adafruit
 *    - Adafruit Unified Sensor
 *    - ArduinoJson  (v6 or v7)
 *    - WiFi.h       (built-in with ESP32 board package)
 *    - HTTPClient.h (built-in with ESP32 board package)
 *
 *  BOARD SETUP in Arduino IDE:
 *    Tools → Board → ESP32 Dev Module (or ESP8266 NodeMCU)
 *    Tools → Upload Speed → 115200
 *
 *  HOW IT CONNECTS TO YOUR WEBSITE CODE:
 *    Every 2 seconds the ESP32 POSTs a JSON payload to:
 *      http://<your-pc-ip>:5000/api/sensors/ingest
 *    The Python server.py receives it, stores it, and the
 *    website dashboard reads it via GET /api/sensors/current.
 *    Both devices MUST be on the same Wi-Fi network.
 * ============================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <ArduinoJson.h>

/* ──────────────────────────────────────────
   USER CONFIGURATION — EDIT THESE VALUES
   ────────────────────────────────────────── */

// Your Wi-Fi credentials
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// IP address of the PC running server.py
// Find it with: ipconfig (Windows) or ifconfig (Linux/Mac)
const char* SERVER_IP   = "192.168.1.100";
const int   SERVER_PORT = 5000;

// How often to read sensors and POST data (milliseconds)
const unsigned long READ_INTERVAL_MS = 2000;

/* ──────────────────────────────────────────
   PIN DEFINITIONS
   ────────────────────────────────────────── */

#define DHT_PIN       4     // DHT11 DATA pin
#define DHT_TYPE      DHT11 // Change to DHT22 if using DHT22
#define MQ135_PIN     34    // MQ-135 Analog Out (ADC1)
#define MQ2_PIN       35    // MQ-2   Analog Out (ADC1)
#define BUZZER_PIN    5     // Active buzzer (HIGH = on)
#define LED_PIN       2     // Onboard LED

/* ──────────────────────────────────────────
   ALERT THRESHOLDS
   (must match SENSOR_CONFIG in app.js)
   ────────────────────────────────────────── */

#define TEMP_WARN     35.0
#define TEMP_DANGER   40.0
#define HUM_WARN      70.0
#define HUM_DANGER    90.0
#define AQI_WARN      120.0
#define AQI_DANGER    200.0
#define GAS_WARN      100.0
#define GAS_DANGER    200.0

/* ──────────────────────────────────────────
   GLOBALS
   ────────────────────────────────────────── */

DHT dht(DHT_PIN, DHT_TYPE);

unsigned long lastReadTime = 0;
bool alertActive           = false;

// MQ sensor calibration (tune these after warm-up)
// Ro = sensor resistance in clean air; RL = load resistor value
const float MQ135_RO    = 76.63;   // kohm, measured in clean air
const float MQ2_RO      = 9.83;    // kohm
const float RL_VALUE    = 10.0;    // kohm (load resistor on sensor board)

/* ──────────────────────────────────────────
   FUNCTION PROTOTYPES
   ────────────────────────────────────────── */
void     connectWiFi();
float    readTemperature();
float    readHumidity();
float    readAQI();
float    readGas();
String   classifyLevel(float value, float warnThreshold, float dangerThreshold);
void     checkAlerts(float temp, float hum, float aqi, float gas);
void     postToServer(float temp, float hum, float aqi, float gas);
float    mq135_ppm(int rawADC);
float    mq2_ppm(int rawADC);

/* ──────────────────────────────────────────
   SETUP
   ────────────────────────────────────────── */

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("\n========================================");
  Serial.println("  Projexa IoT Environmental Monitor");
  Serial.println("  Team 26E1153 | K.R. Mangalam Univ.");
  Serial.println("========================================");

  // Initialise pins
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_PIN, LOW);

  // Start DHT sensor
  dht.begin();
  Serial.println("[DHT11] Initialised on GPIO " + String(DHT_PIN));

  // Note: MQ sensors need 20-30 second warm-up before accurate readings
  Serial.println("[MQ] Sensors warming up — wait 30 seconds for accuracy...");

  // Connect to Wi-Fi
  connectWiFi();

  // Brief startup blink
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(150);
    digitalWrite(LED_PIN, LOW);
    delay(150);
  }

  Serial.println("[READY] Starting sensor loop...\n");
}

/* ──────────────────────────────────────────
   MAIN LOOP
   ────────────────────────────────────────── */

void loop() {
  unsigned long now = millis();

  // Reconnect Wi-Fi if dropped
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Connection lost — reconnecting...");
    connectWiFi();
  }

  // Read and transmit on interval
  if (now - lastReadTime >= READ_INTERVAL_MS) {
    lastReadTime = now;

    float temperature = readTemperature();
    float humidity    = readHumidity();
    float aqi         = readAQI();
    float gas         = readGas();

    // Print to Serial Monitor
    Serial.printf("[READ] Temp: %.1f°C  Hum: %.1f%%  AQI: %.0f ppm  Gas: %.0f ppm\n",
                  temperature, humidity, aqi, gas);

    // Check thresholds and sound buzzer
    checkAlerts(temperature, humidity, aqi, gas);

    // POST JSON to Python server
    postToServer(temperature, humidity, aqi, gas);
  }
}

/* ──────────────────────────────────────────
   WI-FI CONNECTION
   ────────────────────────────────────────── */

void connectWiFi() {
  Serial.print("[WIFI] Connecting to " + String(WIFI_SSID));
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected!");
    Serial.println("[WIFI] IP Address: " + WiFi.localIP().toString());
  } else {
    Serial.println("\n[WIFI] FAILED — check credentials. Retrying in 5s...");
    delay(5000);
  }
}

/* ──────────────────────────────────────────
   SENSOR READING FUNCTIONS
   ────────────────────────────────────────── */

float readTemperature() {
  float t = dht.readTemperature();  // Celsius
  if (isnan(t)) {
    Serial.println("[DHT] Temperature read failed — check wiring!");
    return 0.0;
  }
  return t;
}

float readHumidity() {
  float h = dht.readHumidity();
  if (isnan(h)) {
    Serial.println("[DHT] Humidity read failed — check wiring!");
    return 0.0;
  }
  return h;
}

float readAQI() {
  int raw = analogRead(MQ135_PIN);  // 0–4095 on ESP32 (12-bit ADC)
  float ppm = mq135_ppm(raw);
  return constrain(ppm, 0.0, 1000.0);
}

float readGas() {
  int raw = analogRead(MQ2_PIN);
  float ppm = mq2_ppm(raw);
  return constrain(ppm, 0.0, 1000.0);
}

/* ──────────────────────────────────────────
   MQ SENSOR PPM CONVERSION
   Formula: ppm = A * (Rs/Ro)^B
   Coefficients from datasheets for CO2/LPG
   ────────────────────────────────────────── */

float mq135_ppm(int rawADC) {
  // Convert ADC reading to sensor resistance Rs
  float voltage = rawADC * (3.3 / 4095.0);
  if (voltage < 0.01) return 0.0;
  float rs = ((3.3 - voltage) / voltage) * RL_VALUE;

  // CO2 curve: ppm = 116.6020682 * (Rs/Ro)^(-2.769034857)
  float ratio = rs / MQ135_RO;
  float ppm   = 116.6020682 * pow(ratio, -2.769034857);
  return ppm;
}

float mq2_ppm(int rawADC) {
  // LPG curve: ppm = 574.25 * (Rs/Ro)^(-2.222)
  float voltage = rawADC * (3.3 / 4095.0);
  if (voltage < 0.01) return 0.0;
  float rs  = ((3.3 - voltage) / voltage) * RL_VALUE;
  float ratio = rs / MQ2_RO;
  float ppm   = 574.25 * pow(ratio, -2.222);
  return ppm;
}

/* ──────────────────────────────────────────
   THRESHOLD CLASSIFICATION
   ────────────────────────────────────────── */

String classifyLevel(float value, float warnThreshold, float dangerThreshold) {
  if (value >= dangerThreshold) return "danger";
  if (value >= warnThreshold)   return "warn";
  return "normal";
}

/* ──────────────────────────────────────────
   ALERT: BUZZER + LED
   ────────────────────────────────────────── */

void checkAlerts(float temp, float hum, float aqi, float gas) {
  bool danger = (temp >= TEMP_DANGER || hum >= HUM_DANGER ||
                 aqi  >= AQI_DANGER  || gas >= GAS_DANGER);
  bool warn   = (temp >= TEMP_WARN   || hum >= HUM_WARN   ||
                 aqi  >= AQI_WARN    || gas >= GAS_WARN);

  if (danger) {
    // Rapid beeps for danger
    for (int i = 0; i < 3; i++) {
      digitalWrite(BUZZER_PIN, HIGH);
      digitalWrite(LED_PIN, HIGH);
      delay(100);
      digitalWrite(BUZZER_PIN, LOW);
      digitalWrite(LED_PIN, LOW);
      delay(80);
    }
    alertActive = true;
    Serial.println("[ALERT] !!! DANGER LEVEL DETECTED !!!");

  } else if (warn) {
    // Single beep for warning
    digitalWrite(BUZZER_PIN, HIGH);
    digitalWrite(LED_PIN, HIGH);
    delay(200);
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(LED_PIN, LOW);
    alertActive = true;
    Serial.println("[ALERT] Warning threshold crossed.");

  } else {
    // All clear
    if (alertActive) {
      Serial.println("[ALERT] Conditions back to normal.");
    }
    alertActive = false;
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(LED_PIN, LOW);
  }
}

/* ──────────────────────────────────────────
   HTTP POST → Python Server
   Payload sent to: POST /api/sensors/ingest
   ────────────────────────────────────────── */

void postToServer(float temp, float hum, float aqi, float gas) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HTTP] Skipping POST — no Wi-Fi");
    return;
  }

  // Build JSON payload
  StaticJsonDocument<256> doc;
  doc["temp"] = serialized(String(temp, 1));
  doc["hum"]  = serialized(String(hum, 1));
  doc["aqi"]  = serialized(String(aqi, 0));
  doc["gas"]  = serialized(String(gas, 0));
  doc["temp_status"] = classifyLevel(temp, TEMP_WARN, TEMP_DANGER);
  doc["hum_status"]  = classifyLevel(hum,  HUM_WARN,  HUM_DANGER);
  doc["aqi_status"]  = classifyLevel(aqi,  AQI_WARN,  AQI_DANGER);
  doc["gas_status"]  = classifyLevel(gas,  GAS_WARN,  GAS_DANGER);
  doc["device_id"]   = "ESP32-PROJEXA-01";
  doc["alert"]       = alertActive;

  String jsonBody;
  serializeJson(doc, jsonBody);

  // Send HTTP POST
  String url = "http://" + String(SERVER_IP) + ":" + String(SERVER_PORT) + "/api/sensors/ingest";
  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  int responseCode = http.POST(jsonBody);

  if (responseCode == 200) {
    Serial.println("[HTTP] POST OK → " + url);
  } else if (responseCode < 0) {
    Serial.println("[HTTP] POST FAILED — is server.py running?");
  } else {
    Serial.println("[HTTP] POST error code: " + String(responseCode));
  }

  http.end();
}
