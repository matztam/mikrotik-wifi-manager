/**
 * MikroTik WiFi Manager - Frontend JavaScript
 */

const API = {
    async get(path) {
        const response = await fetch(path);
        return await response.json();
    },
    async post(path, data) {
        const response = await fetch(path, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });
        return await response.json();
    }
};

// Utility functions
function simpleHash(text) {
    // Simple string hash to create unique profile names
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    // Convert to positive hex (6 characters)
    return Math.abs(hash).toString(16).padStart(6, '0').substring(0, 6);
}

function generateProfileName(ssid) {
    if (!ssid) return Promise.resolve('client-ssid');
    let base = ssid.trim().toLowerCase();
    base = base.replace(/[^a-zA-Z0-9_-]+/g, '-');
    base = base.replace(/^-+|-+$/g, '') || 'ssid';
    base = base.substring(0, 24);

    // Append hash to ensure uniqueness
    const hash = simpleHash(ssid);
    return Promise.resolve(`client-${base}-${hash}`);
}

function prefixToNetmask(prefix) {
    if (!prefix) return null;
    const prefixNum = parseInt(String(prefix).split('/')[0], 10);
    if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 32) return null;
    const mask = ~(2 ** (32 - prefixNum) - 1);
    return [
        (mask >>> 24) & 255,
        (mask >>> 16) & 255,
        (mask >>> 8) & 255,
        mask & 255
    ].join('.');
}

function asBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return ['true', 'yes', 'on', '1', 'running', 'enabled'].includes(normalized);
    }
    return false;
}

function interpretSecurityFromProfile(profile) {
    if (!profile) return null;
    const mode = profile.mode;
    const authTypes = profile['authentication-types'] || '';
    return !(mode === 'none' || !authTypes);
}

function parseCSV(csvText) {
    const networks = [];
    const lines = csvText.split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;

        // Parse CSV fields (comma-separated, with optional quotes)
        const fields = [];
        let field = '';
        let inQuote = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === "'" || char === '"') {
                inQuote = !inQuote;
            } else if (char === ',' && !inQuote) {
                fields.push(field.trim().replace(/^['"]|['"]$/g, ''));
                field = '';
            } else {
                field += char;
            }
        }
        fields.push(field.trim().replace(/^['"]|['"]$/g, ''));

        // Require at least 4 fields: MAC, SSID, channel, signal
        if (fields.length >= 4) {
            const ssid = fields[1];
            if (ssid && ssid.length > 0) {
                const channel = fields[2] || '';
                const frequency = channel.indexOf('/') > 0
                    ? parseInt(channel.substring(0, channel.indexOf('/')), 10)
                    : 0;

                // Privacy flag (index 5)
                const privacyField = (fields[5] || '').toLowerCase();
                const privacy = privacyField === 'privacy';

                networks.push({
                    ssid: ssid,
                    mac: fields[0],
                    address: fields[0],  // Alias
                    signal: parseInt(fields[3], 10) || 0,
                    sig: parseInt(fields[3], 10) || 0,  // Alias
                    frequency: frequency,
                    privacy: privacy
                });
            }
        }
    }

    return networks;
}

let state = {
    currentBand: null,  // Populated from backend config
    selectedNetwork: null,
    networks: {},       // Filled dynamically
    filter: 'all',
    isScanning: false,
    autoScanTimer: null,
    allowAutoScan: false,
    config: null,       // Band configuration from backend
    isConnected: false,
    isConnecting: false
};

const AUTO_SCAN_INTERVAL = 10000;

function enableAutoScan(skipImmediate = false) {
    if (!state.allowAutoScan) return;
    if (state.isConnected) return;
    if (state.autoScanTimer) return;
    state.autoScanTimer = setInterval(() => {
        if (!state.isScanning && !state.isConnected) {
            scan(true);
        }
    }, AUTO_SCAN_INTERVAL);
    if (!state.isScanning && !skipImmediate) {
        scan(true);
    }
}

function disableAutoScan() {
    if (state.autoScanTimer) {
        clearInterval(state.autoScanTimer);
        state.autoScanTimer = null;
    }
}

function ensureBandStore(band) {
    if (!state.networks[band]) {
        state.networks[band] = [];
    }
    return state.networks[band];
}

function getNetworksForBand(band) {
    return ensureBandStore(band);
}

function getNetworksForCurrentBand() {
    return getNetworksForBand(state.currentBand);
}

function getNetworkKey(network) {
    if (!network) return '';
    const ssid = network.ssid || '';
    const mac = (network.mac || '').toLowerCase();
    return `${ssid}__${mac}`;
}

function normalizeNetworkEntry(entry, band) {
    if (!entry || !entry.ssid) {
        return null;
    }
    let signal = entry.signal;
    if (signal === undefined || signal === null) {
        signal = entry.sig ?? entry.strength ?? entry.rssi ?? null;
    }
    if (typeof signal !== 'number') {
        const parsed = parseInt(signal, 10);
        signal = Number.isFinite(parsed) ? parsed : 0;
    }
    const macAddress = entry.mac || entry.address || entry.bssid || '';

    // Interpret security state (frontend logic)
    let security = entry.security;
    if (security === undefined || security === null) {
        // Check privacy flag
        if (entry.privacy !== undefined && entry.privacy !== null) {
            security = asBoolean(entry.privacy);
        }
        // Fallback: derive from profile information
        else if (entry.profile) {
            security = interpretSecurityFromProfile(entry.profile);
        }
    }

    return {
        ssid: entry.ssid,
        mac: macAddress,
        signal: Number.isFinite(signal) ? signal : 0,
        frequency: entry.frequency ?? entry.freq ?? null,
        security: security,
        known: !!entry.known,
        band,
        lastUpdated: Date.now()
    };
}

function mergeNetworkResults(existing, incoming, band) {
    const merged = new Map();
    existing.forEach(item => {
        merged.set(getNetworkKey(item), { ...item });
    });
    incoming.forEach(item => {
        if (!item) {
            return;
        }
        const normalized = normalizeNetworkEntry(item, band);
        if (!normalized) {
            return;
        }
        const key = getNetworkKey(normalized);
        if (merged.has(key)) {
            merged.set(key, { ...merged.get(key), ...normalized });
        } else {
            merged.set(key, normalized);
        }
    });
    return Array.from(merged.values()).sort((a, b) => b.signal - a.signal);
}

let toastTimer = null;
let toastHideTimer = null;

function formatSignal(signal) {
    if (!signal) {
        return '-';
    }
    if (typeof signal === 'number') {
        return `${signal} dBm`;
    }
    if (typeof signal === 'string') {
        if (signal.includes('dBm') || signal.includes('@')) {
            return signal;
        }
        return `${signal} dBm`;
    }
    return '-';
}

function signalColor(percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    if (clamped >= 95) {
        return '#2f855a';
    }
    if (clamped >= 85) {
        return '#38a169';
    }
    if (clamped >= 70) {
        return '#ecc94b';
    }
    if (clamped >= 50) {
        return '#ed8936';
    }
    return '#f56565';
}

function signalToPercent(signal) {
    if (signal === null || signal === undefined) {
        return 0;
    }

    let value = null;
    if (typeof signal === 'number' && !Number.isNaN(signal)) {
        value = signal;
    } else if (typeof signal === 'string') {
        const match = signal.match(/-?\d+/);
        if (match) {
            value = parseInt(match[0], 10);
        }
    }

    if (value === null || Number.isNaN(value)) {
        return 0;
    }

    const percent = ((value + 100) / 60) * 100;
    return Math.min(100, Math.max(0, percent));
}

function renderSignalQuality(signal) {
    const percent = signalToPercent(signal);
    if (percent <= 0) {
        return '';
    }

    return `
        <div class="signal-quality">
            <div class="signal-quality-header">

            </div>
            <div class="signal-bar status-signal">
                <div class="signal-fill" style="width: ${percent}%; background: ${signalColor(percent)};"></div>
            </div>
        </div>
    `;
}

function setBandSelection(band, { triggerScan = false } = {}) {
    if (!band) {
        return;
    }

    const changed = state.currentBand !== band;
    state.currentBand = band;
    let matched = false;
    const buttons = document.querySelectorAll('.band-btn');

    buttons.forEach(btn => {
        const isActive = btn.dataset.band === band;
        btn.classList.toggle('active', isActive);
        if (isActive) {
            matched = true;
        }
    });

    if (!matched) {
        buttons.forEach(btn => btn.classList.remove('active'));
    }
    renderNetworkList();

    if (triggerScan && (changed || !getNetworksForCurrentBand().length)) {
        scan(false);
    }
}

function showNotification(message, type = 'info', duration = 4000) {
    const toast = document.getElementById('toast-container');
    if (!toast) {
        return;
    }

    if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
    }
    if (toastHideTimer) {
        clearTimeout(toastHideTimer);
        toastHideTimer = null;
    }

    toast.classList.remove('hidden', 'toast-info', 'toast-success', 'toast-error', 'visible');
    void toast.offsetWidth;
    toast.textContent = typeof message === 'string' ? message : String(message);
    toast.classList.add(`toast-${type}`);
    toast.classList.add('visible');

    toastTimer = setTimeout(() => {
        toast.classList.remove('visible');
        toastHideTimer = setTimeout(() => {
            toast.classList.add('hidden');
        }, 250);
    }, duration);
}

async function updateStatus() {
    try {
        const rawData = await API.get('/api/status');

        // Parse status data similar to the legacy Python version
        const status = parseStatusData(rawData);

        const statusDiv = document.getElementById('connection-status');
        const statusText = document.getElementById('status-text');
        const detailsDiv = document.getElementById('connection-details');
        const disconnectBtn = document.getElementById('disconnect-btn');

        state.isConnected = !!status.connected;
        state.isConnecting = !!status.connecting;

        if (state.isConnected || state.isConnecting) {
            disableAutoScan();
        } else if (state.allowAutoScan) {
            enableAutoScan();
        }

        if (status.band) {
            setBandSelection(status.band, { triggerScan: false });
        }

        if (status.connected) {
            statusDiv.className = 'status-connected';
            statusText.textContent = 'Verbunden';
            detailsDiv.style.display = 'block';
            const rows = [];
            rows.push({ label: 'SSID', value: status.ssid || '-' });
            if (status.band) {
                rows.push({ label: 'Band', value: status.band });
            }
            if (status.signal) {
                rows.push({ label: 'Signal', value: formatSignal(status.signal) });
            }
            if (status.snr) {
                rows.push({ label: 'SNR', value: `${status.snr} dB` });
            }
            if (status.ip) {
                rows.push({ label: 'IP-Adresse', value: status.ip });
            }
            if (status.netmask) {
                rows.push({ label: 'Netzmaske', value: status.netmask });
            } else if (status.prefix) {
                const calculatedNetmask = prefixToNetmask(status.prefix);
                if (calculatedNetmask) {
                    rows.push({ label: 'Netzmaske', value: calculatedNetmask });
                }
            }
            if (status.gateway) {
                rows.push({ label: 'Gateway', value: status.gateway });
            }
            if (status.dns && status.dns.length) {
                rows.push({ label: 'DNS-Server', value: status.dns.join(', ') });
            }
            const qualityMarkup = renderSignalQuality(status.signal);
            detailsDiv.innerHTML = rows.map(row => `
                <div class="detail-row">
                    <span class="label">${row.label}:</span>
                    <span>${row.value}</span>
                </div>
            `).join('') + qualityMarkup;
            disconnectBtn.style.display = 'block';
        } else if (status.connecting) {
            statusDiv.className = 'status-connecting';
            statusText.textContent = 'Verbindung wird hergestellt';
            detailsDiv.style.display = 'block';
            const rows = [];
            rows.push({ label: 'SSID', value: status.ssid || '-' });
            if (status.band) {
                rows.push({ label: 'Band', value: status.band });
            }
            if (status.signal) {
                rows.push({ label: 'Signal', value: formatSignal(status.signal) });
            }
            if (status.snr) {
                rows.push({ label: 'SNR', value: `${status.snr} dB` });
            }
            const qualityMarkup = renderSignalQuality(status.signal);
            detailsDiv.innerHTML = rows.map(row => `
                <div class="detail-row">
                    <span class="label">${row.label}:</span>
                    <span>${row.value}</span>
                </div>
            `).join('') + qualityMarkup;
            disconnectBtn.style.display = 'block';
        } else {
            statusDiv.className = 'status-disconnected';
            statusText.textContent = 'Nicht verbunden';
            detailsDiv.style.display = 'none';
            disconnectBtn.style.display = 'none';
        }
    } catch(error) {
        console.error('Status update failed:', error);
    }
}

function parseStatusData(rawData) {
    // Parse raw MikroTik data inside the frontend (mirrors Python version)
    const result = { connected: false };

    if (!rawData.interfaces || !rawData.registration) {
        return result;
    }

    const interfaces = Array.isArray(rawData.interfaces) ? rawData.interfaces : [];
    const registrations = Array.isArray(rawData.registration) ? rawData.registration : [];
    const addresses = Array.isArray(rawData.addresses) ? rawData.addresses : [];
    const routes = Array.isArray(rawData.routes) ? rawData.routes : [];
    const dnsInfo = rawData.dns || {};

    // Index wireless interfaces
    const wlanInterfaces = {};
    interfaces.forEach(iface => {
        const name = iface.name || '';
        if (name.toLowerCase().includes('wlan')) {
            wlanInterfaces[name] = iface;
        }
    });

    // Registration table is the most reliable indicator of active links
    let activeEntry = null;
    for (const entry of registrations) {
        const ifaceName = entry.interface || '';
        if (wlanInterfaces[ifaceName]) {
            activeEntry = entry;
            break;
        }
    }

    if (activeEntry) {
        // Active connection found via registration table
        const ifaceName = activeEntry.interface || '';
        const iface = wlanInterfaces[ifaceName] || {};
        const ssid = iface.ssid || activeEntry.ssid || activeEntry['radio-name'] || '';

        result.connected = true;
        result.interface = ifaceName;
        result.ssid = ssid;
        result.running = true;
        result.signal = activeEntry['signal-strength'];
        result.snr = activeEntry['signal-to-noise'];

        if (iface.band) {
            result.band = iface.band;
        }
    } else {
        // Fallback: inspect interface flags
        for (const [name, iface] of Object.entries(wlanInterfaces)) {
            const disabled = asBoolean(iface.disabled);
            const running = asBoolean(iface.running);
            const ssid = iface.ssid || '';

            if (disabled) {
                // Even if interface is disabled, capture the band for UI accuracy
                if (iface.band && !result.band) {
                    result.band = iface.band;
                }
                continue;
            }

            if (running) {
                result.connected = true;
                result.interface = name;
                result.ssid = ssid;
                result.running = running;
                if (iface.band) result.band = iface.band;
                if (iface['signal-strength']) result.signal = iface['signal-strength'];
                break;
            } else if (ssid) {
                result.connecting = true;
                result.interface = name;
                result.ssid = ssid;
                result.running = running;
                if (iface.band) result.band = iface.band;
                break;
            }
        }
    }

    // Enrich with network information
    if (result.connected && result.interface) {
        const ifaceName = result.interface;

        // IP address
        let selectedAddr = null;
        for (const addr of addresses) {
            if (addr.interface === ifaceName || addr['actual-interface'] === ifaceName) {
                selectedAddr = addr;
                // Prefer dynamic (DHCP) entries
                if (asBoolean(addr.dynamic)) {
                    break;
                }
            }
        }

        if (selectedAddr) {
            const address = selectedAddr.address || '';
            if (address.includes('/')) {
                const [ip, prefix] = address.split('/', 2);
                result.ip = ip;
                result.prefix = prefix;
            }
            if (selectedAddr.network) {
                result.network = selectedAddr.network;
            }
        }

        // Gateway
        for (const route of routes) {
            if (route['dst-address'] !== '0.0.0.0/0') continue;
            if (!asBoolean(route.active)) continue;

            const immediateGw = route['immediate-gw'] || '';
            const gateway = route.gateway || '';

            if (immediateGw.includes(`%${ifaceName}`) || gateway === ifaceName) {
                result.gateway = gateway;
                break;
            }
        }

        // DNS servers
        const dnsServers = [];
        const servers = dnsInfo.servers || '';
        const dynamicServers = dnsInfo['dynamic-servers'] || '';

        if (servers) {
            servers.split(',').forEach(dns => {
                dns = dns.trim();
                if (dns) dnsServers.push(dns);
            });
        }

        if (dnsServers.length > 0) {
            result.dns = dnsServers;
        }
    }

    return result;
}

function getFilteredNetworks() {
    const networks = getNetworksForCurrentBand();
    if (!Array.isArray(networks)) {
        return [];
    }
    return networks.filter(network => {
        if (state.filter === 'secured') {
            return network.security === true;
        }
        if (state.filter === 'open') {
            return network.security === false;
        }
        return true;
    });
}

function renderNetworkList() {
    const list = document.getElementById('networks-list');
    if (!list) return;

    const filtered = getFilteredNetworks();
    const allNetworks = getNetworksForCurrentBand();

    if (!allNetworks.length) {
        list.innerHTML = '<p style="text-align: center; color: #6c757d; padding: 24px;">Keine Netzwerke gefunden</p>';
        hideConnectSection();
        return;
    }

    if (!filtered.length) {
        list.innerHTML = '<p style="text-align: center; color: #6c757d; padding: 24px;">Keine Netzwerke für diesen Filter</p>';
        hideConnectSection();
        return;
    }

    list.innerHTML = filtered.map(network => {
        const signalPercent = Math.min(100, Math.max(0, ((network.signal + 100) / 60) * 100));
        const securityState = network.security;
        const requiresPassword = securityState !== false;
        let icon = '';
        if (securityState === true) {
            icon = '🔒 ';
        } else if (securityState === false) {
            icon = '📡 ';
        }
        const badge = network.known ? '<span class="network-badge">Gespeichert</span>' : '';
        const key = getNetworkKey(network);
        return `
            <div class="network-item" data-ssid="${network.ssid}" data-mac="${network.mac || ''}" data-key="${key}" data-requires-password="${requiresPassword}">
                <div class="network-header">
                    <div class="network-ssid">${icon}${network.ssid}${badge}</div>
                    <div>${network.signal} dBm</div>
                </div>
                <div class="network-details">
                    <div class="network-meta">MAC: ${network.mac || 'N/A'}</div>
                </div>
                <div class="signal-bar">
                    <div class="signal-fill" style="width: ${signalPercent}%; background: ${signalColor(signalPercent)};"></div>
                </div>
            </div>
        `;
    }).join('');

    list.querySelectorAll('.network-item').forEach((item, index) => {
        const network = filtered[index];
        const securityState = network.security;
        const requiresPassword = securityState !== false;
        item.onclick = () => {
            list.querySelectorAll('.network-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            const key = item.dataset.key;
            state.selectedNetwork = {
                ssid: network.ssid,
                requiresPassword,
                mac: network.mac || '',
                securityState,
                known: !!network.known,
                band: state.currentBand,
                key
            };
            showConnectSection();
        };
    });

    if (state.selectedNetwork) {
        const selectedElement = state.selectedNetwork.key
            ? list.querySelector(`.network-item[data-key="${state.selectedNetwork.key}"]`)
            : list.querySelector(`.network-item[data-ssid="${state.selectedNetwork.ssid}"]`);
        if (selectedElement) {
            selectedElement.classList.add('selected');
        } else {
            hideConnectSection();
        }
    }
}

async function scan(auto = false) {
    if (state.isScanning) return;
    state.isScanning = true;
    const requestedBand = state.currentBand;

    if (!auto) {
        state.allowAutoScan = true;
        document.getElementById('scan-status').style.display = 'block';
        document.getElementById('scan-btn').disabled = true;
        state.selectedNetwork = null;
        hideConnectSection();
    }

    try {
        // Step 1: start the scan (non-blocking)
        const startResponse = await API.post('/api/scan/start?band=' + encodeURIComponent(requestedBand), {});

        if (startResponse.error) {
            console.error('Scan start error:', startResponse.error);
            showNotification(`Scan fehlgeschlagen: ${startResponse.error}`, 'error');
            return;
        }

        // Step 2: poll for results (every 500 ms)
        let attempts = 0;
        const maxAttempts = 20; // ~10 seconds (20 * 500 ms)
        let response = null;

        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 500));

            const pollResponse = await API.get('/api/scan/result');

            // Check status
            if (pollResponse.status === 'pending') {
                // Not ready yet, keep waiting
                attempts++;
                continue;
            }

            // Result received
            response = pollResponse;
            break;
        }

        if (!response) {
            showNotification('Scan timeout - bitte erneut versuchen', 'error');
            return;
        }

        if (!response) {
            console.error('Empty response from scan API');
            showNotification('Scan fehlgeschlagen: Keine Daten empfangen', 'error');
            return;
        }

        if (response.error) {
            console.error('Scan error:', response.error);
            showNotification(`Scan fehlgeschlagen: ${response.error}`, 'error');
            return;
        }

        const existing = getNetworksForBand(requestedBand);
        let updates = [];

        // Check if response contains CSV data (new format)
        if (response.csv) {
            // Parse CSV in frontend
            updates = parseCSV(response.csv);

            // Add known status from profiles array
            const profileMap = {};
            if (response.profiles && Array.isArray(response.profiles)) {
                console.log('Received profiles from backend:', response.profiles);
                response.profiles.forEach(p => {
                    if (p.ssid) {
                        profileMap[p.ssid] = p;
                        console.log(`  Profile: "${p.ssid}" (mode=${p.mode})`);
                    }
                });
            }

            // Enrich network entries with known status and profile info
            updates.forEach(network => {
                const matched = profileMap[network.ssid];
                if (matched) {
                    network.known = true;
                    network.profile = matched;
                    console.log(`  ✓ Matched network "${network.ssid}" with profile`);
                } else {
                    network.known = false;
                    console.log(`  ✗ No profile found for "${network.ssid}"`);
                }
            });
        } else if (Array.isArray(response)) {
            // Fallback: REST API format (old format)
            updates = response;
        }

        const merged = mergeNetworkResults(existing, updates, requestedBand);
        state.networks[requestedBand] = merged;

        if (state.selectedNetwork && state.selectedNetwork.band === requestedBand) {
            const selectedKey = getNetworkKey(state.selectedNetwork);
            const refreshed = merged.find(net => getNetworkKey(net) === selectedKey);
            if (refreshed) {
                const refreshedKey = getNetworkKey(refreshed);
                state.selectedNetwork = {
                    ...state.selectedNetwork,
                    known: !!refreshed.known,
                    securityState: refreshed.security,
                    requiresPassword: refreshed.security !== false,
                    mac: refreshed.mac || state.selectedNetwork.mac,
                    key: refreshedKey,
                    band: requestedBand
                };
                updatePasswordUI();
            }
        }

        if (requestedBand === state.currentBand) {
            renderNetworkList();
        }
    } catch (error) {
        const message = error && error.message ? error.message : error;
        showNotification('Scan fehlgeschlagen: ' + message, 'error');
    } finally {
        if (!auto) {
            document.getElementById('scan-status').style.display = 'none';
            document.getElementById('scan-btn').disabled = false;
        }
        state.isScanning = false;
        if (!auto && state.allowAutoScan && !state.isConnected) {
            enableAutoScan(true);
        }
    }
}

function updatePasswordUI() {
    const passwordField = document.getElementById('password-field');
    const passwordInput = document.getElementById('password-input');
    if (!passwordField || !passwordInput) return;

    if (!state.selectedNetwork) {
        passwordField.style.display = 'none';
        passwordInput.placeholder = 'Passwort eingeben';
        passwordInput.value = '';
        return;
    }

    const requiresPassword = state.selectedNetwork.requiresPassword !== false;
    const known = !!state.selectedNetwork.known;
    passwordField.style.display = requiresPassword ? 'block' : 'none';

    if (requiresPassword && known) {
        // Saved encrypted network: password optional (can update stored value)
        passwordInput.placeholder = 'Passwort (leer lassen für gespeichertes)';
    } else if (requiresPassword) {
        // New encrypted network: password required
        passwordInput.placeholder = 'Passwort eingeben';
    } else {
        passwordInput.placeholder = 'Keine Passworteingabe erforderlich';
    }
}

function showConnectSection() {
    const section = document.getElementById('connect-section');

    document.getElementById('selected-ssid').textContent = state.selectedNetwork.ssid;
    document.getElementById('password-input').value = '';
    updatePasswordUI();

    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideConnectSection() {
    const section = document.getElementById('connect-section');
    section.style.display = 'none';
    const list = document.getElementById('networks-list');
    if (list) {
        list.querySelectorAll('.network-item').forEach(i => i.classList.remove('selected'));
    }
    state.selectedNetwork = null;
    updatePasswordUI();
}

async function connect() {
    if (!state.selectedNetwork) return;

    const password = document.getElementById('password-input').value;
    const requiresPassword = state.selectedNetwork.requiresPassword !== false;
    const known = !!state.selectedNetwork.known;

    // Password validation:
    // - Encrypted networks: password required when not already saved
    // - Saved encrypted networks: password optional (uses stored credential)
    // - Open networks: no password needed
    if (requiresPassword && !password && !known) {
        showNotification('Bitte Passwort eingeben', 'error');
        return;
    }

    disableAutoScan();
    document.getElementById('connect-btn').disabled = true;

    try {
        // Generate profile name on the frontend
        const profileName = await generateProfileName(state.selectedNetwork.ssid);

        const response = await API.post('/api/connect', {
            ssid: state.selectedNetwork.ssid,
            password: password,
            band: state.currentBand,
            known,
            requiresPassword,
            profileName: profileName
        });

        if (response && response.error) {
            throw new Error(response.error);
        }

        showNotification(`Verbindung zu "${state.selectedNetwork.ssid}" wird hergestellt...`, 'success');
        hideConnectSection();

        // Refresh status after 3 seconds
        setTimeout(updateStatus, 3000);
    } catch(error) {
        const message = error && error.message ? error.message : 'Unbekannter Fehler';
        showNotification('Verbindung fehlgeschlagen: ' + message, 'error');
    } finally {
        document.getElementById('connect-btn').disabled = false;
    }
}

async function disconnect() {
    if (!confirm('Verbindung wirklich trennen?')) return;

    try {
        const response = await API.post('/api/disconnect', {});
        if (response && response.error) {
            throw new Error(response.error);
        }
        showNotification('Verbindung getrennt', 'success');
        updateStatus();
    } catch(error) {
        const message = error && error.message ? error.message : 'Unbekannter Fehler';
        showNotification('Fehler beim Trennen: ' + message, 'error');
    }
}

async function loadConfig() {
    try {
        const config = await API.get('/api/config');
        state.config = config;

        // Initialize networks object based on config
        state.networks = {};
        state.networks[config.band_2ghz] = [];
        state.networks[config.band_5ghz] = [];

        // Set default band
        state.currentBand = config.band_2ghz;

        // Build band buttons dynamically
        createBandButtons(config);

        return config;
    } catch(error) {
        console.error('Fehler beim Laden der Config:', error);
        // Fallback to legacy defaults
        state.config = { band_2ghz: '2ghz-b/g/n', band_5ghz: '5ghz-a/n' };
        state.networks = { '2ghz-b/g/n': [], '5ghz-a/n': [] };
        state.currentBand = '2ghz-b/g/n';
        createBandButtons(state.config);
        return state.config;
    }
}

function createBandButtons(config) {
    const container = document.getElementById('band-selector');
    container.innerHTML = '';

    // Extract mode suffix (e.g., "g/n" from "2ghz-g/n")
    const extractMode = (band) => {
        const parts = band.split('-');
        return parts.length > 1 ? parts.slice(1).join('-') : '';
    };

    // 2.4 GHz button
    const btn2ghz = document.createElement('button');
    btn2ghz.className = 'band-btn active';
    btn2ghz.dataset.band = config.band_2ghz;
    btn2ghz.innerHTML = `
        <span class="band-freq">2.4 GHz</span>
        <span class="band-mode">${extractMode(config.band_2ghz)}</span>
    `;
    btn2ghz.onclick = () => setBandSelection(config.band_2ghz, { triggerScan: true });
    container.appendChild(btn2ghz);

    // 5 GHz button
    const btn5ghz = document.createElement('button');
    btn5ghz.className = 'band-btn';
    btn5ghz.dataset.band = config.band_5ghz;
    btn5ghz.innerHTML = `
        <span class="band-freq">5 GHz</span>
        <span class="band-mode">${extractMode(config.band_5ghz)}</span>
    `;
    btn5ghz.onclick = () => setBandSelection(config.band_5ghz, { triggerScan: true });
    container.appendChild(btn5ghz);
}

// Event listener setup
document.addEventListener('DOMContentLoaded', async () => {
    // Load config and initialize band buttons
    await loadConfig();

    // Wire up buttons
    document.getElementById('scan-btn').onclick = () => scan(false);
    document.getElementById('disconnect-btn').onclick = disconnect;
    document.getElementById('connect-btn').onclick = connect;
    document.getElementById('cancel-btn').onclick = hideConnectSection;

    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.onclick = () => {
            state.filter = btn.dataset.filter;
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
            btn.blur();
            renderNetworkList();
        };
    });

    // Allow Enter key in password field
    document.getElementById('password-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            connect();
        }
    });

    setBandSelection(state.currentBand, { triggerScan: false });
    updatePasswordUI();

    // Initial status fetch
    updateStatus();

    // Auto-refresh status every 5 seconds
    setInterval(updateStatus, 5000);
});
