/**
 * MikroTik WiFi Manager for ESP32 - optimized variant.
 *
 * PlatformIO project
 *
 * Installation:
 * 1. Copy src/config.h.example to src/config.h
 * 2. Adjust src/config.h (WiFi, MikroTik IP, token)
 * 3. pio run --target uploadfs  (uploads data/ directory)
 * 4. pio run --target upload    (uploads firmware)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <base64.h>
#include <LittleFS.h>

// Load configuration from separate header
#include "config.h"

// ==================== CONSTANTS ====================

const char* PROFILE_COMMENT_PREFIX = "wifi-manager:ssid=";

// ==================== GLOBAL VARIABLES ====================

WebServer server(WEB_PORT);

// Scan State Management
struct ScanState {
  bool isScanning = false;
  bool hasResult = false;
  String result = "";
  unsigned long startTime = 0;
  String wlanName = "";
  String band = "";
  String csvFilename = "tmp1/wlan-scan.csv";
};

ScanState scanState;

// ==================== HELPER FUNCTIONS ====================

bool asBool(String value) {
  value.toLowerCase();
  value.trim();
  return (value == "true" || value == "yes" || value == "on" ||
          value == "1" || value == "running" || value == "enabled");
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
  Serial.println("handleFileRead: " + path);

  if (path.endsWith("/")) {
    path += "index.html";
  }

  // LittleFS expects paths WITH a leading slash
  if (!path.startsWith("/")) {
    path = "/" + path;
  }

  String contentType = getContentType(path);

  Serial.println("  Versuche zu oeffnen: " + path);
  if (LittleFS.exists(path)) {
    File file = LittleFS.open(path, "r");
    if (file) {
      Serial.println("  ✓ Datei gefunden, sende...");
      server.streamFile(file, contentType);
      file.close();
      return true;
    }
  }

  Serial.println("  ✗ Datei nicht gefunden: " + path);
  return false;
}

// ==================== MIKROTIK API HELPERS ====================

String mikrotikRequest(String method, String path, String jsonBody = "", int timeoutMs = 15000) {
  HTTPClient http;
  http.setTimeout(timeoutMs);

  // Use HTTP instead of HTTPS to keep RAM usage low
  String url = "http://" + String(MIKROTIK_IP) + "/rest" + path;

  http.begin(url);

  // Authentication: prefer API token, fallback to Basic Auth
  if (strlen(MIKROTIK_TOKEN) > 0) {
    http.addHeader("Authorization", "Bearer " + String(MIKROTIK_TOKEN));
  } else {
    String auth = String(MIKROTIK_USER) + ":" + String(MIKROTIK_PASS);
    String authEncoded = base64::encode(auth);
    http.addHeader("Authorization", "Basic " + authEncoded);
  }

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
    Serial.printf("  → MikroTik: %s %s → %d\n", method.c_str(), path.c_str(), httpCode);
  } else {
    Serial.printf("  → MikroTik ERROR: %s\n", http.errorToString(httpCode).c_str());
    response = "{\"error\":\"Request failed\"}";
  }

  http.end();
  return response;
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
  DynamicJsonDocument profilesDoc(12288);  // 12KB for multiple profiles
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
    Serial.printf("  Checking %d existing profiles...\n", profilesDoc.as<JsonArray>().size());
    for (JsonObject profile : profilesDoc.as<JsonArray>()) {
      String pName = profile["name"] | "";
      String pComment = profile["comment"] | "";
      String pMode = profile["mode"] | "";
      Serial.printf("    - Profile: %s, mode=%s, comment=%s\n", pName.c_str(), pMode.c_str(), pComment.c_str());
      if (pName == profileName || pComment == comment) {
        targetProfile = profile;
        existingMode = profile["mode"] | "";
        Serial.printf("  ✓ Found matching profile: %s (mode=%s)\n", pName.c_str(), existingMode.c_str());
        break;
      }
    }
  }

  // Determine desired security mode
  String desiredMode = requiresPassword ? "dynamic-keys" : "none";
  Serial.printf("  Desired mode: %s (requiresPassword=%d, password.length=%d)\n",
                desiredMode.c_str(), requiresPassword, password.length());

  // If profile exists but mode differs -> delete and recreate
  bool needsRecreate = false;
  if (!targetProfile.isNull() && existingMode != desiredMode) {
    Serial.printf("  ⚠ Security mode changed: %s -> %s. Recreating profile.\n",
                  existingMode.c_str(), desiredMode.c_str());
    String targetName = targetProfile["name"] | profileName;
    String deleteResp = mikrotikRequest("DELETE", "/interface/wireless/security-profiles/" + targetName, "");
    Serial.printf("  DELETE response: %s\n", deleteResp.c_str());
    targetProfile = JsonObject();  // Mark as deleted
    needsRecreate = true;
  } else if (!targetProfile.isNull()) {
    Serial.printf("  Mode unchanged (%s), will update profile.\n", existingMode.c_str());
  } else {
    Serial.println("  No existing profile found, will create new one.");
  }

  // Build payload
  DynamicJsonDocument payloadDoc(512);
  payloadDoc["comment"] = comment;

  if (requiresPassword) {
    payloadDoc["mode"] = "dynamic-keys";
    payloadDoc["authentication-types"] = "wpa-psk,wpa2-psk";
    if (password.length() > 0) {
      payloadDoc["wpa-pre-shared-key"] = password;
      payloadDoc["wpa2-pre-shared-key"] = password;
      Serial.printf("  Security Profile: mode=dynamic-keys, password=%d chars\n", password.length());
    } else {
      Serial.println("  WARNING: requiresPassword=true but password is empty!");
    }
  } else {
    payloadDoc["mode"] = "none";
    payloadDoc["authentication-types"] = "";
    payloadDoc["wpa-pre-shared-key"] = "";
    payloadDoc["wpa2-pre-shared-key"] = "";
    Serial.println("  Security Profile: mode=none (open network)");
  }

  String payload;
  serializeJson(payloadDoc, payload);

  // Update or create profile
  if (!targetProfile.isNull() && !needsRecreate) {
    // Update existing profile (only when mode stays the same)
    String targetName = targetProfile["name"] | profileName;
    Serial.printf("  Updating existing profile: %s\n", targetName.c_str());
    Serial.printf("  Payload: %s\n", payload.c_str());
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
    if (needsRecreate) {
      Serial.printf("  Creating new profile: %s\n", profileName.c_str());
    } else {
      Serial.printf("  Creating profile: %s\n", profileName.c_str());
    }
    mikrotikRequest("POST", "/interface/wireless/security-profiles/add", createPayload);
    return profileName;
  }
}

// ==================== TMPFS MANAGEMENT ====================

bool ensureTmpfs() {
  String response = mikrotikRequest("GET", "/disk");
  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, response);

  if (error) return false;

  // Check if tmp1 already exists
  if (doc.is<JsonArray>()) {
    for (JsonObject disk : doc.as<JsonArray>()) {
      String mountPoint = disk["mount-point"] | "";
      String slot = disk["slot"] | "";
      if (mountPoint == "tmp1" || slot == "tmp1") {
        return true;
      }
    }
  }

  // tmpfs not found, create it
  Serial.println("  tmpfs nicht gefunden, lege an...");
  DynamicJsonDocument createDoc(128);
  createDoc["type"] = "tmpfs";
  createDoc["tmpfs-max-size"] = "1";
  String createBody;
  serializeJson(createDoc, createBody);

  mikrotikRequest("POST", "/disk/add", createBody);
  Serial.println("  tmpfs angelegt");
  return true;
}

void removeTmpfs() {
  String response = mikrotikRequest("GET", "/disk");
  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, response);

  if (error) return;

  if (doc.is<JsonArray>()) {
    for (JsonObject disk : doc.as<JsonArray>()) {
      String mountPoint = disk["mount-point"] | "";
      String slot = disk["slot"] | "";
      if (mountPoint == "tmp1" || slot == "tmp1") {
        String diskId = disk[".id"] | "";
        if (diskId.length() > 0) {
          Serial.println("  Lösche tmpfs...");
          DynamicJsonDocument removeDoc(128);
          removeDoc["numbers"] = diskId;
          String removeBody;
          serializeJson(removeDoc, removeBody);
          mikrotikRequest("POST", "/disk/remove", removeBody);
          Serial.println("  tmpfs gelöscht");
        }
        return;
      }
    }
  }
}

// ==================== CSV SCAN (MINIMAL - FRONTEND HANDLES PARSING) ====================

String getCSVScan(String wlanName, String& fileIdOut) {
  // Ensure tmpfs exists
  if (!ensureTmpfs()) {
    Serial.println("  Warnung: tmpfs nicht verfügbar");
    return "";
  }

  // Trigger scan with save-file for better responsiveness
  String filename = "tmp1/wlan-scan.csv";
  DynamicJsonDocument scanDoc(256);
  scanDoc[".id"] = wlanName;
  scanDoc["duration"] = "5";
  scanDoc["save-file"] = filename;

  String scanBody;
  serializeJson(scanDoc, scanBody);
  mikrotikRequest("POST", "/interface/wireless/scan", scanBody);

  // Wait for CSV file (max 5 seconds)
  String csvContent = "";
  fileIdOut = "";

  for (int attempt = 0; attempt < 10; attempt++) {
    String fileResponse = mikrotikRequest("GET", "/file");

    DynamicJsonDocument filesDoc(8192);
    DeserializationError error = deserializeJson(filesDoc, fileResponse);

    if (!error && filesDoc.is<JsonArray>()) {
      for (JsonObject file : filesDoc.as<JsonArray>()) {
        String fileName = file["name"] | "";
        if (fileName.endsWith("wlan-scan.csv")) {
          csvContent = file["contents"] | "";
          fileIdOut = file[".id"] | "";
          if (csvContent.length() > 0) {
            Serial.println("  CSV-Datei gefunden");
            return csvContent;
          }
        }
      }
    }

    if (attempt == 0) Serial.println("  Warte auf CSV-Datei...");
    delay(500);
  }

  Serial.println("  CSV-Datei nicht gefunden");
  return "";
}

// ==================== API HANDLER ====================

void handleConfig() {
  // Return configured band modes to the frontend
  Serial.println("  Config-Abfrage");

  String json = "{";
  json += "\"band_2ghz\":\"" + String(BAND_2GHZ) + "\",";
  json += "\"band_5ghz\":\"" + String(BAND_5GHZ) + "\"";
  json += "}";

  server.send(200, "application/json", json);
}

void handleStatus() {
  // Raw passthrough: ESP32 only forwards data, frontend parses it
  Serial.println("  Status-Abfrage: Sammle MikroTik-Daten...");

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

  Serial.printf("  → Sende %d bytes an Frontend (Frontend macht Parsing)\n", output.length());
  server.send(200, "application/json", output);
}

void handleScanStart() {
  String band = server.arg("band");
  if (band == "") band = "2ghz-b/g/n";

  Serial.printf("  Scan-Start für Band: %s\n", band.c_str());

  // Abort if a scan is already running
  if (scanState.isScanning) {
    server.send(200, "application/json", "{\"status\":\"already_scanning\"}");
    return;
  }

  // Locate wireless interface
  String ifaceResponse = mikrotikRequest("GET", "/interface/wireless");
  DynamicJsonDocument ifaceDoc(4096);
  deserializeJson(ifaceDoc, ifaceResponse);

  String wlanName = "";
  String wlanId = "";

  if (ifaceDoc.is<JsonArray>()) {
    for (JsonObject iface : ifaceDoc.as<JsonArray>()) {
      String name = iface["name"] | "";
      if (name.indexOf("wlan") >= 0) {
        wlanName = name;
        wlanId = iface[".id"] | "";

        // Switch MikroTik band if necessary
        String currentBand = iface["band"] | "";
        if (band.length() > 0 && currentBand != band) {
          Serial.printf("  Wechsle Band: %s → %s\n", currentBand.c_str(), band.c_str());
          DynamicJsonDocument bandDoc(128);
          bandDoc["band"] = band;
          String bandPayload;
          serializeJson(bandDoc, bandPayload);
          mikrotikRequest("PATCH", "/interface/wireless/" + wlanId, bandPayload);
          delay(500);
        }
        break;
      }
    }
  }

  if (wlanName.length() == 0) {
    server.send(404, "application/json", "{\"error\":\"No WLAN interface found\"}");
    return;
  }

  // Ensure tmpfs exists
  if (!ensureTmpfs()) {
    Serial.println("  Warnung: tmpfs nicht verfügbar");
    server.send(500, "application/json", "{\"error\":\"tmpfs not available\"}");
    return;
  }

  // Update scan state before triggering
  scanState.isScanning = true;
  scanState.hasResult = false;
  scanState.result = "";
  scanState.startTime = millis();
  scanState.wlanName = wlanName;
  scanState.band = band;

  // Trigger scan on MikroTik with a very short timeout
  // Response is irrelevant; MikroTik continues the scan and CSV is fetched later
  String filename = scanState.csvFilename;
  DynamicJsonDocument scanDoc(256);
  scanDoc[".id"] = wlanName;
  scanDoc["duration"] = "5";
  scanDoc["save-file"] = filename;

  String scanBody;
  serializeJson(scanDoc, scanBody);

  // Short timeout (500ms) just to trigger; response is ignored
  mikrotikRequest("POST", "/interface/wireless/scan", scanBody, 500);

  Serial.println("  Scan getriggert (timeout nach 500ms)");

  // Immediately confirm that the scan started
  server.send(200, "application/json", "{\"status\":\"started\"}");
}

void handleScanResult() {
  Serial.println("  Scan-Result abgerufen");

  // Serve cached result if one exists
  if (scanState.hasResult) {
    server.send(200, "application/json", scanState.result);

    // Clear cached result after serving
    scanState.hasResult = false;
    scanState.result = "";
    scanState.isScanning = false;
    return;
  }

  // If no scan is running, return informative status
  if (!scanState.isScanning) {
    server.send(200, "application/json", "{\"status\":\"no_result\",\"error\":\"No scan in progress\"}");
    return;
  }

  // Skip CSV lookup if the scan is younger than 4 seconds
  unsigned long elapsedMs = millis() - scanState.startTime;
  if (elapsedMs < 4000) {
    Serial.printf("  Scan zu frisch (%lu ms), sende pending\n", elapsedMs);
    server.send(200, "application/json", "{\"status\":\"pending\"}");
    return;
  }

  // Timeout guard (max 10 seconds)
  if (elapsedMs > 10000) {
    Serial.println("  Scan timeout!");
    scanState.isScanning = false;
    removeTmpfs();
    server.send(200, "application/json", "{\"status\":\"timeout\",\"error\":\"Scan timeout\"}");
    return;
  }

  // Scan is between 4-10 seconds old - check if the CSV is available
  // IMPORTANT: no busy waiting, just a quick check
  String fileResponse = mikrotikRequest("GET", "/file");
  DynamicJsonDocument filesDoc(8192);
  DeserializationError error = deserializeJson(filesDoc, fileResponse);

  String csvContent = "";
  String fileId = "";

  if (!error && filesDoc.is<JsonArray>()) {
    for (JsonObject file : filesDoc.as<JsonArray>()) {
      String fileName = file["name"] | "";
      if (fileName.endsWith("wlan-scan.csv")) {
        csvContent = file["contents"] | "";
        fileId = file[".id"] | "";
        if (csvContent.length() > 0) {
          Serial.println("  CSV-Datei gefunden!");
          break;
        }
      }
    }
  }

  // If CSV not ready yet, return pending (frontend will poll again)
  if (csvContent.length() == 0) {
    Serial.printf("  CSV noch nicht bereit (%lu ms vergangen)\n", elapsedMs);
    server.send(200, "application/json", "{\"status\":\"pending\"}");
    return;
  }

  // CSV is available; build response payload
  DynamicJsonDocument profilesDoc(8192);
  String profilesResponse = mikrotikRequest("GET", "/interface/wireless/security-profiles");
  deserializeJson(profilesDoc, profilesResponse);

  DynamicJsonDocument responseDoc(8192);
  responseDoc["csv"] = csvContent;
  responseDoc["band"] = scanState.band;

  // Attach profile info (frontend uses this to flag known networks)
  JsonArray profiles = responseDoc.createNestedArray("profiles");
  if (profilesDoc.is<JsonArray>()) {
    Serial.printf("  Adding %d profiles to scan result...\n", profilesDoc.as<JsonArray>().size());
    for (JsonObject profile : profilesDoc.as<JsonArray>()) {
      String comment = profile["comment"] | "";
      if (comment.startsWith(PROFILE_COMMENT_PREFIX)) {
        String ssid = comment.substring(strlen(PROFILE_COMMENT_PREFIX));
        JsonObject p = profiles.createNestedObject();
        p["ssid"] = ssid;
        p["mode"] = profile["mode"];
        p["authentication-types"] = profile["authentication-types"];
        Serial.printf("    - Profile for SSID: %s (mode=%s)\n", ssid.c_str(), profile["mode"].as<const char*>());
      }
    }
  }
  Serial.printf("  Total profiles sent to frontend: %d\n", profiles.size());

  String output;
  serializeJson(responseDoc, output);

  // Send result
  server.send(200, "application/json", output);

  // Cleanup scan state
  scanState.isScanning = false;
  scanState.hasResult = false;
  scanState.result = "";

  // Delete CSV file
  if (fileId.length() > 0) {
    DynamicJsonDocument removeDoc(128);
    removeDoc["numbers"] = fileId;
    String removeBody;
    serializeJson(removeDoc, removeBody);
    mikrotikRequest("POST", "/file/remove", removeBody);
  }

  // Remove tmpfs
  removeTmpfs();

  Serial.println("  CSV-Scan erfolgreich - Ergebnis gesendet");
}

void handleConnect() {
  String body = server.arg("plain");

  DynamicJsonDocument doc(1024);
  deserializeJson(doc, body);

  String ssid = doc["ssid"] | "";
  String password = doc["password"] | "";
  String band = doc["band"] | "2ghz-b/g/n";
  bool requiresPassword = doc["requiresPassword"] | true;
  bool known = doc["known"] | false;
  String profileName = doc["profileName"] | "";

  Serial.printf("  Verbinde zu: %s\n", ssid.c_str());

  // Create or update security profile
  String profileNameResult = ensureSecurityProfile(ssid, password, requiresPassword, known, profileName);

  // Retrieve interface ID
  String ifaceResponse = mikrotikRequest("GET", "/interface/wireless");
  DynamicJsonDocument ifaceDoc(4096);
  deserializeJson(ifaceDoc, ifaceResponse);

  String wlanId = "";
  if (ifaceDoc.is<JsonArray>()) {
    for (JsonObject iface : ifaceDoc.as<JsonArray>()) {
      String name = iface["name"] | "";
      if (name.indexOf("wlan") >= 0) {
        wlanId = iface[".id"] | "";
        break;
      }
    }
  }

  if (wlanId.length() == 0) {
    server.send(404, "application/json", "{\"error\":\"No WLAN interface found\"}");
    return;
  }

  // Configure interface
  DynamicJsonDocument configDoc(512);
  configDoc["mode"] = "station";
  configDoc["ssid"] = ssid;
  configDoc["band"] = band;
  configDoc["security-profile"] = profileNameResult;
  configDoc["disabled"] = "no";

  String config;
  serializeJson(configDoc, config);

  String response = mikrotikRequest("PATCH", "/interface/wireless/" + wlanId, config);

  Serial.printf("  ✓ Verbunden mit: %s\n", ssid.c_str());
  server.send(200, "application/json", "{\"success\":true}");
}

void handleDisconnect() {
  // Retrieve interface ID
  String ifaceResponse = mikrotikRequest("GET", "/interface/wireless");
  DynamicJsonDocument doc(4096);
  deserializeJson(doc, ifaceResponse);

  String wlanId = "";
  if (doc.is<JsonArray>()) {
    for (JsonObject iface : doc.as<JsonArray>()) {
      String name = iface["name"] | "";
      String mode = iface["mode"] | "";
      if (name.indexOf("wlan") >= 0 || mode == "station") {
        wlanId = iface[".id"] | "";
        break;
      }
    }
  }

  if (wlanId.length() == 0) {
    server.send(404, "application/json", "{\"error\":\"No active connection\"}");
    return;
  }

  mikrotikRequest("PATCH", "/interface/wireless/" + wlanId, "{\"disabled\":\"yes\"}");

  Serial.println("  ✓ Verbindung getrennt");
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
  Serial.println("Initialisiere LittleFS...");
  if (!LittleFS.begin(true)) {
    Serial.println("FEHLER: LittleFS Mount fehlgeschlagen!");
    Serial.println("Bitte führen Sie 'pio run --target uploadfs' aus!");
  } else {
    Serial.println("LittleFS erfolgreich gemountet");

    // List files
    Serial.println("\nDateien im Dateisystem:");
    File root = LittleFS.open("/");
    File file = root.openNextFile();
    while (file) {
      Serial.printf("  %s (%d bytes)\n", file.name(), file.size());
      file = root.openNextFile();
    }
    Serial.println();
  }

  // Connect to WiFi
  Serial.printf("Verbinde mit WiFi: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi verbunden!");
    Serial.print("IP Adresse: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi-Verbindung fehlgeschlagen!");
    Serial.println("Starte trotzdem Webserver...");
  }

  // Register API routes
  server.on("/api/config", HTTP_GET, handleConfig);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/scan/start", HTTP_POST, handleScanStart);
  server.on("/api/scan/result", HTTP_GET, handleScanResult);
  server.on("/api/connect", HTTP_POST, handleConnect);
  server.on("/api/disconnect", HTTP_POST, handleDisconnect);

  // CORS preflight handlers
  server.on("/api/config", HTTP_OPTIONS, handleCORS);
  server.on("/api/status", HTTP_OPTIONS, handleCORS);
  server.on("/api/scan/start", HTTP_OPTIONS, handleCORS);
  server.on("/api/scan/result", HTTP_OPTIONS, handleCORS);
  server.on("/api/connect", HTTP_OPTIONS, handleCORS);
  server.on("/api/disconnect", HTTP_OPTIONS, handleCORS);

  // Catch-all for static files
  server.onNotFound(handleNotFound);

  server.begin();
  Serial.printf("Webserver gestartet auf Port %d\n", WEB_PORT);
  Serial.println("\n=== Bereit! ===");
  Serial.printf("Öffne: http://%s/\n\n", WiFi.localIP().toString().c_str());
}

void loop() {
  server.handleClient();
  delay(2);
}
