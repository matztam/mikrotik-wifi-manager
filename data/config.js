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
    "config.button.save": "Save Settings",
    "config.button.cancel": "Cancel",
    "config.status.captive": "Captive portal active. Connect to {ssid} (default IP 192.168.4.1).",
    "config.status.connected": "Current status: connected to configured network.",
    "config.status.disconnected": "Current status: not connected to configured network.",
    "config.notice.password": "Leave password fields blank to keep current credentials.",
    "config.save.success": "Settings saved. The device is reconnecting.",
    "config.save.failed": "Failed to save settings: {error}",
    "config.validation.ssidRequired": "Wi-Fi SSID is required when saving.",
    "config.clear.wifiPassword": "Clear stored Wi-Fi password",
    "config.clear.mikrotikPassword": "Clear stored MikroTik password",
    "config.clear.mikrotikToken": "Clear stored MikroTik token"
};

let translations = { ...DEFAULT_TRANSLATIONS };
let currentLanguage = 'en';
let settingsSnapshot = null;

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

    wifiSsid.value = data.wifi?.ssid || '';
    wifiPassword.value = '';
    mikrotikIp.value = data.mikrotik?.ip || '';
    mikrotikUser.value = data.mikrotik?.user || '';
    mikrotikPassword.value = '';
    mikrotikToken.value = '';
    mikrotikInterface.value = data.mikrotik?.wlan_interface || '';
    band2.value = data.bands?.band_2ghz || '';
    band5.value = data.bands?.band_5ghz || '';
    if (wifiClear) wifiClear.checked = false;
    if (mikrotikClearPass) mikrotikClearPass.checked = false;
    if (mikrotikClearToken) mikrotikClearToken.checked = false;

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
    const newToken = mikrotikTokenInput.value.trim();
    if (mikrotikClearToken && mikrotikClearToken.checked) {
        mikrotik.token = "";
    } else if (newToken !== '') {
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
    const band2Input = document.getElementById('band-2g');
    const band5Input = document.getElementById('band-5g');
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
        showToast(t('config.save.success'), 'success');
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
