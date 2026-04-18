/**
 * MikroTik WiFi Manager for ESP32 - optimized variant.
 *
 * PlatformIO project
 *
 * Installation:
 * 1. Copy src/config.h.example to src/config.h
 * 2. Adjust src/config.h (WiFi, MikroTik IP, credentials)
 * 3. pio run --target uploadfs  (uploads data/ directory)
 * 4. pio run --target upload    (uploads firmware)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoOTA.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <base64.h>
#include <LittleFS.h>

// Load configuration from separate header
#include "config.h"

// ==================== CONSTANTS ====================

const char* PROFILE_COMMENT_PREFIX = "wifi-manager:ssid=";

const char* CONFIG_FILE_PATH = "/config.json";
const char* CAPTIVE_PORTAL_SSID = "MikroTikSetup";
const unsigned long WIFI_INITIAL_CONNECT_TIMEOUT_MS = 10000;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 30000;

struct RuntimeConfig {
  String wifiSsid;
  String wifiPassword;
  String mikrotikIp;
  String mikrotikUser;
  String mikrotikPass;
  String mikrotikWlanInterface;
  String band2ghz;
  String band5ghz;
  String channelWidth2ghz;
  String channelWidth5ghz;
  int scanDurationSeconds;
  bool stationRoaming;
};

RuntimeConfig runtimeConfig;

WebServer server(WEB_PORT);

bool captivePortalActive = false;
bool wifiReconnectPending = false;
unsigned long lastReconnectAttempt = 0;
bool filesystemAvailable = false;

bool otaServiceReady = false;

// Scan State Management
struct ScanState {
  bool isScanning = false;
  bool hasResult = false;
  String result = "";
  unsigned long startTime = 0;
  unsigned long resultTimestamp = 0;
  String band = "";
  String csvFilename = "";
  unsigned long expectedDurationMs = 0;
  unsigned long minReadyMs = 0;
  unsigned long resultTimeoutMs = 0;
  unsigned long pollIntervalMs = 0;
};

ScanState scanState;

// ==================== HELPER FUNCTIONS ====================

void applyDefaultConfig(RuntimeConfig& cfg);
bool loadRuntimeConfigFromFile();
bool saveRuntimeConfigToFile();
void attemptWifiConnect();
void startCaptivePortal();
void stopCaptivePortal();
void handleWifiTasks();
bool ensureOperationAllowed();
bool isPathAllowedDuringCaptive(const String& path);

void setupArduinoOTA();
void handleSettingsGet();
void handleSettingsUpdate();
void handleDeleteProfile();

bool asBool(String value) {
  value.toLowerCase();
  value.trim();
  return (value == "true" || value == "yes" || value == "on" ||
          value == "1" || value == "running" || value == "enabled");
}

void applyDefaultConfig(RuntimeConfig& cfg) {
  cfg.wifiSsid = WIFI_SSID;
  cfg.wifiPassword = WIFI_PASSWORD;
  cfg.mikrotikIp = MIKROTIK_IP;
  cfg.mikrotikUser = MIKROTIK_USER;
  cfg.mikrotikPass = MIKROTIK_PASS;
  cfg.mikrotikWlanInterface = MIKROTIK_WLAN_INTERFACE;
  cfg.band2ghz = BAND_2GHZ;
  cfg.band5ghz = BAND_5GHZ;
  cfg.channelWidth2ghz = CHANNEL_WIDTH_2GHZ;
  cfg.channelWidth5ghz = CHANNEL_WIDTH_5GHZ;
  cfg.scanDurationSeconds = SCAN_DURATION_SECONDS;
  cfg.stationRoaming = STATION_ROAMING_DEFAULT;
}

bool loadRuntimeConfigFromFile() {
  applyDefaultConfig(runtimeConfig);

  if (!filesystemAvailable) {
    Serial.println("  WARNING: Filesystem unavailable, using defaults");
    return false;
  }

  if (!LittleFS.exists(CONFIG_FILE_PATH)) {
    saveRuntimeConfigToFile();
    return true;
  }

  File file = LittleFS.open(CONFIG_FILE_PATH, "r");
  if (!file) {
    Serial.println("  WARNING: Unable to open config file, using defaults");
    return false;
  }

  DynamicJsonDocument doc(1536);
  DeserializationError error = deserializeJson(doc, file);
  file.close();

  if (error) {
    Serial.printf("  WARNING: Failed to parse config file: %s\n", error.c_str());
    return false;
  }

  JsonObject wifiObj = doc["wifi"].as<JsonObject>();
  runtimeConfig.wifiSsid = wifiObj["ssid"] | runtimeConfig.wifiSsid;
  runtimeConfig.wifiPassword = wifiObj["password"] | runtimeConfig.wifiPassword;

  JsonObject mikrotikObj = doc["mikrotik"].as<JsonObject>();
  runtimeConfig.mikrotikIp = mikrotikObj["ip"] | runtimeConfig.mikrotikIp;
  runtimeConfig.mikrotikUser = mikrotikObj["user"] | runtimeConfig.mikrotikUser;
  runtimeConfig.mikrotikPass = mikrotikObj["pass"] | runtimeConfig.mikrotikPass;
  runtimeConfig.mikrotikWlanInterface = mikrotikObj["wlan_interface"] | runtimeConfig.mikrotikWlanInterface;

  JsonObject bandObj = doc["bands"].as<JsonObject>();
  runtimeConfig.band2ghz = bandObj["band_2ghz"] | runtimeConfig.band2ghz;
  runtimeConfig.band5ghz = bandObj["band_5ghz"] | runtimeConfig.band5ghz;
  runtimeConfig.channelWidth2ghz = bandObj["channel_width_2ghz"] | runtimeConfig.channelWidth2ghz;
  runtimeConfig.channelWidth5ghz = bandObj["channel_width_5ghz"] | runtimeConfig.channelWidth5ghz;

  JsonObject scanObj = doc["scan"].as<JsonObject>();
  runtimeConfig.scanDurationSeconds = scanObj["duration_seconds"] | runtimeConfig.scanDurationSeconds;
  if (runtimeConfig.scanDurationSeconds <= 0) {
    runtimeConfig.scanDurationSeconds = SCAN_DURATION_SECONDS;
  }

  JsonObject wirelessObj = doc["wireless"].as<JsonObject>();
  runtimeConfig.stationRoaming = wirelessObj["station_roaming"] | runtimeConfig.stationRoaming;

  return true;
}

bool saveRuntimeConfigToFile() {
  if (!filesystemAvailable) {
    Serial.println("  ERROR: Cannot save config (filesystem unavailable)");
    return false;
  }

  DynamicJsonDocument doc(1536);

  JsonObject wifiObj = doc.createNestedObject("wifi");
  wifiObj["ssid"] = runtimeConfig.wifiSsid;
  wifiObj["password"] = runtimeConfig.wifiPassword;

  JsonObject mikrotikObj = doc.createNestedObject("mikrotik");
  mikrotikObj["ip"] = runtimeConfig.mikrotikIp;
  mikrotikObj["user"] = runtimeConfig.mikrotikUser;
  mikrotikObj["pass"] = runtimeConfig.mikrotikPass;
  mikrotikObj["wlan_interface"] = runtimeConfig.mikrotikWlanInterface;

  JsonObject bandObj = doc.createNestedObject("bands");
  bandObj["band_2ghz"] = runtimeConfig.band2ghz;
  bandObj["band_5ghz"] = runtimeConfig.band5ghz;
  bandObj["channel_width_2ghz"] = runtimeConfig.channelWidth2ghz;
  bandObj["channel_width_5ghz"] = runtimeConfig.channelWidth5ghz;

  JsonObject scanObj = doc.createNestedObject("scan");
  scanObj["duration_seconds"] = runtimeConfig.scanDurationSeconds;

  JsonObject wirelessObj = doc.createNestedObject("wireless");
  wirelessObj["station_roaming"] = runtimeConfig.stationRoaming;

  File file = LittleFS.open(CONFIG_FILE_PATH, "w");
  if (!file) {
    Serial.println("  ERROR: Unable to open config file for writing");
    return false;
  }

  serializeJson(doc, file);
  file.close();
  return true;
}

bool isPathAllowedDuringCaptive(const String& path) {
  if (path == "/" || path == "/config.html" || path == "/config.js" || path == "/style.css" || path == "/favicon.png" || path == "/favicon.ico" || path == "/favicon@2x.png") {
    return true;
  }
  if (path.startsWith("/i18n/")) {
    return true;
  }
  return false;
}

bool ensureOperationAllowed() {
  if (!captivePortalActive) {
    return true;
  }
  server.send(403, "application/json", "{\"error\":\"Captive portal active\"}");
  return false;
}

// ==================== FILESYSTEM UTILITIES ====================

String getContentType(String filename) {
  if (filename.endsWith(".html")) return "text/html";
  else if (filename.endsWith(".css")) return "text/css";
  else if (filename.endsWith(".js")) return "application/javascript";
  else if (filename.endsWith(".json")) return "application/json";
  else if (filename.endsWith(".png")) return "image/png";
  else if (filename.endsWith(".jpg")) return "image/jpeg";
  else if (filename.endsWith(".ico")) return "image/x-icon";
  return "text/plain";
}

bool handleFileRead(String path) {
  if (path.endsWith("/")) {
    path += "index.html";
  }

  // LittleFS expects paths WITH a leading slash
  if (!path.startsWith("/")) {
    path = "/" + path;
  }

  // Never expose runtime configuration secrets over HTTP
  if (path == CONFIG_FILE_PATH) {
    server.send(404, "text/plain", "Not found");
    return true;
  }

  if (captivePortalActive && !isPathAllowedDuringCaptive(path)) {
    server.sendHeader("Location", "/config.html");
    server.send(302, "text/plain", "Redirect");
    return true;
  }

  if (captivePortalActive && path == "/index.html") {
    path = "/config.html";
  }

  String contentType = getContentType(path);

  if (LittleFS.exists(path)) {
    File file = LittleFS.open(path, "r");
    if (file) {
      server.streamFile(file, contentType);
      file.close();
      return true;
    }
  }

  return false;
}

// ==================== MIKROTIK API HELPERS ====================

String mikrotikRequest(String method, String path, String jsonBody = "", int timeoutMs = 15000) {
  HTTPClient http;
  http.setTimeout(timeoutMs);

  // Use HTTP instead of HTTPS to keep RAM usage low
  if (runtimeConfig.mikrotikIp.length() == 0) {
    Serial.println("  ERROR: MikroTik IP not configured");
    return "{\"error\":\"mikrotik_ip_not_configured\"}";
  }
  String url = "http://" + runtimeConfig.mikrotikIp + "/rest" + path;

  http.begin(url);

  String auth = runtimeConfig.mikrotikUser + ":" + runtimeConfig.mikrotikPass;
  String authEncoded = base64::encode(auth);
  http.addHeader("Authorization", "Basic " + authEncoded);

  if (jsonBody.length() > 0) {
    http.addHeader("Content-Type", "application/json");
  }

  int httpCode = -1;

  if (method == "GET") {
    httpCode = http.GET();
  } else if (method == "POST") {
    httpCode = http.POST(jsonBody);
  } else if (method == "PATCH") {
    httpCode = http.PATCH(jsonBody);
  } else if (method == "DELETE") {
    httpCode = http.sendRequest("DELETE", jsonBody);
  }

  String response = "";
  if (httpCode > 0) {
    response = http.getString();
  } else {
    Serial.printf("  → MikroTik ERROR: %s\n", http.errorToString(httpCode).c_str());
    response = "{\"error\":\"Request failed\"}";
  }

  http.end();
  return response;
}

bool fetchConfiguredWirelessInterface(String& interfaceIdOut, String& currentBandOut) {
  String ifaceResponse = mikrotikRequest("GET", "/interface/wireless");
  DynamicJsonDocument ifaceDoc(JSON_BUFFER_INTERFACES);
  DeserializationError error = deserializeJson(ifaceDoc, ifaceResponse);

  if (error) {
    Serial.printf("  ERROR: Failed to parse interface list: %s\n", error.c_str());
    return false;
  }

  if (ifaceDoc.is<JsonArray>()) {
    for (JsonObject iface : ifaceDoc.as<JsonArray>()) {
      String name = iface["name"] | "";
      if (name == runtimeConfig.mikrotikWlanInterface) {
        interfaceIdOut = iface[".id"] | "";
        currentBandOut = iface["band"] | "";
        if (interfaceIdOut.length() == 0) {
          Serial.println("  ERROR: Configured interface found but missing .id");
          return false;
        }
        return true;
      }
    }
  }

  Serial.printf("  ERROR: Configured interface '%s' not found on MikroTik\n", runtimeConfig.mikrotikWlanInterface.c_str());
  return false;
}

// ==================== SECURITY PROFILE MANAGEMENT ====================

String ensureSecurityProfile(String ssid, String password, bool requiresPassword,
                             bool known, String profileName) {
  // Use profile name from frontend or fall back to truncated SSID
  if (profileName.length() == 0) {
    profileName = "client-" + ssid.substring(0, min(20, (int)ssid.length()));
  }

  String comment = String(PROFILE_COMMENT_PREFIX) + ssid;

  // Load existing profiles
  DynamicJsonDocument profilesDoc(JSON_BUFFER_SECURITY_PROFILES);
  String response = mikrotikRequest("GET", "/interface/wireless/security-profiles");
  DeserializationError error = deserializeJson(profilesDoc, response);
  if (error) {
    Serial.printf("  ERROR: JSON parsing failed: %s\n", error.c_str());
    Serial.printf("  Response size: %d bytes\n", response.length());
  }

  // Find matching profile if it already exists
  JsonObject targetProfile;
  String existingMode = "";
  if (profilesDoc.is<JsonArray>()) {
    for (JsonObject profile : profilesDoc.as<JsonArray>()) {
      String pName = profile["name"] | "";
      String pComment = profile["comment"] | "";
      if (pName == profileName || pComment == comment) {
        targetProfile = profile;
        existingMode = profile["mode"] | "";
        break;
      }
    }
  }

  // Determine desired security mode
  String desiredMode = requiresPassword ? "dynamic-keys" : "none";

  // If profile exists but mode differs -> delete and recreate
  bool needsRecreate = false;
  if (!targetProfile.isNull() && existingMode != desiredMode) {
    String targetName = targetProfile["name"] | profileName;
    mikrotikRequest("DELETE", "/interface/wireless/security-profiles/" + targetName, "");
    targetProfile = JsonObject();  // Mark as deleted
    needsRecreate = true;
  }

  // Build payload
  DynamicJsonDocument payloadDoc(JSON_BUFFER_SECURITY_PAYLOAD);
  payloadDoc["comment"] = comment;

  if (requiresPassword) {
    payloadDoc["mode"] = "dynamic-keys";
    payloadDoc["authentication-types"] = "wpa-psk,wpa2-psk";
    if (password.length() > 0) {
      payloadDoc["wpa-pre-shared-key"] = password;
      payloadDoc["wpa2-pre-shared-key"] = password;
    } else {
      Serial.println("  WARNING: requiresPassword=true but password is empty!");
    }
  } else {
    payloadDoc["mode"] = "none";
    payloadDoc["authentication-types"] = "";
    payloadDoc["wpa-pre-shared-key"] = "";
    payloadDoc["wpa2-pre-shared-key"] = "";
  }

  String payload;
  serializeJson(payloadDoc, payload);

  // Update or create profile
  if (!targetProfile.isNull() && !needsRecreate) {
    // Update existing profile (only when mode stays the same)
    String targetName = targetProfile["name"] | profileName;
    mikrotikRequest("PATCH", "/interface/wireless/security-profiles/" + targetName, payload);
    return targetName;
  } else {
    // Create new profile
    if (requiresPassword && password.length() == 0) {
      Serial.println("  ERROR: Password required for secured profile");
      return profileName;
    }
    payloadDoc["name"] = profileName;
    String createPayload;
    serializeJson(payloadDoc, createPayload);
    mikrotikRequest("POST", "/interface/wireless/security-profiles/add", createPayload);
    return profileName;
  }
}

// ==================== CONNECTION LIST MANAGEMENT ====================

const char* CONNECT_LIST_COMMENT_PREFIX = "wifi-manager:ssid=";

// Disable all connect-list entries
void disableAllConnectionLists() {
  String response = mikrotikRequest("GET", "/interface/wireless/connect-list");
  DynamicJsonDocument doc(JSON_BUFFER_SECURITY_PROFILES);
  DeserializationError error = deserializeJson(doc, response);

  if (error) {
    Serial.printf("  ERROR: Failed to parse connect-list: %s\n", error.c_str());
    return;
  }

  if (doc.is<JsonArray>()) {
    for (JsonObject entry : doc.as<JsonArray>()) {
      String comment = entry["comment"] | "";
      if (comment.startsWith(CONNECT_LIST_COMMENT_PREFIX)) {
        String entryId = entry[".id"] | "";
        if (entryId.length() > 0) {
          Serial.printf("  Disabling connect-list entry: %s\n", entryId.c_str());
          mikrotikRequest("PATCH", "/interface/wireless/connect-list/" + entryId, "{\"disabled\":\"yes\"}");
        }
      }
    }
  }
}

// Delete connect-list for specific SSID
void deleteConnectionList(String ssid) {
  String comment = String(CONNECT_LIST_COMMENT_PREFIX) + ssid;
  String response = mikrotikRequest("GET", "/interface/wireless/connect-list");
  DynamicJsonDocument doc(JSON_BUFFER_SECURITY_PROFILES);
  DeserializationError error = deserializeJson(doc, response);

  if (error) {
    Serial.printf("  ERROR: Failed to parse connect-list: %s\n", error.c_str());
    return;
  }

  if (doc.is<JsonArray>()) {
    for (JsonObject entry : doc.as<JsonArray>()) {
      String entryComment = entry["comment"] | "";
      if (entryComment == comment) {
        String entryId = entry[".id"] | "";
        if (entryId.length() > 0) {
          Serial.printf("  Deleting connect-list for SSID: %s\n", ssid.c_str());
          mikrotikRequest("DELETE", "/interface/wireless/connect-list/" + entryId, "");
        }
      }
    }
  }
}

// Ensure connection list exists for specific AP
String ensureConnectionList(String ssid, String macAddress, String interfaceName, String securityProfile) {
  String comment = String(CONNECT_LIST_COMMENT_PREFIX) + ssid;

  // First, disable all other connect-lists
  disableAllConnectionLists();

  // Check if entry already exists
  String response = mikrotikRequest("GET", "/interface/wireless/connect-list");
  DynamicJsonDocument doc(JSON_BUFFER_SECURITY_PROFILES);
  DeserializationError error = deserializeJson(doc, response);

  if (error) {
    Serial.printf("  ERROR: Failed to parse connect-list: %s\n", error.c_str());
    return "";
  }

  String existingId = "";
  if (doc.is<JsonArray>()) {
    for (JsonObject entry : doc.as<JsonArray>()) {
      String entryComment = entry["comment"] | "";
      if (entryComment == comment) {
        existingId = entry[".id"] | "";
        break;
      }
    }
  }

  // Build payload
  DynamicJsonDocument payloadDoc(JSON_BUFFER_CONNECT_PAYLOAD);
  payloadDoc["interface"] = interfaceName;
  payloadDoc["ssid"] = ssid;
  payloadDoc["mac-address"] = macAddress;
  payloadDoc["security-profile"] = securityProfile;
  payloadDoc["comment"] = comment;
  payloadDoc["disabled"] = "no";

  String payload;
  serializeJson(payloadDoc, payload);

  if (existingId.length() > 0) {
    // Update existing entry
    Serial.printf("  Updating connect-list for SSID: %s, MAC: %s\n", ssid.c_str(), macAddress.c_str());
    mikrotikRequest("PATCH", "/interface/wireless/connect-list/" + existingId, payload);
    return existingId;
  } else {
    // Create new entry
    Serial.printf("  Creating connect-list for SSID: %s, MAC: %s\n", ssid.c_str(), macAddress.c_str());
    mikrotikRequest("POST", "/interface/wireless/connect-list/add", payload);
    return comment;
  }
}

// Note: tmpfs management removed - writing directly to main storage instead

// ==================== API HANDLER ====================

void handleConfig() {
  // Return configured band modes and runtime parameters to the frontend
  StaticJsonDocument<256> doc;
  doc["band_2ghz"] = runtimeConfig.band2ghz;
  doc["band_5ghz"] = runtimeConfig.band5ghz;
  doc["scan_duration_ms"] = runtimeConfig.scanDurationSeconds * 1000;
  doc["scan_min_ready_ms"] = runtimeConfig.scanDurationSeconds * 1000;
  doc["scan_result_grace_ms"] = SCAN_RESULT_GRACE_MS;
  doc["scan_timeout_ms"] = runtimeConfig.scanDurationSeconds * 1000 + SCAN_RESULT_GRACE_MS + SCAN_POLL_INTERVAL_MS;
  doc["scan_poll_interval_ms"] = SCAN_POLL_INTERVAL_MS;
  doc["scan_csv_filename"] = SCAN_CSV_FILENAME;
  doc["signal_min_dbm"] = SIGNAL_MIN_DBM;
  doc["signal_max_dbm"] = SIGNAL_MAX_DBM;

  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleSettingsGet() {
  DynamicJsonDocument doc(1024);

  JsonObject wifiObj = doc.createNestedObject("wifi");
  wifiObj["ssid"] = runtimeConfig.wifiSsid;
  wifiObj["has_password"] = runtimeConfig.wifiPassword.length() > 0;

  JsonObject mikrotikObj = doc.createNestedObject("mikrotik");
  mikrotikObj["ip"] = runtimeConfig.mikrotikIp;
  mikrotikObj["user"] = runtimeConfig.mikrotikUser;
  mikrotikObj["has_password"] = runtimeConfig.mikrotikPass.length() > 0;
  mikrotikObj["wlan_interface"] = runtimeConfig.mikrotikWlanInterface;

  JsonObject bandsObj = doc.createNestedObject("bands");
  bandsObj["band_2ghz"] = runtimeConfig.band2ghz;
  bandsObj["band_5ghz"] = runtimeConfig.band5ghz;
  bandsObj["channel_width_2ghz"] = runtimeConfig.channelWidth2ghz;
  bandsObj["channel_width_5ghz"] = runtimeConfig.channelWidth5ghz;

  JsonObject scanObj = doc.createNestedObject("scan");
  scanObj["duration_seconds"] = runtimeConfig.scanDurationSeconds;

  JsonObject wirelessObj = doc.createNestedObject("wireless");
  wirelessObj["station_roaming"] = runtimeConfig.stationRoaming;

  JsonObject statusObj = doc.createNestedObject("status");
  statusObj["wifi_connected"] = WiFi.status() == WL_CONNECTED;
  statusObj["captive_portal"] = captivePortalActive;
  statusObj["ap_ssid"] = CAPTIVE_PORTAL_SSID;

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleSettingsUpdate() {
  String body = server.arg("plain");

  DynamicJsonDocument doc(1536);
  DeserializationError error = deserializeJson(doc, body);
  if (error) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }

  bool wifiChanged = false;
  bool mikrotikChanged = false;
  bool bandsChanged = false;
  bool scanChanged = false;
  bool wirelessChanged = false;

  JsonObject wifiObj = doc["wifi"].as<JsonObject>();
  if (!wifiObj.isNull()) {
    if (wifiObj.containsKey("ssid")) {
      String newSsid = wifiObj["ssid"].as<String>();
      newSsid.trim();
      runtimeConfig.wifiSsid = newSsid;
      wifiChanged = true;
    }
    if (wifiObj.containsKey("password")) {
      if (wifiObj["password"].is<String>()) {
        runtimeConfig.wifiPassword = wifiObj["password"].as<String>();
        wifiChanged = true;
      }
    }
  }

  JsonObject mikrotikObj = doc["mikrotik"].as<JsonObject>();
  if (!mikrotikObj.isNull()) {
    if (mikrotikObj.containsKey("ip")) {
      String newIp = mikrotikObj["ip"].as<String>();
      newIp.trim();
      runtimeConfig.mikrotikIp = newIp;
      mikrotikChanged = true;
    }
    if (mikrotikObj.containsKey("user")) {
      String newUser = mikrotikObj["user"].as<String>();
      newUser.trim();
      runtimeConfig.mikrotikUser = newUser;
      mikrotikChanged = true;
    }
    if (mikrotikObj.containsKey("password")) {
      if (mikrotikObj["password"].is<String>()) {
        runtimeConfig.mikrotikPass = mikrotikObj["password"].as<String>();
        mikrotikChanged = true;
      }
    }
    if (mikrotikObj.containsKey("wlan_interface")) {
      String newIface = mikrotikObj["wlan_interface"].as<String>();
      newIface.trim();
      runtimeConfig.mikrotikWlanInterface = newIface;
      mikrotikChanged = true;
    }
  }

  JsonObject bandsObj = doc["bands"].as<JsonObject>();
  if (!bandsObj.isNull()) {
    if (bandsObj.containsKey("band_2ghz")) {
      String newBand2 = bandsObj["band_2ghz"].as<String>();
      newBand2.trim();
      runtimeConfig.band2ghz = newBand2;
      bandsChanged = true;
    }
    if (bandsObj.containsKey("band_5ghz")) {
      String newBand5 = bandsObj["band_5ghz"].as<String>();
      newBand5.trim();
      runtimeConfig.band5ghz = newBand5;
      bandsChanged = true;
    }
    if (bandsObj.containsKey("channel_width_2ghz")) {
      String newCw2 = bandsObj["channel_width_2ghz"].as<String>();
      newCw2.trim();
      runtimeConfig.channelWidth2ghz = newCw2;
      bandsChanged = true;
    }
    if (bandsObj.containsKey("channel_width_5ghz")) {
      String newCw5 = bandsObj["channel_width_5ghz"].as<String>();
      newCw5.trim();
      runtimeConfig.channelWidth5ghz = newCw5;
      bandsChanged = true;
    }
  }

  JsonObject scanObj = doc["scan"].as<JsonObject>();
  if (!scanObj.isNull()) {
    if (scanObj.containsKey("duration_seconds")) {
      int newDuration = scanObj["duration_seconds"] | runtimeConfig.scanDurationSeconds;
      if (newDuration <= 0) {
        server.send(400, "application/json", "{\"error\":\"invalid_scan_duration\"}");
        return;
      }
      runtimeConfig.scanDurationSeconds = newDuration;
      scanChanged = true;
    }
  }

  JsonObject wirelessObj = doc["wireless"].as<JsonObject>();
  if (!wirelessObj.isNull()) {
    if (wirelessObj.containsKey("station_roaming")) {
      runtimeConfig.stationRoaming = wirelessObj["station_roaming"] | runtimeConfig.stationRoaming;
      wirelessChanged = true;
    }
  }

  if (!(wifiChanged || mikrotikChanged || bandsChanged || wirelessChanged)) {
    DynamicJsonDocument response(128);
    response["success"] = true;
    response["wifi_changed"] = false;
    response["mikrotik_changed"] = false;
    response["bands_changed"] = false;
    response["captive_portal"] = captivePortalActive;
    String output;
    serializeJson(response, output);
    server.send(200, "application/json", output);
    return;
  }

  if (!saveRuntimeConfigToFile()) {
    server.send(500, "application/json", "{\"error\":\"Failed to save configuration\"}");
    return;
  }

  if (wifiChanged) {
    wifiReconnectPending = true;
    lastReconnectAttempt = 0;
    startCaptivePortal();
  }

  DynamicJsonDocument response(256);
  response["success"] = true;
  response["wifi_changed"] = wifiChanged;
  response["mikrotik_changed"] = mikrotikChanged;
  response["bands_changed"] = bandsChanged;
  response["scan_changed"] = scanChanged;
  response["wireless_changed"] = wirelessChanged;
  response["captive_portal"] = captivePortalActive;

  String output;
  serializeJson(response, output);
  server.send(200, "application/json", output);
}

// ==================== OTA SUPPORT ====================

void setupArduinoOTA() {
  if (!OTA_ENABLE || otaServiceReady || WiFi.status() != WL_CONNECTED) {
    return;
  }

  ArduinoOTA.setHostname(OTA_HOSTNAME);
  if (OTA_PASSWORD != nullptr && OTA_PASSWORD[0] != '\0') {
    ArduinoOTA.setPassword(OTA_PASSWORD);
  }

  ArduinoOTA.onStart([]() {
    const char* type = ArduinoOTA.getCommand() == U_FLASH ? "firmware" : "filesystem";
    Serial.printf("ArduinoOTA update started (%s)\n", type);
  });

  ArduinoOTA.onEnd([]() {
    Serial.println("ArduinoOTA update finished, restarting...");
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    if (total == 0) {
      return;
    }
    unsigned int percent = (progress * 100U) / total;
    Serial.printf("ArduinoOTA progress: %u%%\n", percent);
  });

  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("ArduinoOTA error[%u]\n", static_cast<unsigned int>(error));
    switch (error) {
      case OTA_AUTH_ERROR:
        Serial.println("  → Auth failed");
        break;
      case OTA_BEGIN_ERROR:
        Serial.println("  → Begin failed");
        break;
      case OTA_CONNECT_ERROR:
        Serial.println("  → Connect failed");
        break;
      case OTA_RECEIVE_ERROR:
        Serial.println("  → Receive failed");
        break;
      case OTA_END_ERROR:
        Serial.println("  → Finalize failed");
        break;
      default:
        Serial.println("  → Unknown error");
        break;
    }
  });

  ArduinoOTA.begin();
  otaServiceReady = true;
  Serial.printf("ArduinoOTA ready (hostname: %s)\n", OTA_HOSTNAME);
}

void handleStatus() {
  if (!ensureOperationAllowed()) return;
  // Fetch required data from MikroTik
  String interfacesResp = mikrotikRequest("GET", "/interface/wireless");
  String registrationResp = mikrotikRequest("GET", "/interface/wireless/registration-table");
  String addressesResp = mikrotikRequest("GET", "/ip/address");
  String routesResp = mikrotikRequest("GET", "/ip/route");
  String dnsResp = mikrotikRequest("GET", "/ip/dns");

  // Minimal JSON wrapper without parsing (string concatenation)
  String output = "{\"interfaces\":";
  output += interfacesResp;
  output += ",\"registration\":";
  output += registrationResp;
  output += ",\"addresses\":";
  output += addressesResp;
  output += ",\"routes\":";
  output += routesResp;
  output += ",\"dns\":";
  output += dnsResp;
  output += "}";

  server.send(200, "application/json", output);
}

void handleScanStart() {
  if (!ensureOperationAllowed()) return;
  String band = server.arg("band");
  if (band == "") band = runtimeConfig.band2ghz;

  // Check if a scan is already running
  if (scanState.isScanning) {
    unsigned long elapsedMs = millis() - scanState.startTime;
    unsigned long timeoutMs = scanState.resultTimeoutMs > 0 ? scanState.resultTimeoutMs
                                                             : (static_cast<unsigned long>(runtimeConfig.scanDurationSeconds) * 1000UL + SCAN_RESULT_GRACE_MS + SCAN_POLL_INTERVAL_MS);

    // If the scan is too old, reset it (cleanup abandoned scans)
    if (elapsedMs > timeoutMs) {
      Serial.printf("Scan state expired (elapsed: %lu ms, timeout: %lu ms) - resetting\n", elapsedMs, timeoutMs);
      scanState.isScanning = false;
      scanState.hasResult = false;
      scanState.result = "";
      // Continue with new scan below
    } else {
      // Scan is still valid, return info to client
      StaticJsonDocument<256> doc;
      doc["status"] = "already_scanning";
      doc["elapsed_ms"] = elapsedMs;
      doc["duration_ms"] = scanState.expectedDurationMs;
      doc["min_ready_ms"] = scanState.minReadyMs;
      doc["timeout_ms"] = scanState.resultTimeoutMs;
      doc["poll_interval_ms"] = scanState.pollIntervalMs;
      doc["csv_filename"] = scanState.csvFilename;
      String response;
      serializeJson(doc, response);
      server.send(200, "application/json", response);
      return;
    }
  }

  String wlanId;
  String currentBand;
  if (!fetchConfiguredWirelessInterface(wlanId, currentBand)) {
    server.send(404, "application/json", "{\"error\":\"Configured WLAN interface not found\"}");
    return;
  }
  String wlanName = runtimeConfig.mikrotikWlanInterface;

  // Switch MikroTik band if necessary
  if (band.length() > 0 && currentBand != band) {
    DynamicJsonDocument bandDoc(JSON_BUFFER_SECURITY_PAYLOAD);
    bandDoc["band"] = band;
    // Set matching channel-width to avoid invalid combinations (e.g. 80MHz on 2.4GHz)
    bool is5ghz = band.startsWith("5ghz");
    String channelWidth = is5ghz ? runtimeConfig.channelWidth5ghz : runtimeConfig.channelWidth2ghz;
    if (channelWidth.length() > 0) {
      bandDoc["channel-width"] = channelWidth;
    }
    String bandPayload;
    serializeJson(bandDoc, bandPayload);
    mikrotikRequest("PATCH", "/interface/wireless/" + wlanId, bandPayload);
    delay(500);
  }

  // Update scan state before triggering (clear any cached results)
  scanState.isScanning = true;
  scanState.hasResult = false;
  scanState.result = "";
  scanState.resultTimestamp = 0;
  scanState.startTime = millis();
  scanState.band = band;
  scanState.csvFilename = SCAN_CSV_FILENAME;
  scanState.expectedDurationMs = static_cast<unsigned long>(runtimeConfig.scanDurationSeconds) * 1000UL;
  scanState.minReadyMs = scanState.expectedDurationMs;
  scanState.pollIntervalMs = SCAN_POLL_INTERVAL_MS;
  scanState.resultTimeoutMs = scanState.expectedDurationMs +
                              static_cast<unsigned long>(SCAN_RESULT_GRACE_MS) +
                              scanState.pollIntervalMs;

  // Trigger scan on MikroTik with a very short timeout
  // Response is irrelevant; MikroTik continues the scan and CSV is fetched later
  DynamicJsonDocument scanDoc(JSON_BUFFER_SCAN_REQUEST);
  scanDoc[".id"] = wlanId;  // Use interface ID (e.g. "*3"), not name (e.g. "wlan2")
  scanDoc["duration"] = String(runtimeConfig.scanDurationSeconds);
  scanDoc["save-file"] = scanState.csvFilename;

  String scanBody;
  serializeJson(scanDoc, scanBody);

  // Short timeout (500ms) just to trigger; response is ignored
  mikrotikRequest("POST", "/interface/wireless/scan", scanBody, 500);

  // Immediately confirm that the scan started
  StaticJsonDocument<160> responseDoc;
  responseDoc["status"] = "started";
  responseDoc["duration_ms"] = scanState.expectedDurationMs;
  responseDoc["min_ready_ms"] = scanState.minReadyMs;
  responseDoc["timeout_ms"] = scanState.resultTimeoutMs;
  responseDoc["poll_interval_ms"] = scanState.pollIntervalMs;
  responseDoc["csv_filename"] = scanState.csvFilename;

  String response;
  serializeJson(responseDoc, response);
  server.send(200, "application/json", response);
}

// Helper: Read FTP response line
String ftpReadLine(WiFiClient &client, unsigned long timeoutMs = 2000) {
  unsigned long start = millis();
  while (!client.available() && (millis() - start < timeoutMs)) {
    delay(10);
  }
  if (client.available()) {
    return client.readStringUntil('\n');
  }
  return "";
}

// Download file via FTP and stream directly to output WiFiClient
// Returns number of bytes streamed, or 0 on error
size_t ftpDownloadFileStream(const char* filename, WiFiClient &outputClient, unsigned long timeoutMs = 8000) {
  WiFiClient ftpClient;
  WiFiClient ftpDataClient;

  Serial.printf("FTP: Connecting to %s:21...\n", runtimeConfig.mikrotikIp.c_str());

  if (!ftpClient.connect(runtimeConfig.mikrotikIp.c_str(), 21)) {
    Serial.println("FTP: Connection failed");
    return 0;
  }

  ftpClient.setTimeout(2000);

  // Read welcome
  String welcome = ftpReadLine(ftpClient);
  Serial.printf("FTP: %s\n", welcome.c_str());

  // Login
  ftpClient.printf("USER %s\r\n", runtimeConfig.mikrotikUser.c_str());
  ftpReadLine(ftpClient);

  ftpClient.printf("PASS %s\r\n", runtimeConfig.mikrotikPass.c_str());
  String loginResp = ftpReadLine(ftpClient);
  if (!loginResp.startsWith("230")) {
    Serial.printf("FTP: Login failed: %s\n", loginResp.c_str());
    ftpClient.stop();
    return 0;
  }

  // Enter passive mode
  ftpClient.print("PASV\r\n");
  String pasvResponse = ftpReadLine(ftpClient);
  Serial.printf("FTP PASV: %s\n", pasvResponse.c_str());

  // Parse PASV response: 227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)
  int dataPort = 0;
  int startIdx = pasvResponse.indexOf('(');
  int endIdx = pasvResponse.indexOf(')');
  if (startIdx > 0 && endIdx > startIdx) {
    String portInfo = pasvResponse.substring(startIdx + 1, endIdx);
    int lastComma = portInfo.lastIndexOf(',');
    int secondLastComma = portInfo.lastIndexOf(',', lastComma - 1);
    if (lastComma > 0 && secondLastComma > 0) {
      int p1 = portInfo.substring(secondLastComma + 1, lastComma).toInt();
      int p2 = portInfo.substring(lastComma + 1).toInt();
      dataPort = p1 * 256 + p2;
      Serial.printf("FTP: Data port: %d\n", dataPort);
    }
  }

  if (dataPort == 0) {
    Serial.println("FTP: Failed to parse PASV response");
    ftpClient.stop();
    return 0;
  }

  // Connect data channel
  if (!ftpDataClient.connect(runtimeConfig.mikrotikIp.c_str(), dataPort)) {
    Serial.println("FTP: Data connection failed");
    ftpClient.stop();
    return 0;
  }

  // Request file
  ftpClient.printf("RETR %s\r\n", filename);
  String retrResp = ftpReadLine(ftpClient);
  Serial.printf("FTP RETR: %s\n", retrResp.c_str());
  if (!retrResp.startsWith("150") && !retrResp.startsWith("125")) {
    Serial.println("FTP: RETR failed");
    ftpDataClient.stop();
    ftpClient.stop();
    return 0;
  }

  // Stream file content directly to output client
  unsigned long start = millis();
  ftpDataClient.setTimeout(1000);
  size_t totalBytes = 0;
  uint8_t buffer[512];

  while (ftpDataClient.connected() || ftpDataClient.available()) {
    if (millis() - start > timeoutMs) {
      Serial.println("FTP: Download timeout");
      break;
    }

    if (ftpDataClient.available()) {
      int bytesRead = ftpDataClient.read(buffer, sizeof(buffer));
      if (bytesRead > 0) {
        outputClient.write(buffer, bytesRead);
        totalBytes += bytesRead;
        start = millis();  // Reset timeout
      }
    } else {
      delay(1);
    }
  }

  Serial.printf("FTP: Streamed %d bytes\n", totalBytes);

  ftpDataClient.stop();
  ftpReadLine(ftpClient);  // Read transfer complete message
  ftpClient.print("QUIT\r\n");
  ftpClient.stop();

  return totalBytes;
}

void handleScanResult() {
  if (!ensureOperationAllowed()) return;

  // Serve cached result if one exists
  if (scanState.hasResult) {
    unsigned long cacheAge = millis() - scanState.resultTimestamp;

    // Check if cache is still valid
    if (cacheAge <= SCAN_RESULT_CACHE_MS) {
      // Cache still valid, serve result (can be retrieved multiple times)
      server.send(200, "application/json", scanState.result);
      return;
    } else {
      // Cache expired, clean up
      Serial.printf("Scan result cache expired (age: %lu ms) - cleaning up\n", cacheAge);
      scanState.hasResult = false;
      scanState.result = "";
      scanState.isScanning = false;
      // Fall through to "no_result" response
    }
  }

  // If no scan is running, return informative status
  if (!scanState.isScanning) {
    server.send(200, "application/json", "{\"status\":\"no_result\",\"error\":\"No scan in progress\"}");
    return;
  }

  // Skip CSV lookup until the expected MikroTik scan duration elapsed
  unsigned long elapsedMs = millis() - scanState.startTime;
  unsigned long minReadyMs = scanState.minReadyMs > 0 ? scanState.minReadyMs
                                                     : static_cast<unsigned long>(runtimeConfig.scanDurationSeconds) * 1000UL;
  unsigned long timeoutMs = scanState.resultTimeoutMs > 0 ? scanState.resultTimeoutMs
                                                          : (minReadyMs + SCAN_RESULT_GRACE_MS + SCAN_POLL_INTERVAL_MS);

  if (elapsedMs < minReadyMs) {
    server.send(200, "application/json", "{\"status\":\"pending\"}");
    return;
  }

  // Timeout guard - only after minimum scan duration has passed
  if (elapsedMs > timeoutMs) {
    Serial.printf("  Scan timeout after %lu ms (limit %lu ms)\n", elapsedMs, timeoutMs);
    scanState.isScanning = false;
    server.send(200, "application/json", "{\"status\":\"timeout\",\"error\":\"Scan result file not found after timeout - check MikroTik scan configuration\"}");
    return;
  }

  // Try to download CSV directly via FTP (no need to check via REST API first)
  String expectedFile = scanState.csvFilename.length() > 0 ? scanState.csvFilename : String(SCAN_CSV_FILENAME);
  Serial.printf("  Attempting FTP download of: %s\n", expectedFile.c_str());

  // Get profiles for metadata
  DynamicJsonDocument profilesDoc(JSON_BUFFER_SCAN_RESPONSE);
  String profilesResponse = mikrotikRequest("GET", "/interface/wireless/security-profiles");
  deserializeJson(profilesDoc, profilesResponse);

  // Build profiles JSON manually
  String profilesJson = "[";
  bool firstProfile = true;
  if (profilesDoc.is<JsonArray>()) {
    for (JsonObject profile : profilesDoc.as<JsonArray>()) {
      String comment = profile["comment"] | "";
      if (comment.startsWith(PROFILE_COMMENT_PREFIX)) {
        if (!firstProfile) profilesJson += ",";
        firstProfile = false;

        String ssid = comment.substring(strlen(PROFILE_COMMENT_PREFIX));
        String name = profile["name"] | "";
        String mode = profile["mode"] | "";
        String authTypes = profile["authentication-types"] | "";

        // Escape JSON strings
        ssid.replace("\"", "\\\"");
        name.replace("\"", "\\\"");
        mode.replace("\"", "\\\"");
        authTypes.replace("\"", "\\\"");

        profilesJson += "{";
        profilesJson += "\"ssid\":\"" + ssid + "\",";
        profilesJson += "\"name\":\"" + name + "\",";
        profilesJson += "\"mode\":\"" + mode + "\",";
        profilesJson += "\"authentication-types\":\"" + authTypes + "\"";
        profilesJson += "}";
      }
    }
  }
  profilesJson += "]";

  // First, check if CSV file exists by trying a quick FTP download
  // We must check BEFORE sending HTTP headers!
  size_t csvBytes = 0;
  bool ftpConnected = false;
  WiFiClient ftpClient;
  WiFiClient ftpDataClient;
  int dataPort = 0;

  {
    // Quick FTP check
    if (ftpClient.connect(runtimeConfig.mikrotikIp.c_str(), 21)) {
      ftpClient.setTimeout(2000);
      ftpReadLine(ftpClient);  // Welcome
      ftpClient.printf("USER %s\r\n", runtimeConfig.mikrotikUser.c_str());
      ftpReadLine(ftpClient);
      ftpClient.printf("PASS %s\r\n", runtimeConfig.mikrotikPass.c_str());
      String loginResp = ftpReadLine(ftpClient);

      if (loginResp.startsWith("230")) {
        ftpClient.print("PASV\r\n");
        String pasvResp = ftpReadLine(ftpClient);

        int startIdx = pasvResp.indexOf('(');
        int endIdx = pasvResp.indexOf(')');
        if (startIdx > 0 && endIdx > startIdx) {
          String portInfo = pasvResp.substring(startIdx + 1, endIdx);
          int lastComma = portInfo.lastIndexOf(',');
          int secondLastComma = portInfo.lastIndexOf(',', lastComma - 1);
          if (lastComma > 0 && secondLastComma > 0) {
            int p1 = portInfo.substring(secondLastComma + 1, lastComma).toInt();
            int p2 = portInfo.substring(lastComma + 1).toInt();
            dataPort = p1 * 256 + p2;
          }
        }

        if (dataPort > 0 && ftpDataClient.connect(runtimeConfig.mikrotikIp.c_str(), dataPort)) {
          ftpClient.printf("RETR %s\r\n", expectedFile.c_str());
          String retrResp = ftpReadLine(ftpClient);

          // Check if file exists (150 = file status ok, starting transfer)
          if (retrResp.startsWith("150")) {
            ftpConnected = true;
            // Keep connections open for streaming
          } else {
            // File doesn't exist yet
            ftpDataClient.stop();
            ftpClient.print("QUIT\r\n");
            ftpClient.stop();
            Serial.println("  CSV not available yet - returning pending");
            scanState.isScanning = true;  // Keep scanning state
            server.send(200, "application/json", "{\"status\":\"pending\"}");
            return;
          }
        }
      }
    }
  }

  if (!ftpConnected) {
    Serial.println("  FTP connection failed - returning pending");
    scanState.isScanning = true;
    server.send(200, "application/json", "{\"status\":\"pending\"}");
    return;
  }

  // FTP is connected and file exists - now we can start streaming HTTP response
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json", "");

  // Send JSON prefix
  String band = scanState.band;
  band.replace("\"", "\\\"");
  server.sendContent("{\"csv\":\"");

  // Stream CSV via FTP (already connected), escaping special JSON characters on the fly
  {
    // Stream and escape
    unsigned long start = millis();
    uint8_t buffer[256];
    String chunk;  // Accumulate escaped data before sending
    chunk.reserve(512);  // Pre-allocate to reduce reallocations

    while ((ftpDataClient.connected() || ftpDataClient.available()) && (millis() - start < 8000)) {
      if (ftpDataClient.available()) {
        int bytesRead = ftpDataClient.read(buffer, sizeof(buffer));
        if (bytesRead > 0) {
          // Escape JSON special characters: \ " \n \r \t
          for (int i = 0; i < bytesRead; i++) {
            char c = buffer[i];
            if (c == '\\' || c == '\"') {
              chunk += '\\';
              chunk += c;
            } else if (c == '\n') {
              chunk += "\\n";
            } else if (c == '\r') {
              chunk += "\\r";
            } else if (c == '\t') {
              chunk += "\\t";
            } else {
              chunk += c;
            }
            csvBytes++;

            // Send chunk every 256 bytes to avoid too much buffering
            if (chunk.length() >= 256) {
              server.sendContent(chunk);
              chunk = "";
            }
          }
          start = millis();
        }
      } else {
        delay(1);
      }
    }

    // Send any remaining data
    if (chunk.length() > 0) {
      server.sendContent(chunk);
    }

    ftpDataClient.stop();
    ftpClient.print("QUIT\r\n");
    ftpClient.stop();
  }

  Serial.printf("  Streamed %d CSV bytes\n", csvBytes);

  // Send JSON suffix
  server.sendContent("\",\"band\":\"" + band + "\",\"profiles\":" + profilesJson + "}");

  // Mark scan complete
  scanState.isScanning = false;
  scanState.hasResult = false;  // Don't cache streamed responses

  // Note: CSV file is kept on MikroTik for multiple clients to retrieve
  // It will be overwritten on next scan (same filename)
}

void handleConnect() {
  if (!ensureOperationAllowed()) return;
  String body = server.arg("plain");

  DynamicJsonDocument doc(JSON_BUFFER_CONNECT_REQUEST);
  deserializeJson(doc, body);

  String ssid = doc["ssid"] | "";
  String password = doc["password"] | "";
  String band = String(doc["band"] | runtimeConfig.band2ghz);
  bool requiresPassword = doc["requiresPassword"] | true;
  bool known = doc["known"] | false;
  String profileName = doc["profileName"] | "";
  bool connectToSpecificAp = doc["connectToSpecificAp"] | false;
  String apMacAddress = doc["apMacAddress"] | "";

  // Create or update security profile
  String profileNameResult = ensureSecurityProfile(ssid, password, requiresPassword, known, profileName);

  String wlanId;
  String currentBand;
  if (!fetchConfiguredWirelessInterface(wlanId, currentBand)) {
    server.send(404, "application/json", "{\"error\":\"Configured WLAN interface not found\"}");
    return;
  }

  String wlanName = runtimeConfig.mikrotikWlanInterface;

  // Handle Connection List
  if (connectToSpecificAp && apMacAddress.length() > 0) {
    // Connect to specific AP using Connection List
    Serial.println("  Connecting to specific AP via Connection List");
    ensureConnectionList(ssid, apMacAddress, wlanName, profileNameResult);

    // Configure interface with station-roaming disabled (required for connect-list)
    DynamicJsonDocument configDoc(JSON_BUFFER_CONNECT_PAYLOAD);
    configDoc["mode"] = "station";
    configDoc["band"] = band;
    configDoc["security-profile"] = profileNameResult;
    configDoc["station-roaming"] = "disabled";
    configDoc["disabled"] = "no";

    String config;
    serializeJson(configDoc, config);
    mikrotikRequest("PATCH", "/interface/wireless/" + wlanId, config);
  } else {
    // Normal connection (no specific AP)
    Serial.println("  Connecting to any AP for SSID");

    // Delete any existing connection list for this SSID
    deleteConnectionList(ssid);

    // Configure interface with user's station-roaming preference
    DynamicJsonDocument configDoc(JSON_BUFFER_CONNECT_PAYLOAD);
    configDoc["mode"] = "station";
    configDoc["ssid"] = ssid;
    configDoc["band"] = band;
    configDoc["security-profile"] = profileNameResult;
    configDoc["station-roaming"] = runtimeConfig.stationRoaming ? "enabled" : "disabled";
    configDoc["disabled"] = "no";

    String config;
    serializeJson(configDoc, config);
    mikrotikRequest("PATCH", "/interface/wireless/" + wlanId, config);
  }

  server.send(200, "application/json", "{\"success\":true}");
}

void handleDeleteProfile() {
  if (!ensureOperationAllowed()) return;
  String body = server.arg("plain");

  DynamicJsonDocument doc(JSON_BUFFER_CONNECT_REQUEST);
  DeserializationError parseError = deserializeJson(doc, body);
  if (parseError) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }

  String profileName = doc["profileName"] | "";
  String ssid = doc["ssid"] | "";

  if (profileName.length() == 0 && ssid.length() == 0) {
    server.send(400, "application/json", "{\"error\":\"Missing profileName or ssid\"}");
    return;
  }

  DynamicJsonDocument profilesDoc(JSON_BUFFER_SECURITY_PROFILES);
  String profilesResponse = mikrotikRequest("GET", "/interface/wireless/security-profiles");
  DeserializationError error = deserializeJson(profilesDoc, profilesResponse);
  if (error) {
    Serial.printf("  ERROR: Failed to parse profiles for deletion: %s\n", error.c_str());
    server.send(500, "application/json", "{\"error\":\"Failed to read profiles\"}");
    return;
  }

  String targetName = "";
  bool isManagedProfile = false;
  if (profilesDoc.is<JsonArray>()) {
    for (JsonObject profile : profilesDoc.as<JsonArray>()) {
      String pName = profile["name"] | "";
      String pComment = profile["comment"] | "";
      bool matchesComment = pComment == String(PROFILE_COMMENT_PREFIX) + ssid;
      if (profileName.length() > 0 && pName == profileName && matchesComment) {
        targetName = pName;
        isManagedProfile = true;
        break;
      }
      if (ssid.length() > 0 && matchesComment) {
        targetName = pName;
        isManagedProfile = true;
        break;
      }
    }
  }

  if (targetName.length() == 0 || !isManagedProfile) {
    server.send(404, "application/json", "{\"error\":\"Managed profile not found\"}");
    return;
  }

  String response = mikrotikRequest("DELETE", "/interface/wireless/security-profiles/" + targetName, "");

  if (response.indexOf("error") != -1) {
    Serial.printf("  ERROR: Failed to delete profile %s: %s\n", targetName.c_str(), response.c_str());
    server.send(500, "application/json", "{\"error\":\"Failed to delete profile\"}");
    return;
  }

  server.send(200, "application/json", "{\"success\":true}");
}

void handleDisconnect() {
  if (!ensureOperationAllowed()) return;
  String wlanId;
  String currentBand;
  if (!fetchConfiguredWirelessInterface(wlanId, currentBand)) {
    server.send(404, "application/json", "{\"error\":\"Configured WLAN interface not found\"}");
    return;
  }

  // Disable all connection lists (keep them for reconnection, but disable them)
  disableAllConnectionLists();

  mikrotikRequest("PATCH", "/interface/wireless/" + wlanId, "{\"disabled\":\"yes\"}");
  server.send(200, "application/json", "{\"success\":true}");
}

void handleCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(200);
}

void handleNotFound() {
  String path = server.uri();

  // Try to serve file from LittleFS
  if (handleFileRead(path)) {
    return;
  }

  // Fallback to 404
  server.send(404, "text/plain", "404: Not Found");
}

void attemptWifiConnect() {
  if (runtimeConfig.wifiSsid.length() == 0) {
    Serial.println("No WiFi SSID configured, skipping connection attempt");
    return;
  }

  WiFi.disconnect(true);
  delay(100);

  if (runtimeConfig.wifiPassword.length() > 0) {
    WiFi.begin(runtimeConfig.wifiSsid.c_str(), runtimeConfig.wifiPassword.c_str());
  } else {
    WiFi.begin(runtimeConfig.wifiSsid.c_str());
  }

  lastReconnectAttempt = millis();
}

void startCaptivePortal() {
  if (captivePortalActive) return;
  Serial.printf("Starting captive portal: SSID='%s'\n", CAPTIVE_PORTAL_SSID);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(CAPTIVE_PORTAL_SSID);
  captivePortalActive = true;
}

void stopCaptivePortal() {
  if (!captivePortalActive) return;
  Serial.println("Stopping captive portal");
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  captivePortalActive = false;
}

void handleWifiTasks() {
  static bool lastConnected = false;

  wl_status_t status = WiFi.status();
  bool connected = status == WL_CONNECTED;

  if (connected) {
    if (!lastConnected) {
      Serial.println("WiFi connected!");
      Serial.print("IP address: ");
      Serial.println(WiFi.localIP());
    }
    if (captivePortalActive) {
      stopCaptivePortal();
    }
    if (OTA_ENABLE) {
      setupArduinoOTA();
    }
    lastConnected = true;
    return;
  }

  if (lastConnected) {
    Serial.println("WiFi connection lost");
    otaServiceReady = false;
  }
  lastConnected = false;

  if (runtimeConfig.wifiSsid.length() == 0) {
    if (!captivePortalActive) {
      startCaptivePortal();
    }
    return;
  }

  if (!captivePortalActive) {
    startCaptivePortal();
  }

  unsigned long now = millis();
  if (wifiReconnectPending || now - lastReconnectAttempt > WIFI_RECONNECT_INTERVAL_MS) {
    attemptWifiConnect();
    wifiReconnectPending = false;
  }
}

// ==================== SETUP & LOOP ====================

void setup() {
  Serial.begin(115200);
  delay(1000);  // Wait for USB-CDC connection

  // Wait for Serial to become available (max 3 seconds)
  unsigned long start = millis();
  while (!Serial && (millis() - start < 3000)) {
    delay(100);
  }

  Serial.println("\n\n=== MikroTik WiFi Manager (ESP32-S2) ===");

  // Initialize LittleFS
  Serial.println("Initializing LittleFS...");
  bool fsAvailable = false;
  if (!LittleFS.begin(true)) {
    Serial.println("ERROR: LittleFS mount failed!");
    Serial.println("Please run 'pio run --target uploadfs'!");
  } else {
    Serial.println("LittleFS mounted successfully");
    fsAvailable = true;
    filesystemAvailable = true;
  }

  if (fsAvailable) {
    if (!loadRuntimeConfigFromFile()) {
      Serial.println("Using default configuration values (config file missing or invalid)");
    }
  } else {
    applyDefaultConfig(runtimeConfig);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);

  if (runtimeConfig.wifiSsid.length() > 0) {
    attemptWifiConnect();
    unsigned long connectStart = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - connectStart < WIFI_INITIAL_CONNECT_TIMEOUT_MS) {
      delay(250);
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("WiFi connected!");
      Serial.print("IP address: ");
      Serial.println(WiFi.localIP());
      lastReconnectAttempt = millis();

      if (OTA_ENABLE) {
        setupArduinoOTA();
      }
    } else {
      Serial.println("Initial WiFi connection failed, enabling captive portal");
      startCaptivePortal();
      wifiReconnectPending = true;
    }
  } else {
    Serial.println("No WiFi configuration found, enabling captive portal");
    startCaptivePortal();
  }

  // Register API routes
  server.on("/api/config", HTTP_GET, handleConfig);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/scan/start", HTTP_POST, handleScanStart);
  server.on("/api/scan/result", HTTP_GET, handleScanResult);
  server.on("/api/connect", HTTP_POST, handleConnect);
  server.on("/api/disconnect", HTTP_POST, handleDisconnect);
  server.on("/api/profile/delete", HTTP_POST, handleDeleteProfile);
  server.on("/api/settings", HTTP_GET, handleSettingsGet);
  server.on("/api/settings", HTTP_POST, handleSettingsUpdate);

  // CORS preflight handlers
  server.on("/api/config", HTTP_OPTIONS, handleCORS);
  server.on("/api/status", HTTP_OPTIONS, handleCORS);
  server.on("/api/scan/start", HTTP_OPTIONS, handleCORS);
  server.on("/api/scan/result", HTTP_OPTIONS, handleCORS);
  server.on("/api/connect", HTTP_OPTIONS, handleCORS);
  server.on("/api/disconnect", HTTP_OPTIONS, handleCORS);
  server.on("/api/profile/delete", HTTP_OPTIONS, handleCORS);
  server.on("/api/settings", HTTP_OPTIONS, handleCORS);

  // Catch-all for static files
  server.onNotFound(handleNotFound);

  server.begin();
  Serial.printf("Web server started on port %d\n", WEB_PORT);
  Serial.println("\n=== Ready! ===");
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("Open: http://%s/\n\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.printf("Configure via captive portal SSID '%s' (default IP 192.168.4.1)\n\n", CAPTIVE_PORTAL_SSID);
  }
}

void loop() {
  server.handleClient();
  handleWifiTasks();
  if (OTA_ENABLE && otaServiceReady) {
    ArduinoOTA.handle();
  }
  delay(2);
}
