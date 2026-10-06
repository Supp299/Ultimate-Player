// ============================================================
//  store.js  —  Persistence, global state, theme helpers
//
//  Fixes vs original:
//  · isElectron detection is renderer-safe (no node check that
//    can false-positive in some sandboxed builds).
//  · readJSON: null-safe — JSON.parse can return 0/false/""
//    which would be overridden by `|| defaultVal` in the original.
//    Now only falls back when the result is truly null/undefined.
//  · writeInternal: temp-file + rename pattern for Electron so
//    a crash mid-write never corrupts the JSON file.
//  · defaultKeys now includes 'ramFlush' (KeyG default) so the
//    RAM-flush shortcut added in media-engine/app-controller
//    has a persisted slot from day one.
//  · window.settings deep-merges nested objects (filters,
//    borderSettings, notificationSettings) so adding a new
//    nested key in a future version doesn't silently vanish
//    when old settings are loaded from disk.
//  · adjustBrightness: rewrote without implicit global mutation
//    (original mutated the `col` parameter directly).
//  · saveCustomLayout / getCustomLayout exposed on window so
//    grid.js / layout editor can call them without circular deps.
//  · beforeunload: only saves state when a valid track exists
//    and track index is in bounds — same as before, but guarded.
// ============================================================

'use strict';

// ── ELECTRON DETECTION ────────────────────────────────────────
// `process` exists in Electron's renderer with nodeIntegration=true.
// We guard against the case where `process` is a stub (web workers,
// some bundlers polyfill it as an empty object).
const isElectron = (
    typeof process !== 'undefined' &&
    typeof process.versions === 'object' &&
    typeof process.versions.electron === 'string'
);
window.isElectron = isElectron;

// ── NODE MODULES (Electron only) ─────────────────────────────
let _fs   = null;
let _path = null;

if (isElectron) {
    try {
        _fs   = require('fs');
        _path = require('path');
    } catch (e) {
        console.error('[store] Failed to load Node modules:', e);
    }
}

// ── PORTABLE DATA PATHS ───────────────────────────────────────
let DATA_DIR = '';
const FILES  = {};

if (isElectron && _fs && _path) {
    try {
        const isPackaged = !process.defaultApp && !/node_modules/.test(process.execPath);
        const baseDir    = isPackaged ? _path.dirname(process.execPath) : __dirname;
        DATA_DIR         = _path.join(baseDir, 'data');

        if (!_fs.existsSync(DATA_DIR)) {
            _fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        FILES.settings  = _path.join(DATA_DIR, 'settings.json');
        FILES.shortcuts = _path.join(DATA_DIR, 'shortcuts.json');
        FILES.layouts   = _path.join(DATA_DIR, 'layouts.json');
        FILES.custom    = _path.join(DATA_DIR, 'custom_layout.json');
        FILES.state     = _path.join(DATA_DIR, 'state.json');
        FILES.queue     = _path.join(DATA_DIR, 'recent_queue.json');
        FILES.startpoints = _path.join(DATA_DIR, 'start_points.json');
    } catch (e) {
        console.error('[store] Data path setup failed:', e);
    }
} else {
    // Web / localStorage keys
    FILES.settings  = 'up_settings';
    FILES.shortcuts = 'up_shortcuts';
    FILES.layouts   = 'up_layouts';
    FILES.custom    = 'up_custom';
    FILES.state     = 'up_state';
    FILES.queue     = 'up_recent_queue';
    FILES.startpoints = 'up_start_points';
}

// ── I/O ───────────────────────────────────────────────────────
/**
 * Read a JSON file (Electron) or localStorage key (web).
 * Returns `defaultVal` when the file is absent, empty, or unparseable.
 * Does NOT use `|| defaultVal` — that would discard a valid `false` or `0`.
 */
function readJSON(fileKey, defaultVal) {
    if (isElectron && _fs) {
        try {
            if (_fs.existsSync(fileKey)) {
                const raw = _fs.readFileSync(fileKey, 'utf-8').trim();
                if (raw) {
                    const parsed = JSON.parse(raw);
                    // null is valid JSON but useless as a settings object
                    return (parsed !== null && parsed !== undefined) ? parsed : defaultVal;
                }
            }
        } catch { /* corrupt file — fall through to default */ }
    } else {
        try {
            const raw = localStorage.getItem(fileKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                return (parsed !== null && parsed !== undefined) ? parsed : defaultVal;
            }
        } catch { /* quota exceeded or corrupt — fall through */ }
    }
    return defaultVal;
}

/**
 * Write JSON safely.
 * In Electron: write to a temp file first, then rename — if the process
 * crashes mid-write the old file survives intact.
 * In browser: localStorage.setItem (best-effort, no atomicity needed).
 */
function writeInternal(fileKey, data) {
    if (isElectron && _fs && _path) {
        const tmp = fileKey + '.tmp';
        try {
            _fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
            _fs.renameSync(tmp, fileKey);
        } catch (e) {
            console.error('[store] Save failed:', fileKey, e);
            // Try to clean up the temp file if rename failed
            try { _fs.unlinkSync(tmp); } catch { /* ignore */ }
        }
    } else {
        try {
            localStorage.setItem(fileKey, JSON.stringify(data));
        } catch { /* storage full — silently ignore */ }
    }
}

// ── GLOBAL RUNTIME STATE ──────────────────────────────────────
// These are initialised here so every other module can reference
// window.playlist etc. without caring about load order.
window.playlist              = [];
window.musicPlaylist         = [];
window.currentTrack          = 0;
window.currentMusicTrack     = 0;
window.resumeIndex           = -1;
window.gridCellsRef          = [];
window.layoutHistory         = [];
window.liveWatchers          = [];
window.originalPlaylist      = [];
window.isEditingLayout       = false;
window.isPaused              = false;
window.isGlobalMuted         = true;
window.isCtrlDown            = false;
window.isShiftDown           = false;
window.isExternalUpdate      = false;
window.liveSelectedIndices   = [];
window.gridQueueMap          = {};
window.currentLiveZonePointer = 0;

// cellTimers is managed as a Set in media-engine.js (via _cellTimerSet).
// Kept here as a shim for any legacy code that still reads window.cellTimers.
window.cellTimers = [];

// ── DEFAULT KEYBINDINGS ───────────────────────────────────────
const DEFAULT_KEYS = {
    play:       'Space',
    forward:    'ArrowRight',
    rewind:     'ArrowLeft',
    fullscreen: 'KeyF',
    next:       'KeyN',
    prev:       'KeyB',         // FIX 10: dedicated Prev Batch shortcut
    home:       'KeyH',
    minimize:   'KeyM',
    sidebar:    'KeyS',
    hideUI:     null,
    moveApp:    'AuxClick1',
    clearImg:   null,
    clearVid:   null,
    clearAll:   null,
    replayA:    null,
    replayB:    null,
    startPoint: null,           // toggle: set / cancel start point (hovered cell)
    endPoint:   null,           // toggle: set / cancel end point   (hovered cell)
    forward5:   null,
    backward5:  null,
    forward30:  null,
    backward30: null,
    // RAM flush shortcut (default: G)
    ramFlush:   'KeyG'
};
window.DEFAULT_KEYS = DEFAULT_KEYS;

// ── DEFAULT SETTINGS ──────────────────────────────────────────
const DEFAULT_SETTINGS = {
    mode:             'video',
    duration:         5000,
    shuffle:          false,
    color:            '#6366f1',
    bgIndex:          0,
    customBg:         null,
    bgImage:          null,
    gridSize:         '1',
    effect:           'none',
    effectSpeed:      0.8,
    videoEffect:      'none',
    randomVideoEffect: false,
    gapSize:          10,
    gridRoundness:    0,
    ratioTolerance:   0.3,
    randomDuration:   false,
    minRandomDuration: 5,
    maxRandomDuration: 30,
    showCountdown:    false,
    randomEffect:     false,
    enableLiveFolder: false,
    advanceRatioMode: false,
    showTransformBar: false,
    rotateFill:       false,
    showThumbnails:   false,
    liveSortMode:     'sequential',
    liveModifiers:    'shift_ctrl',
    liveFolders:      [],
    showQueueInfo:    false,
    customMixRatio:   { images: 1, videos: 1, random: false },
    autoFallback:     true,
    globalVolume:     1.0,
    volumeBoost:      false,   // allow volume up to 1000% (sidebar + per-cell sliders)
    floatRoundness:   0,
    floatOpacity:     1.0,
    hybridMode:       false,
    appOpacity:       1.0,
    sidebarWidth:     null,
    ctxMenuSections:  { startEnd: true, thumbnail: true, cellQueue: true },   // cell right-click menu sections
    borderSettings: {
        hue:       0,
        lightness: 50,
        opacity:   1.0
    },
    notificationSettings: {
        master: true,
        media:  true,
        grid:   true,
        queue:  true,
        file:   true,
        live:   true,
        system: true
    },
    filters: {
        brightness: 100,
        contrast:   100,
        saturate:   100,
        hue:        0,
        invert:     0,
        target:     'all'
    }
};

// ── DEEP MERGE ────────────────────────────────────────────────
// Shallow spread ( {...defaults, ...saved} ) silently drops new nested
// keys when the user has an old settings file that already has the parent
// key. E.g. if `filters` is in the saved file but lacks `target`, the
// default `target` is never applied. This fixes that.
function deepMerge(defaults, saved) {
    const result = { ...defaults };
    for (const key of Object.keys(saved)) {
        if (
            saved[key] !== null &&
            typeof saved[key] === 'object' &&
            !Array.isArray(saved[key]) &&
            typeof defaults[key] === 'object' &&
            defaults[key] !== null &&
            !Array.isArray(defaults[key])
        ) {
            result[key] = deepMerge(defaults[key], saved[key]);
        } else {
            result[key] = saved[key];
        }
    }
    return result;
}

// ── BOOTSTRAP ─────────────────────────────────────────────────
// Merge saved shortcuts on top of defaults so newly added actions
// always have at least a null slot (no "undefined" reads elsewhere).
const savedKeys = readJSON(FILES.shortcuts, {});
window.keyMap = { ...DEFAULT_KEYS, ...savedKeys };

// ONE KEY = ONE ACTION. The dispatcher only ever fires the FIRST action that owns a key, so a
// saved file with duplicates is cleaned the same way: the first action keeps the key, the later
// ones are cleared (and reported once at startup).
window.dedupeKeyMap = km => {
    const seen = new Set(), cleared = [];
    for (const k of Object.keys(km)) {
        const c = km[k];
        if (!c) continue;
        if (seen.has(c)) { km[k] = null; cleared.push(k); } else seen.add(c);
    }
    return cleared;
};
window.keyConflictsCleared = window.dedupeKeyMap(window.keyMap);

window.savedLayouts = readJSON(FILES.layouts, []);

// ── START / END POINTS ────────────────────────────────────────
// { [fileId]: { name, path, time?: startSeconds, end?: endSeconds, savedAt } }
// Written immediately on every change (tiny file) so nothing is lost on crash.
window.startPoints = readJSON(FILES.startpoints, {});
if (!window.startPoints || typeof window.startPoints !== 'object' || Array.isArray(window.startPoints)) {
    window.startPoints = {};
}
const _isNum = v => typeof v === 'number' && isFinite(v);
window.saveStartPoints  = () => { writeInternal(FILES.startpoints, window.startPoints); window.refreshStartMarkers?.(); };
window.getStartPointId  = f  => f ? (f.path || `${f.name}_${f.size || 0}`) : null;
window.getStartPoint    = f  => { const e = window.startPoints[window.getStartPointId(f)]; return (e && _isNum(e.time)) ? e.time : null; };
window.getEndPoint      = f  => { const e = window.startPoints[window.getStartPointId(f)]; return (e && _isNum(e.end))  ? e.end  : null; };
const _putPoint = (f, key, t) => {
    const id = window.getStartPointId(f);
    if (!id) return;
    const e = window.startPoints[id] || {};
    e.name = f.name; e.path = f.path || ''; e[key] = Math.round(t * 100) / 100; e.savedAt = Date.now();
    window.startPoints[id] = e;
    window.saveStartPoints();
};
const _dropPoint = (id, key) => {
    const e = window.startPoints[id];
    if (!e) return;
    delete e[key];
    if (!_isNum(e.time) && !_isNum(e.end)) delete window.startPoints[id];   // nothing left → drop the entry
    window.saveStartPoints();
};
window.setStartPoint       = (f, t) => _putPoint(f, 'time', t);
window.setEndPoint         = (f, t) => _putPoint(f, 'end',  t);
window.clearStartPoint     = id => _dropPoint(id, 'time');
window.clearEndPoint       = id => _dropPoint(id, 'end');
window.clearAllStartPoints = ()  => { window.startPoints = {}; window.saveStartPoints(); };   // start AND end points

const savedSettings = readJSON(FILES.settings, {});
window.settings     = deepMerge(DEFAULT_SETTINGS, savedSettings);

// Ensure liveFolders is always an array (could be corrupted on disk)
if (!Array.isArray(window.settings.liveFolders)) {
    window.settings.liveFolders = [];
}

// ── SAVE LOGIC ────────────────────────────────────────────────
let _saveTimer = null;

/**
 * Debounced save — coalesces rapid setting changes into one disk write.
 * Always flushes synchronously on beforeunload.
 */
window.saveConfig = function() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        _performSave();
        _saveTimer = null;
    }, 500);
};

function _performSave() {
    writeInternal(FILES.settings,  window.settings);
    writeInternal(FILES.layouts,   window.savedLayouts);
    writeInternal(FILES.shortcuts, window.keyMap);
}

window.addEventListener('beforeunload', () => {
    // Cancel pending debounced save and do it synchronously now
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    _performSave();

    // Persist resume position if there is a valid current track
    if (
        window.playlist.length > 0 &&
        window.currentTrack >= 0 &&
        window.currentTrack < window.playlist.length
    ) {
        const file = window.playlist[window.currentTrack];
        writeInternal(FILES.state, { fileName: file.name });
    }

    // ── Save recent queue for session restore ─────────────────
    // Only serialise the fields needed to rebuild the file objects.
    // We skip blob URLs, thumbnailUrl, etc. — they're transient.
    if (window.playlist.length > 0) {
        const serializable = window.playlist
            .filter(f => f.path && !f.isWeb)   // local files only
            .map(f => ({
                name: f.name,
                path: f.path,
                size: f.size  || 0,
                type: f.type  || ''
            }));
        if (serializable.length > 0) {
            writeInternal(FILES.queue, {
                savedAt:      Date.now(),
                currentTrack: window.currentTrack,
                mode:         window.settings.mode,
                files:        serializable
            });
        }
    }
});

// Custom layout (layout editor)
window.saveCustomLayout = data  => writeInternal(FILES.custom, data);
window.getCustomLayout  = ()    => readJSON(FILES.custom, null);
window.saveState        = ()    => {};   // no-op — state is saved in beforeunload

// Recent queue restore — called by app-controller on play-shortcut when queue is empty
window.loadRecentQueue  = ()    => readJSON(FILES.queue, null);
window.clearRecentQueue = ()    => writeInternal(FILES.queue, null);

// ── BACKGROUND THEMES ─────────────────────────────────────────
const BG_THEMES = [
    { bg: '#0f0f13', sb: '#18181b', card: '#27272a' },   // 0 Dark (default)
    { bg: '#000000', sb: '#000000', card: '#111111' },   // 1 OLED Black
    { bg: '#0b1120', sb: '#111827', card: '#1f2937' },   // 2 Midnight Blue
    { bg: '#171717', sb: '#262626', card: '#404040' },   // 3 Charcoal
    { bg: '#05100b', sb: '#0a1f16', card: '#122e22' },   // 4 Forest
    { bg: '#160808', sb: '#290f0f', card: '#421616' },   // 5 Crimson
    { bg: '#0f0e16', sb: '#181624', card: '#252236' },   // 6 Purple Dusk
    { bg: '#16110d', sb: '#241c15', card: '#362a20' }    // 7 Sepia
];

// ── THEME SETTERS ─────────────────────────────────────────────
window.setTheme = function(color, save = true) {
    window.settings.color = color;
    document.documentElement.style.setProperty('--accent', color);
    if (save) window.saveConfig();
};

window.setBg = function(index, save = true) {
    if (!BG_THEMES[index]) index = 0;
    window.settings.bgIndex  = index;
    window.settings.customBg = null;
    window.settings.bgImage  = null;
    window.settings.oled     = (index === 1);
    document.documentElement.style.setProperty('--bg-image', 'none');
    const t = BG_THEMES[index];
    _applyBg(t.bg, t.sb, t.card);
    if (save) window.saveConfig();
};

window.setCustomBg = function(hex, save = true) {
    window.settings.bgIndex  = -1;
    window.settings.customBg = hex;
    window.settings.bgImage  = null;
    document.documentElement.style.setProperty('--bg-image', 'none');
    _applyBg(hex, _adjustBrightness(hex, 10), _adjustBrightness(hex, 20));
    if (save) window.saveConfig();
};

window.setBgImage = function(url) {
    window.settings.bgIndex  = -1;
    window.settings.customBg = null;
    window.settings.bgImage  = url;
    window.settings.oled     = false;
    document.documentElement.style.setProperty('--bg-image', `url(${url})`);
    window.saveConfig();
};

function _applyBg(bg, sb, card) {
    const root = document.documentElement;
    root.style.setProperty('--bg-color',    bg);
    root.style.setProperty('--sidebar-bg',  sb);
    root.style.setProperty('--card-bg',     card);
}

/**
 * Shift all three RGB channels of a hex colour by `amt`.
 * Original mutated the `col` parameter — this version does not.
 */
function _adjustBrightness(hex, amt) {
    let col = hex.startsWith('#') ? hex.slice(1) : hex;
    const prefix = hex.startsWith('#') ? '#' : '';

    const num = parseInt(col, 16);
    const clamp = v => Math.max(0, Math.min(255, v));

    const r = clamp(( num >> 16)         + amt);
    const g = clamp(((num >>  8) & 0xFF) + amt);
    const b = clamp(( num        & 0xFF) + amt);

    return prefix + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
