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

const SUPPORTED_LANGUAGES = ['en', 'de'];

const DEFAULT_TRANSLATIONS = {
    "status.title": "Connection Status",
    "status.text.connected": "Connected",
    "status.text.connecting": "Connecting...",
    "status.text.disconnected": "Not connected",
    "connect.title": "Connect",
    "button.disconnect": "Disconnect",
    "button.connect": "Connect",
    "button.cancel": "Cancel",
    "button.forget": "Forget",
    "nav.home": "Dashboard",
    "nav.config": "Configuration",
    "config.title": "Device Configuration",
    "config.section.wifi": "Wi-Fi Settings",
    "config.section.mikrotik": "MikroTik Settings",
    "config.section.bands": "Band Configuration",
    "config.label.wifiSsid": "Wi-Fi SSID",
    "config.label.wifiPassword": "Wi-Fi Password",
    "config.label.mikrotikIp": "MikroTik IP",
    "config.label.mikrotikUser": "MikroTik User",
    "config.label.mikrotikPassword": "MikroTik Password",
    "config.label.mikrotikToken": "MikroTik Token",
    "config.label.mikrotikInterface": "MikroTik WLAN Interface",
    "config.label.band2": "2.4 GHz Band",
    "config.label.band5": "5 GHz Band",
    "config.label.scanDuration": "Scan duration (seconds)",
    "config.button.save": "Save Settings",
    "config.button.cancel": "Cancel",
    "config.status.captive": "Captive portal active. Connect to {ssid} (default IP 192.168.4.1).",
    "config.status.connected": "Current status: connected to configured network.",
    "config.status.disconnected": "Current status: not connected to configured network.",
    "config.notice.password": "Leave password fields blank to keep current credentials.",
    "config.save.success": "Settings saved. The device is reconnecting.",
    "config.save.failed": "Failed to save settings: {error}",
    "config.save.nochanges": "No changes to save.",
    "config.validation.ssidRequired": "Wi-Fi SSID is required when saving.",
    "config.validation.scanDurationInvalid": "Scan duration must be a positive number.",
    "config.clear.wifiPassword": "Clear stored Wi-Fi password",
    "config.clear.mikrotikPassword": "Clear stored MikroTik password",
    "config.clear.mikrotikToken": "Clear stored MikroTik token",
    "band.title": "Frequency Band",
    "networks.title": "Available Networks",
    "button.scan": "Scan for networks",
    "filter.all": "All",
    "filter.secured": "Secured",
    "filter.open": "Open",
    "scan.status.searching": "Searching for networks...",
    "label.ssid": "SSID",
    "label.password": "Password",
    "input.password.placeholder.required": "Enter password",
    "input.password.placeholder.optional": "Password (leave empty to use saved one)",
    "input.password.placeholder.none": "No password required",
    "badge.known": "Saved",
    "notification.scan.failedReason": "Scan failed: {error}",
    "notification.scan.timeout": "Scan timed out - please try again",
    "notification.password.required": "Please enter a password",
    "notification.connect.start": "Connecting to \"{ssid}\"...",
    "notification.connect.failed": "Connection failed: {error}",
    "notification.disconnect.success": "Disconnected",
    "notification.disconnect.failed": "Failed to disconnect: {error}",
    "notification.profile.deleted": "Removed saved network \"{ssid}\"",
    "notification.profile.deleteFailed": "Failed to remove saved network: {error}",
    "confirm.disconnect": "Really disconnect?",
    "detail.ssid": "SSID",
    "detail.band": "Band",
    "detail.signal": "Signal",
    "detail.snr": "SNR",
    "detail.ip": "IP address",
    "detail.netmask": "Netmask",
    "detail.gateway": "Gateway",
    "detail.dns": "DNS servers"
};

let translations = { ...DEFAULT_TRANSLATIONS };
let currentLanguage = 'en';

function t(key, params = {}) {
    const template = translations[key] ?? DEFAULT_TRANSLATIONS[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, prop) => {
        return params[prop] !== undefined ? params[prop] : `{${prop}}`;
    });
}

async function loadTranslations(language) {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
        return false;
    }

    try {
        const response = await fetch(`/i18n/${language}.json`, { cache: 'no-cache' });
        if (!response.ok) {
            return false;
        }
        const data = await response.json();
        translations = { ...DEFAULT_TRANSLATIONS, ...data };
        currentLanguage = language;
        return true;
    } catch (error) {
        console.warn('Failed to load translations for', language, error);
        return false;
    }
}

async function initTranslations() {
    const fallback = 'en';
    const browserLang = (navigator.language || fallback).split('-')[0].toLowerCase();
    const candidates = [];
    if (SUPPORTED_LANGUAGES.includes(browserLang)) {
        candidates.push(browserLang);
    }
    if (!candidates.includes(fallback)) {
        candidates.push(fallback);
    }

    for (const lang of candidates) {
        const loaded = await loadTranslations(lang);
        if (loaded) {
            break;
        }
    }

    document.documentElement.lang = currentLanguage;
}

function applyTranslationsToDOM() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.dataset.i18n);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
    });

    document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
        el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
    });
}

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

    const profileObj = entry.profile ?? null;
    const profileName = entry.profileName ?? (profileObj && profileObj.name) ?? '';

    return {
        ssid: entry.ssid,
        mac: macAddress,
        signal: Number.isFinite(signal) ? signal : 0,
        frequency: entry.frequency ?? entry.freq ?? null,
        security: security,
        known: !!entry.known,
        profile: profileObj,
        profileName,
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
    return Array.from(merged.values()).sort((a, b) => {
        const isKnownA = a.known ? 1 : 0;
        const isKnownB = b.known ? 1 : 0;

        if (isKnownA !== isKnownB) {
            return isKnownB - isKnownA; // known first
        }
        return (b.signal ?? 0) - (a.signal ?? 0);
    });
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

    const minDbm = state.config?.signal_min_dbm ?? -100;
    const maxDbm = state.config?.signal_max_dbm ?? -40;
    if (minDbm >= maxDbm) {
        return 0;
    }

    const clamped = Math.max(minDbm, Math.min(maxDbm, value));
    const percent = ((clamped - minDbm) / (maxDbm - minDbm)) * 100;
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

function buildStatusRows(status, includeNetworkInfo = false) {
    const rows = [];
    rows.push({ label: t('detail.ssid'), value: status.ssid || '-' });
    if (status.band) {
        rows.push({ label: t('detail.band'), value: status.band });
    }
    if (status.signal) {
        rows.push({ label: t('detail.signal'), value: formatSignal(status.signal) });
    }
    if (status.snr) {
        rows.push({ label: t('detail.snr'), value: `${status.snr} dB` });
    }
    if (includeNetworkInfo) {
        if (status.ip) {
            rows.push({ label: t('detail.ip'), value: status.ip });
        }
        if (status.netmask) {
            rows.push({ label: t('detail.netmask'), value: status.netmask });
        } else if (status.prefix) {
            const calculatedNetmask = prefixToNetmask(status.prefix);
            if (calculatedNetmask) {
                rows.push({ label: t('detail.netmask'), value: calculatedNetmask });
            }
        }
        if (status.gateway) {
            rows.push({ label: t('detail.gateway'), value: status.gateway });
        }
        if (status.dns && status.dns.length) {
            rows.push({ label: t('detail.dns'), value: status.dns.join(', ') });
        }
    }
    return rows;
}

function applyStatusPanel(status, elements, options) {
    const { statusDiv, statusText, detailsDiv, disconnectBtn } = elements;
    const {
        cssClass,
        message,
        includeNetworkInfo = false,
        showDisconnect = false,
        showDetails = true
    } = options;

    statusDiv.className = cssClass;
    statusText.textContent = message;

    if (showDetails) {
        const rows = buildStatusRows(status, includeNetworkInfo);
        const qualityMarkup = renderSignalQuality(status.signal);
        const detailsHtml = rows.map(row => `
            <div class="detail-row">
                <span class="label">${row.label}:</span>
                <span>${row.value}</span>
            </div>
        `).join('') + qualityMarkup;

        detailsDiv.style.display = detailsHtml ? 'block' : 'none';
        detailsDiv.innerHTML = detailsHtml;
    } else {
        detailsDiv.style.display = 'none';
        detailsDiv.innerHTML = '';
    }

    disconnectBtn.style.display = showDisconnect ? 'block' : 'none';
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
        const panelElements = { statusDiv, statusText, detailsDiv, disconnectBtn };

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
            applyStatusPanel(status, panelElements, {
                cssClass: 'status-connected',
                message: t('status.text.connected'),
                includeNetworkInfo: true,
                showDisconnect: true
            });
        } else if (status.connecting) {
            applyStatusPanel(status, panelElements, {
                cssClass: 'status-connecting',
                message: t('status.text.connecting'),
                showDisconnect: true
            });
        } else {
            applyStatusPanel(status, panelElements, {
                cssClass: 'status-disconnected',
                message: t('status.text.disconnected'),
                showDetails: false
            });
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
        const signalPercent = signalToPercent(network.signal);
        const securityState = network.security;
        const requiresPassword = securityState !== false;
        let icon = '';
        if (securityState === true) {
            icon = '🔒 ';
        } else if (securityState === false) {
            icon = '📡 ';
        }
        const badge = network.known ? `<span class="network-badge">${t('badge.known')}</span>` : '';
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
                profile: network.profile || null,
                profileName: network.profileName || (network.profile && network.profile.name) || '',
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
        const scanStatusText = document.querySelector('#scan-status [data-i18n="scan.status.searching"]');
        if (scanStatusText) {
            scanStatusText.textContent = t('scan.status.searching');
        }
        document.getElementById('scan-btn').disabled = true;
        state.selectedNetwork = null;
        hideConnectSection();
    }

    try {
        // Step 1: start the scan (non-blocking)
        const startResponse = await API.post('/api/scan/start?band=' + encodeURIComponent(requestedBand), {});

        if (startResponse.error) {
            console.error('Scan start error:', startResponse.error);
            showNotification(t('notification.scan.failedReason', { error: startResponse.error }), 'error');
            return;
        }

        const pollInterval = startResponse?.poll_interval_ms
            ?? state.config?.scan_poll_interval_ms
            ?? 500;
        const durationMs = startResponse?.duration_ms
            ?? state.config?.scan_duration_ms
            ?? 5000;
        const minReadyMs = startResponse?.min_ready_ms
            ?? state.config?.scan_min_ready_ms
            ?? durationMs;
        const timeoutMs = startResponse?.timeout_ms
            ?? state.config?.scan_timeout_ms
            ?? (minReadyMs + (state.config?.scan_result_grace_ms ?? 2000));

        let response = null;
        const scanStart = Date.now();

        while (true) {
            const elapsed = Date.now() - scanStart;

            if (elapsed >= timeoutMs) {
                break;
            }

            if (elapsed < minReadyMs) {
                const waitMs = Math.min(pollInterval, Math.max(0, minReadyMs - elapsed));
                if (waitMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
                continue;
            }

            const pollResponse = await API.get('/api/scan/result');

            if (!pollResponse || pollResponse.status === 'pending') {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                continue;
            }

            response = pollResponse;
            break;
        }

        if (!response) {
            showNotification(t('notification.scan.timeout'), 'error');
            return;
        }

        if (response.error) {
            console.error('Scan error:', response.error);
            showNotification(t('notification.scan.failedReason', { error: response.error }), 'error');
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
                    network.profileName = matched.name || '';
                    console.log(`  ✓ Matched network "${network.ssid}" with profile`);
                } else {
                    network.known = false;
                    network.profile = null;
                    network.profileName = '';
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
                    profile: refreshed.profile || null,
                    profileName: refreshed.profileName || (refreshed.profile && refreshed.profile.name) || state.selectedNetwork.profileName || '',
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
        showNotification(t('notification.scan.failedReason', { error: message }), 'error');
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
        passwordInput.placeholder = t('input.password.placeholder.required');
        passwordInput.value = '';
        return;
    }

    const requiresPassword = state.selectedNetwork.requiresPassword !== false;
    const known = !!state.selectedNetwork.known;
    passwordField.style.display = requiresPassword ? 'block' : 'none';

    if (requiresPassword && known) {
        // Saved encrypted network: password optional (can update stored value)
        passwordInput.placeholder = t('input.password.placeholder.optional');
    } else if (requiresPassword) {
        // New encrypted network: password required
        passwordInput.placeholder = t('input.password.placeholder.required');
    } else {
        passwordInput.placeholder = t('input.password.placeholder.none');
    }
}

function showConnectSection() {
    const section = document.getElementById('connect-section');
    const forgetBtn = document.getElementById('forget-btn');

    document.getElementById('selected-ssid').textContent = state.selectedNetwork.ssid;
    document.getElementById('password-input').value = '';
    updatePasswordUI();

    if (forgetBtn) {
        forgetBtn.style.display = state.selectedNetwork.known ? 'inline-block' : 'none';
        forgetBtn.disabled = !state.selectedNetwork.known;
    }

    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideConnectSection() {
    const section = document.getElementById('connect-section');
    section.style.display = 'none';
    const forgetBtn = document.getElementById('forget-btn');
    if (forgetBtn) {
        forgetBtn.style.display = 'none';
        forgetBtn.disabled = true;
    }
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
        showNotification(t('notification.password.required'), 'error');
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

        showNotification(t('notification.connect.start', { ssid: state.selectedNetwork.ssid }), 'success');
        hideConnectSection();

        // Refresh status after 3 seconds
        setTimeout(updateStatus, 3000);
    } catch(error) {
        const message = error && error.message ? error.message : error;
        showNotification(t('notification.connect.failed', { error: message }), 'error');
    } finally {
        document.getElementById('connect-btn').disabled = false;
    }
}

async function forgetSelectedNetwork() {
    if (!state.selectedNetwork || !state.selectedNetwork.known) return;

    const payload = {
        ssid: state.selectedNetwork.ssid
    };
    if (state.selectedNetwork.profileName) {
        payload.profileName = state.selectedNetwork.profileName;
    }

    try {
        const response = await API.post('/api/profile/delete', payload);
        if (response && response.error) {
            throw new Error(response.error);
        }

        const targetKey = state.selectedNetwork.key;
        const targetBand = state.selectedNetwork.band;

        Object.entries(state.networks).forEach(([bandKey, list]) => {
            const updated = list.map(item => {
                if (getNetworkKey(item) === targetKey) {
                    return {
                        ...item,
                        known: false,
                        profile: null,
                        profileName: ''
                    };
                }
                return item;
            });
            state.networks[bandKey] = bandKey === targetBand
                ? mergeNetworkResults(updated, [], bandKey)
                : updated;
        });

        const forgetBtn = document.getElementById('forget-btn');
        if (forgetBtn) {
            forgetBtn.style.display = 'none';
            forgetBtn.disabled = true;
        }

        const ssid = state.selectedNetwork.ssid;
        state.selectedNetwork.known = false;
        state.selectedNetwork.profile = null;
        state.selectedNetwork.profileName = '';
        state.selectedNetwork.requiresPassword = state.selectedNetwork.securityState !== false;

        updatePasswordUI();
        renderNetworkList();

        showNotification(t('notification.profile.deleted', { ssid }), 'success');
    } catch (error) {
        const message = error && error.message ? error.message : error;
        showNotification(t('notification.profile.deleteFailed', { error: message }), 'error');
    }
}

async function disconnect() {
    if (!confirm(t('confirm.disconnect'))) return;

    try {
        const response = await API.post('/api/disconnect', {});
        if (response && response.error) {
            throw new Error(response.error);
        }
        showNotification(t('notification.disconnect.success'), 'success');
        updateStatus();
    } catch(error) {
        const message = error && error.message ? error.message : error;
        showNotification(t('notification.disconnect.failed', { error: message }), 'error');
    }
}

async function loadConfig() {
    try {
        const config = await API.get('/api/config');
        state.config = config;

        state.config.scan_duration_ms = config.scan_duration_ms ?? 5000;
        state.config.scan_min_ready_ms = config.scan_min_ready_ms ?? state.config.scan_duration_ms;
        state.config.scan_result_grace_ms = config.scan_result_grace_ms ?? 2000;
        state.config.scan_poll_interval_ms = config.scan_poll_interval_ms ?? 500;
        state.config.scan_timeout_ms = config.scan_timeout_ms
            ?? (state.config.scan_min_ready_ms + state.config.scan_result_grace_ms + state.config.scan_poll_interval_ms);
        state.config.signal_min_dbm = config.signal_min_dbm ?? -100;
        state.config.signal_max_dbm = config.signal_max_dbm ?? -40;

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
        state.config = {
            band_2ghz: '2ghz-b/g/n',
            band_5ghz: '5ghz-a/n',
            scan_duration_ms: 5000,
            scan_min_ready_ms: 5000,
            scan_result_grace_ms: 2000,
            scan_poll_interval_ms: 500,
            scan_timeout_ms: 7500,
            signal_min_dbm: -100,
            signal_max_dbm: -40
        };
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
    await initTranslations();
    applyTranslationsToDOM();

    // Load config and initialize band buttons
    await loadConfig();

    // Wire up buttons
    document.getElementById('scan-btn').onclick = () => scan(false);
    document.getElementById('disconnect-btn').onclick = disconnect;
    document.getElementById('connect-btn').onclick = connect;
    document.getElementById('cancel-btn').onclick = hideConnectSection;
    document.getElementById('forget-btn').onclick = forgetSelectedNetwork;

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
