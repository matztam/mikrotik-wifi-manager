const API = {
    async get(path) {
        const response = await fetch(path, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    },
    async post(path, data) {
        const response = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `HTTP ${response.status}`);
        }
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
    "config.save.reconnecting": "Settings saved. Attempting to reconnect...",
    "config.validation.ssidRequired": "Wi-Fi SSID is required when saving.",
    "config.validation.scanDurationInvalid": "Scan duration must be a positive number.",
    "config.clear.wifiPassword": "Clear stored Wi-Fi password",
    "config.clear.mikrotikPassword": "Clear stored MikroTik password",
    "config.clear.mikrotikToken": "Clear stored MikroTik token"
};

let translations = { ...DEFAULT_TRANSLATIONS };
let currentLanguage = 'en';
let settingsSnapshot = null;
const PRESET_BANDS = {
    band2: [
        '2ghz-b/g/n',
        '2ghz-g/n',
        '2ghz-n'
    ],
    band5: [
        '5ghz-a/n',
        '5ghz-a/n/ac',
        '5ghz-a/n/ac/ax'
    ]
};

function t(key, params = {}) {
    const template = translations[key] ?? key;
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
        if (!response.ok) return false;
        const data = await response.json();
        translations = { ...DEFAULT_TRANSLATIONS, ...data };
        currentLanguage = language;
        return true;
    } catch (error) {
        console.warn('Failed to load translations', error);
        return false;
    }
}

async function initTranslations() {
    const fallback = 'en';
    const browserLang = (navigator.language || fallback).split('-')[0].toLowerCase();
    const candidates = SUPPORTED_LANGUAGES.includes(browserLang) ? [browserLang, fallback] : [fallback];
    for (const lang of candidates) {
        const loaded = await loadTranslations(lang);
        if (loaded) break;
    }
    document.documentElement.lang = currentLanguage;
}

function applyTranslationsToDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
    });
}

let toastTimer = null;
let toastHideTimer = null;

function showToast(message, type = 'info', duration = 4000) {
    const toast = document.getElementById('toast-container');
    if (!toast) return;

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

function setStatusMessage(data) {
    const statusEl = document.getElementById('status-message');
    if (!statusEl || !data || !data.status) return;

    if (data.status.captive_portal) {
        statusEl.textContent = t('config.status.captive', { ssid: data.status.ap_ssid || 'MikroTikSetup' });
    } else if (data.status.wifi_connected) {
        statusEl.textContent = t('config.status.connected');
    } else {
        statusEl.textContent = t('config.status.disconnected');
    }
}

function fillForm(data) {
    settingsSnapshot = data;
    const wifiSsid = document.getElementById('wifi-ssid');
    const wifiPassword = document.getElementById('wifi-password');
    const mikrotikIp = document.getElementById('mikrotik-ip');
    const mikrotikUser = document.getElementById('mikrotik-user');
    const mikrotikPassword = document.getElementById('mikrotik-password');
    const mikrotikToken = document.getElementById('mikrotik-token');
    const mikrotikInterface = document.getElementById('mikrotik-interface');
    const band2 = document.getElementById('band-2g');
    const band5 = document.getElementById('band-5g');
    const wifiClear = document.getElementById('wifi-clear-password');
    const mikrotikClearPass = document.getElementById('mikrotik-clear-password');
    const mikrotikClearToken = document.getElementById('mikrotik-clear-token');
    const scanDurationInput = document.getElementById('scan-duration');

    const currentBand2 = data.bands?.band_2ghz || '';
    const currentBand5 = data.bands?.band_5ghz || '';
    const currentScanDuration = data.scan?.duration_seconds || '';

    const ensureOptions = (selectEl, options, currentValue) => {
        selectEl.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.hidden = true;
        placeholder.textContent = '—';
        selectEl.appendChild(placeholder);
        options.forEach(opt => {
            const optionEl = document.createElement('option');
            optionEl.value = opt;
            optionEl.textContent = opt;
            selectEl.appendChild(optionEl);
        });
        if (currentValue && !options.includes(currentValue)) {
            const customOption = document.createElement('option');
            customOption.value = currentValue;
            customOption.textContent = currentValue;
            selectEl.appendChild(customOption);
        }
        selectEl.value = currentValue || '';
    };

    ensureOptions(band2, PRESET_BANDS.band2, currentBand2);
    ensureOptions(band5, PRESET_BANDS.band5, currentBand5);

    wifiSsid.value = data.wifi?.ssid || '';
    wifiPassword.value = '';
    mikrotikIp.value = data.mikrotik?.ip || '';
    mikrotikUser.value = data.mikrotik?.user || '';
    mikrotikPassword.value = '';
    mikrotikToken.value = '';
    mikrotikInterface.value = data.mikrotik?.wlan_interface || '';
    if (wifiClear) wifiClear.checked = false;
    if (mikrotikClearPass) mikrotikClearPass.checked = false;
    if (mikrotikClearToken) mikrotikClearToken.checked = false;
    if (scanDurationInput) scanDurationInput.value = currentScanDuration || '';

    setStatusMessage(data);
}

async function loadSettings() {
    try {
        const data = await API.get('/api/settings');
        fillForm(data);
    } catch (error) {
        console.error('Failed to load settings', error);
        showToast(t('config.save.failed', { error: error.message || error }), 'error');
    }
}

function buildSettingsPayload() {
    if (!settingsSnapshot) return null;

    const payload = {};
    const wifi = {};
    const wifiSsidInput = document.getElementById('wifi-ssid');
    const wifiPasswordInput = document.getElementById('wifi-password');
    const wifiClearCheckbox = document.getElementById('wifi-clear-password');

    const newSsid = wifiSsidInput.value.trim();
    if (newSsid !== settingsSnapshot.wifi?.ssid) {
        if (newSsid.length === 0) {
            throw new Error(t('config.validation.ssidRequired'));
        }
        wifi.ssid = newSsid;
    }
    if (wifiClearCheckbox && wifiClearCheckbox.checked) {
        wifi.password = "";
    } else if (wifiPasswordInput.value.length > 0) {
        wifi.password = wifiPasswordInput.value;
    }
    if (Object.keys(wifi).length > 0) {
        payload.wifi = wifi;
    }

    const mikrotik = {};
    const mikrotikIpInput = document.getElementById('mikrotik-ip');
    const mikrotikUserInput = document.getElementById('mikrotik-user');
    const mikrotikPasswordInput = document.getElementById('mikrotik-password');
    const mikrotikTokenInput = document.getElementById('mikrotik-token');
    const mikrotikInterfaceInput = document.getElementById('mikrotik-interface');
    const mikrotikClearPass = document.getElementById('mikrotik-clear-password');
    const mikrotikClearToken = document.getElementById('mikrotik-clear-token');
    const band2Input = document.getElementById('band-2g');
    const band5Input = document.getElementById('band-5g');
    const scanDurationInput = document.getElementById('scan-duration');

    const newIp = mikrotikIpInput.value.trim();
    if (newIp !== (settingsSnapshot.mikrotik?.ip || '')) {
        mikrotik.ip = newIp;
    }
    const newUser = mikrotikUserInput.value.trim();
    if (newUser !== (settingsSnapshot.mikrotik?.user || '')) {
        mikrotik.user = newUser;
    }
    if (mikrotikClearPass && mikrotikClearPass.checked) {
        mikrotik.password = "";
    } else if (mikrotikPasswordInput.value.length > 0) {
        mikrotik.password = mikrotikPasswordInput.value;
    }
    if (mikrotikClearToken && mikrotikClearToken.checked) {
        mikrotik.token = "";
    } else if (mikrotikTokenInput.value.trim().length > 0) {
        const newToken = mikrotikTokenInput.value.trim();
        if (newToken !== (settingsSnapshot.mikrotik?.token || '')) {
            mikrotik.token = newToken;
        }
    }
    const newInterface = mikrotikInterfaceInput.value.trim();
    if (newInterface !== (settingsSnapshot.mikrotik?.wlan_interface || '')) {
        mikrotik.wlan_interface = newInterface;
    }
    if (Object.keys(mikrotik).length > 0) {
        payload.mikrotik = mikrotik;
    }

    const bands = {};
    const newBand2 = band2Input.value.trim();
    if (newBand2 !== (settingsSnapshot.bands?.band_2ghz || '')) {
        bands.band_2ghz = newBand2;
    }
    const newBand5 = band5Input.value.trim();
    if (newBand5 !== (settingsSnapshot.bands?.band_5ghz || '')) {
        bands.band_5ghz = newBand5;
    }
    if (Object.keys(bands).length > 0) {
        payload.bands = bands;
    }

    const scan = {};
    if (scanDurationInput) {
        const rawValue = scanDurationInput.value.trim();
        if (rawValue.length > 0) {
            const parsed = parseInt(rawValue, 10);
            if (Number.isNaN(parsed) || parsed <= 0) {
                throw new Error(t('config.validation.scanDurationInvalid'));
            }
            if (parsed !== (settingsSnapshot.scan?.duration_seconds || 0)) {
                scan.duration_seconds = parsed;
            }
        }
    }
    if (Object.keys(scan).length > 0) {
        payload.scan = scan;
    }

    return Object.keys(payload).length > 0 ? payload : null;
}

async function saveSettings() {
    try {
        const payload = buildSettingsPayload();
        if (!payload) {
            showToast(t('config.save.nochanges'), 'info');
            return;
        }

        const result = await API.post('/api/settings', payload);
        if (result.wifi_changed) {
            showToast(t('config.save.reconnecting'), 'info', 4000);
        } else {
            showToast(t('config.save.success'), 'success');
        }
        if (result.captive_portal) {
            showToast(t('config.status.captive', { ssid: settingsSnapshot?.status?.ap_ssid || 'MikroTikSetup' }), 'info', 6000);
        }
        await loadSettings();
    } catch (error) {
        showToast(t('config.save.failed', { error: error.message || error }), 'error');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await initTranslations();
    applyTranslationsToDOM();
    await loadSettings();

    document.getElementById('save-btn').onclick = saveSettings;
});
