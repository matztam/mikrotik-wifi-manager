# MikroTik WiFi Manager (ESP32-S2)

MikroTik WiFi Manager turns an ESP32-S2 into a friendly control panel for MikroTik station-mode setups—ideal when you run a Groove or similar antenna on a boat, in a camper, or at a remote site and need to hop between campground or marina Wi-Fi without wrestling with QuickSet. The ESP32 serves a minimal web app that scans, connects, and stores networks from any browser so you can reuse trusted hotspots without QuickSet clobbering your wireless interface configuration.

## Highlights

- Click-to-connect workflow for MikroTik station mode without opening WinBox or QuickSet
- Saves marina/campground hotspots as MikroTik security profiles and reuses them automatically
- Mobile-friendly web UI served by the ESP32 (LittleFS) with live status, band switching, and password prompts
- Non-blocking scan flow so password-protected networks are detected reliably while the ESP32 stays responsive
- Runs fully offline; every request stays between browser, ESP32, and your MikroTik over plain HTTP
- Captive configuration portal (`/config.html`) appears automatically when Wi-Fi credentials are missing or invalid

## Typical Scenarios

- Liveaboard boat switching between marina, harbour, and coastal Wi-Fi without plugging in a laptop
- Campervan or RV hopping between campsite hotspots while keeping an external MikroTik antenna outside
- Remote installs (farm, cabin, pop-up events) that need a simple touchscreen-friendly way to store trusted SSIDs
- Technicians preparing MikroTik gear for end users and preloading known networks without touching QuickSet

## Why Not QuickSet?

QuickSet is great for initial MikroTik provisioning, but it is clumsy once the router acts as a roaming station: the UI is hard to use on a phone, it resets wireless profiles when you change networks, and it happily overwrites carefully tuned interface settings. MikroTik WiFi Manager keeps your station configuration intact while giving you a purpose-built interface that anyone on board can use from a phone or tablet.

## Repository Map

```
src/            ESP32 firmware (Arduino / PlatformIO)
  main.cpp      Production firmware with web server + MikroTik client
  config.h.example Configuration template (copy to gitignored config.h)
data/           Web UI (HTML, CSS, JS) served from LittleFS
  i18n/         Translation bundles (en/de) consumed by the frontend
doc/            Screenshots and assets referenced by the README
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
   Bring the board to your boat/camper, power it from 5 V USB, and browse to that IP to manage networks on the MikroTik.

## Configuration Portal

- Browse to `/config.html` to adjust Wi-Fi credentials, MikroTik access data, or band settings. Password fields remain blank so stored secrets are never echoed back.
- If the ESP32 cannot join the configured Wi-Fi (or no SSID has been set), it will start a captive portal (`SSID: MikroTikSetup`, default IP `192.168.4.1`). Only the configuration UI is reachable in this mode; the device keeps retrying the station connection in the background.
- Saving new Wi-Fi settings automatically triggers a reconnect attempt. Leave password/token fields empty to retain the currently stored credentials.
- Runtime settings persist in `/config.json` on LittleFS; the file is created automatically if it does not exist.
- Scan duration can be adjusted from the UI; changes apply immediately and the value is persisted alongside other settings.
- Handy for provisioning: connect once at home, store the campground or marina credentials, and the MikroTik will reconnect automatically when you arrive on site.

## Prepare the MikroTik

- Enable REST API: `/ip service enable rest`
- Optionally disable HTTPS: `/ip service set www-ssl disabled` (avoids certificate management)
- Ensure the API user/token can access:
  - `/interface/wireless/*`
  - `/file` (needed because the scan downloads MikroTik's CSV results behind the scenes)

## Using the Web UI

1. Open `http://<ESP32-IP>/` from any browser (phone, tablet, laptop).
2. Tap **Scan** and choose the band you want to search (buttons come from the `BAND_*` config values).
3. The ESP32 starts a MikroTik scan and shows a spinner while the router collects results.
4. When the results arrive, the UI lists nearby networks and tags ones you already saved.

![Screenshot: Connected to marina Wi-Fi with fresh scan results](doc/screenshot1.png)

5. Pick a network:
   - Open network: connects immediately.
   - Password-protected network: enter the key once; the ESP32 writes/updates the MikroTik security profile so the hotspot becomes a saved network.
6. The status card refreshes automatically; you can disconnect or forget the profile straight from the same screen.

![Screenshot: Not connected, saved hotspot selected with connect/cancel/forget actions](doc/screenshot2.png)

## Key Design Decisions

- **Protect the station setup:** The firmware talks straight to the configured wireless interface and never runs QuickSet, so your bridge/NAT settings stay untouched.
- **CSV under the hood:** The firmware fetches MikroTik's CSV scan output asynchronously so secure networks are detected without freezing the UI.
- **Smart profile handling:** When a hotspot switches between open and WPA/WPA2, the ESP32 deletes and recreates the MikroTik security profile to avoid stale settings.
- **Resource-aware defaults:** HTTP (no TLS) and tuned ArduinoJson buffers keep the ESP32-S2 stable in the field—raise the buffer constants in `config.h` if your MikroTik responses are larger.
- **Config governs behaviour:** Interface name, band presets, signal range, and scan timing all live in `config.h` / `/config.json`, so the frontend can display accurate buttons and progress estimates.

## Known Limitations

- HTTP only between ESP32 and MikroTik; avoid untrusted networks.
- ESP32-S2 hardware supports 2.4 GHz Wi-Fi only; 5 GHz networks are invisible.

## Performance Tips

- Prefer MikroTik API tokens over Basic Auth for faster requests.
- Slow down frontend polling (e.g., `setInterval(updateStatus, 10000)`) to cut load.
- Disable optional features such as CORS headers if you do not need cross-origin access.
- Monitor serial output during scans to spot memory pressure early.
- Limit simultaneous browser sessions if you notice sluggishness—each tab polls status on a timer.

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
