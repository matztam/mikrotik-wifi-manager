# MikroTik WiFi Manager (ESP32-S2)

Firmware and web UI for controlling a MikroTik wireless interface with an ESP32-S2 bridge controller. The ESP32 hosts a lightweight single-page app from LittleFS, proxies scan requests to the router, and exposes connection/profile management directly in the browser.

## Highlights

- Non-blocking Wi-Fi scans via `/api/scan/start` + `/api/scan/result`, including CSV parsing for WPA/WPA2 detection
- Compact web UI (LittleFS) with status polling, band switching, and password management
- Automatic security profile recreation when switching between open and PSK modes
- Runs fully offline; all traffic stays between ESP32 and MikroTik over HTTP
- Auto-detects browser language (de/en) and loads UI strings from `/data/i18n`
- Known networks can be removed from the web UI without touching the router CLI
- Built-in configuration portal (`/config.html`) with automatic SoftAP fallback when Wi-Fi credentials are missing or invalid

## Repository Map

```
src/            ESP32 firmware (Arduino / PlatformIO)
  main.cpp      Production firmware with web server + MikroTik client
  config.h.*    Configuration template and local copy (gitignored)
data/           Web UI (HTML, CSS, JS) served from LittleFS
  i18n/         Translation bundles (en/de) consumed by the frontend
README-ESP32.md Additional ESP32 notes and troubleshooting (German)
CLAUDE.md       Agent guide (treat as AGENTS.md)
misc/           Ignored
```

## Hardware & Firmware Requirements

- ESP32-S2 board with ≥ 4 MB flash (e.g., ESP32-S2-Saola-1)
- MikroTik RouterOS with REST API enabled (`/ip service enable rest`; disable `www-ssl` if unused)
- Shared 2.4 GHz Wi-Fi network the ESP32 can join
- Typical footprint: ~113 KB RAM, ~360 KB flash (firmware + web assets)

> **Note:** The firmware uses HTTP (no TLS) to keep RAM usage low. Deploy only in trusted networks.

## Quickstart

1. **Install PlatformIO**
   ```bash
   pip install platformio
   # or install the VS Code extension
   ```
2. **Create configuration**
   ```bash
   cp src/config.h.example src/config.h
   # WIFI_SSID / WIFI_PASSWORD = Wi-Fi for the ESP32
   # MIKROTIK_*              = router credentials + interface name
   ```
3. **Upload web assets to LittleFS**
   ```bash
   pio run -t uploadfs
   ```
4. **Flash the firmware**
   ```bash
   pio run -t upload
   ```
5. **Watch the serial console**
   ```bash
   pio device monitor
   ```
   The ESP32 IP address prints once it joins your Wi-Fi.

## Configuration Portal

- Browse to `/config.html` to adjust Wi-Fi credentials, MikroTik access data, or band settings. Password fields remain blank so stored secrets are never echoed back.
- If the ESP32 cannot join the configured Wi-Fi (or no SSID has been set), it will start a captive portal (`SSID: MikroTikSetup`, default IP `192.168.4.1`). Only the configuration UI is reachable in this mode; the device keeps retrying the station connection in the background.
- Saving new Wi-Fi settings automatically triggers a reconnect attempt. Leave password/token fields empty to retain the currently stored credentials.
- Runtime settings persist in `/config.json` on LittleFS; the file is created automatically if it does not exist.
- Scan duration can be adjusted from the UI; changes apply immediately and the value is persisted alongside other settings.

## Prepare the MikroTik

- Enable REST API: `/ip service enable rest`
- Optionally disable HTTPS: `/ip service set www-ssl disabled` (avoids certificate management)
- Ensure the API user/token can access:
  - `/interface/wireless/*`
  - `/file` (required for CSV scans)

## Using the Web UI

1. Open `http://<ESP32-IP>/` in a browser.
2. Press **Scan** and pick a band (buttons are generated from `BAND_*` config values).
3. ESP32 triggers a scan (`/api/scan/start`); MikroTik stores the result as a CSV file.
4. After ~4 seconds `/api/scan/result` downloads the CSV, inspects the `privacy` flag, and returns networks + known profiles.
5. Select a network:
   - Open network: connects immediately.
   - WPA/WPA2 network: enter password; ESP32 creates or updates the security profile on the MikroTik.
6. `/api/status` returns the raw wireless interface state; the UI polls every 5–10 seconds.

## Key Design Decisions

- **CSV scan is mandatory:** Only the CSV exposes WPA/WPA2 flags.
- **Security profile recreation:** Mode changes (open ↔ PSK) trigger DELETE + CREATE because PATCH alone is unreliable.
- **Fixed interface name:** `MIKROTIK_WLAN_INTERFACE` selects the target interface; no runtime discovery.
- **JSON buffer sizing:** 12 KB for profiles, 8 KB for scan/status responses—do not reduce.
- **RAM optimizations:** HTTP (no TLS), capped network list (20 entries), frontend hashing, and streaming JSON keep memory stable.
- **Scan timing is configurable:** `SCAN_DURATION_SECONDS`, `SCAN_RESULT_GRACE_MS`, `SCAN_POLL_INTERVAL_MS`, and `SCAN_CSV_FILENAME` in `config.h` define MikroTik scan length, poll cadence, and CSV storage (values are returned to the frontend so it adapts automatically).
- **Signal range & buffers in config:** `SIGNAL_MIN_DBM` / `SIGNAL_MAX_DBM` control UI scaling, and JSON buffer constants in `config.h` make it easy to adjust for larger MikroTik payloads.

## Known Limitations

- HTTP only between ESP32 and MikroTik; avoid untrusted networks.
- Maximum of 20 networks per scan result due to RAM constraints.
- Designed for 1–2 simultaneous browser sessions; more may exhaust memory.
- ESP32-S2 hardware supports 2.4 GHz Wi-Fi only; 5 GHz networks are invisible.

## Performance Tips

- Prefer MikroTik API tokens over Basic Auth for faster requests.
- Slow down frontend polling (e.g., `setInterval(updateStatus, 10000)`) to cut load.
- Disable optional features such as CORS headers if you do not need cross-origin access.
- Monitor serial output during scans to spot memory pressure early.

## Developer Workflows

| Goal                | Command                 |
|---------------------|-------------------------|
| Build firmware      | `pio run`               |
| Flash firmware      | `pio run -t upload`     |
| Upload LittleFS     | `pio run -t uploadfs`   |
| Serial monitor      | `pio device monitor`    |

## Troubleshooting Cheat Sheet

- **ESP32 won’t connect:** Double-check 2.4 GHz SSID/password; ESP32-S2 cannot use 5 GHz.
- **LittleFS fails to mount:** Re-run `pio run -t uploadfs`.
- **Blank page in browser:** Ensure `data/index.html`, `app.js`, and `style.css` are present and uploaded.
- **MikroTik API errors:** Is REST enabled? IP/token correct? Does the router allow file operations?
- **Out-of-memory:** Lower `MAX_NETWORKS` in `src/main.cpp` and avoid multiple concurrent browser sessions.
- **Need reference config:** `src/config.h.example` shows every tunable constant with sane defaults.

## Security & Operations

- Intended for trusted, closed networks only.
- Secrets live in ESP32 flash (plain text inside `config.h`).
- Prefer a dedicated MikroTik account with minimum required permissions.

## Further Reading

- MikroTik REST API docs: <https://help.mikrotik.com/docs/display/ROS/REST+API>
- PlatformIO docs: <https://docs.platformio.org/>
