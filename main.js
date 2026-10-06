// ============================================================
//  main.js  —  Electron main process
//  Fixes: server memory leak (no close callback race), safe
//  window-move state, portable path dedup, cleaner lifecycle.
// ============================================================

const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs   = require('fs');
const os   = require('os');

// ── 1. PORTABLE DATA PATH ───────────────────────────────────
const isPackaged = !process.defaultApp && !/node_modules/.test(process.execPath);
const baseDir    = isPackaged ? path.dirname(process.execPath) : __dirname;
const portableDataPath = path.join(baseDir, 'data');

if (!fs.existsSync(portableDataPath)) {
    fs.mkdirSync(portableDataPath, { recursive: true });
}
app.setPath('userData', portableDataPath);

// ── 2. GPU / RENDERER FLAGS ─────────────────────────────────
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-oop-rasterization');
app.commandLine.appendSwitch('enable-hardware-accelerated-video-decode');
app.commandLine.appendSwitch('num-raster-threads', '4');
app.commandLine.appendSwitch('disable-zero-copy');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Exposes window.gc() in the renderer so the RAM-flush shortcut works
app.commandLine.appendSwitch('js-flags', '--expose-gc');

// ── 3. STATE ────────────────────────────────────────────────
const SERVER_PORT = 3000;
let server = null;

// Per-window move state (keyed by webContents id to avoid cross-window bleed)
const moveState = new Map();   // wcId → { isDragging, startMouse, startBounds }

// Per-window "Always on Top" state. The MAIN process is the single source of
// truth — the renderer only mirrors it (via the 'pin-status' message).
const pinState = new Map();    // wcId → { on: boolean, timer: Timeout|null }

// 'screen-saver' is the highest z-order level. On Windows the default
// 'floating' level is placed *behind the taskbar* and is easily pushed below
// other topmost windows; 'screen-saver' sits above both. (On macOS it also
// allows showing above full-screen apps.)
const PIN_LEVEL       = 'screen-saver';
const PIN_REASSERT_MS = 1000;

// ── 4. HELPERS ──────────────────────────────────────────────
function getLocalIP() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (!iface.internal && iface.family === 'IPv4') return iface.address;
        }
    }
    return '127.0.0.1';
}

const MEDIA_EXTS = new Set([
    '.mp4','.mkv','.webm','.avi','.mov','.ts','.m2ts','.wmv','.flv','.3gp','.ogv',
    '.jpg','.jpeg','.png','.gif','.webp','.bmp','.tiff','.svg','.ico'
]);

function getFilesFromArgs(args) {
    return args.filter(arg => {
        if (!arg || arg.startsWith('--') || arg === '.') return false;
        try {
            return MEDIA_EXTS.has(path.extname(arg).toLowerCase()) &&
                   path.isAbsolute(arg) &&
                   fs.existsSync(arg);
        } catch { return false; }
    });
}

// ── PIN (ALWAYS ON TOP) ─────────────────────────────────────
// Windows (and some window managers) silently drop / bury the topmost flag
// when the window leaves fullscreen, is restored, loses focus to another
// topmost window, etc. So instead of calling setAlwaysOnTop() once and hoping,
// we re-assert it on the relevant window events and on a light timer for as
// long as the pin is active.
function raiseWindow(win) {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) return;                 // never force-restore a minimized window
    win.setAlwaysOnTop(true, PIN_LEVEL);           // re-applies HWND_TOPMOST
    win.moveTop();                                 // top of the topmost group, no focus steal
}

function isPinned(wcId) {
    const st = pinState.get(wcId);
    return !!(st && st.on);
}

function clearPin(wcId) {
    const st = pinState.get(wcId);
    if (st && st.timer) clearInterval(st.timer);
    pinState.delete(wcId);
}

function setPinned(win, wcId, on) {
    if (!win || win.isDestroyed()) return;

    const st = pinState.get(wcId) || { on: false, timer: null };
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    st.on = !!on;

    if (st.on) {
        raiseWindow(win);
        if (process.platform === 'darwin') {
            win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }
        st.timer = setInterval(() => raiseWindow(win), PIN_REASSERT_MS);
    } else {
        win.setAlwaysOnTop(false);
        if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(false);
    }

    pinState.set(wcId, st);
    sendPinStatus(win);
}

function sendPinStatus(win) {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (wc && !wc.isDestroyed()) wc.send('pin-status', isPinned(wc.id));
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1000,
        height: 720,
        minWidth: 100,
        minHeight: 100,
        frame: false,
        backgroundColor: '#0f0f13',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false,
            backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });

    win.loadFile('index.html');

    // Cache the webContents id NOW, before any chance of destruction.
    // win.webContents.id is valid from creation until the process ends,
    // but win.webContents itself becomes null after 'closed' fires —
    // so we must never read .id inside a 'closed' handler.
    const wcId = win.webContents.id;

    win.webContents.on('did-finish-load', () => {
        const files = getFilesFromArgs(process.argv);
        if (files.length === 0) return;

        // Guard the setTimeout callback: the user might close the window
        // within the 600 ms delay, destroying webContents before the timer
        // fires. isDestroyed() is the only safe check at that point.
        const wc = win.webContents;
        setTimeout(() => {
            if (!wc.isDestroyed()) {
                wc.send('open-external-files', files);
            }
        }, 600);
    });

    // 'will-close' fires BEFORE webContents is destroyed, so wcId is still
    // valid. 'closed' fires after — webContents is already null by then.
    win.on('will-close', () => moveState.delete(wcId));
    win.on('closed',     () => clearPin(wcId));     // stop the re-assert timer

    // Re-assert the pin whenever Windows/the WM might have dropped it.
    // 'blur' gets a short delay so we raise ourselves AFTER the other app
    // (e.g. an Explorer folder) has finished taking focus.
    const reassert = () => { if (isPinned(wcId)) raiseWindow(win); };
    ['focus', 'show', 'restore', 'maximize', 'unmaximize',
     'enter-full-screen', 'leave-full-screen'].forEach(ev => win.on(ev, reassert));
    win.on('blur', () => {
        if (!isPinned(wcId)) return;
        reassert();
        setTimeout(reassert, 80);
    });

    return win;
}

// ── 5. APP LIFECYCLE ────────────────────────────────────────
app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    stopServer();
    if (process.platform !== 'darwin') app.quit();
});

// ── 6. SERVER HELPERS ───────────────────────────────────────
function stopServer(cb) {
    if (!server) { cb && cb(); return; }
    server.close(() => { server = null; cb && cb(); });
}

function startServer(sender) {
    server = http.createServer((req, res) => {
        const reqUrl = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
        const filePath = path.join(__dirname, reqUrl);
        fs.readFile(filePath, (err, content) => {
            if (err) { res.writeHead(404); res.end(); }
            else     { res.writeHead(200); res.end(content); }
        });
    });

    server.on('error', (err) => {
        server = null;
        sender.send('server-status', { active: false, error: err.message });
    });

    server.listen(SERVER_PORT, () => {
        sender.send('server-status', {
            active: true,
            url: `http://${getLocalIP()}:${SERVER_PORT}`
        });
    });
}

// ── 7. IPC ──────────────────────────────────────────────────
ipcMain.handle('select-dirs', async (_event, mode) => {
    const properties = mode === 'files'
        ? ['openFile', 'multiSelections']
        : ['openDirectory', 'multiSelections'];

    const filters = mode === 'files' ? [{
        name: 'Media Files',
        extensions: ['mp4','mkv','webm','avi','mov','ts','m2ts','wmv','flv','3gp','ogv',
                     'jpg','jpeg','png','gif','webp','bmp','tiff','svg','ico']
    }] : [];

    const result = await dialog.showOpenDialog({ properties, filters });
    return result.filePaths || [];
});

ipcMain.on('app-command', (event, command, data) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const wcId    = event.sender.id;
    const display = screen.getDisplayMatching(win.getBounds());
    const { x: wx, y: wy, width: ww, height: wh } = display.workArea;

    switch (command) {

        case 'exit':       app.quit();            break;
        case 'minimize':   win.minimize();        break;

        // Explicit on/off (renderer sends the desired state) — avoids the
        // renderer/main desync a blind toggle causes.
        case 'set-pin':
            setPinned(win, wcId, !!data);
            break;

        case 'toggle-pin':
            setPinned(win, wcId, !isPinned(wcId));
            break;

        // Renderer asks for the real state (e.g. after a page reload)
        case 'get-pin':
            sendPinStatus(win);
            break;

        case 'restore':
            win.setFullScreen(false);
            win.unmaximize();
            win.setSize(1280, 720);
            win.center();
            break;

        case 'set-opacity':
            win.setOpacity(Math.max(0.1, Math.min(1, parseFloat(data) || 1)));
            break;

        // ── WINDOW DRAG ──────────────────────────────────
        case 'start-move': {
            const cursor = screen.getCursorScreenPoint();
            moveState.set(wcId, {
                isDragging:   true,
                startMouse:   cursor,
                startBounds:  win.getBounds()
            });
            break;
        }

        case 'stop-move':
            moveState.delete(wcId);
            break;

        case 'move-window': {
            const ms = moveState.get(wcId);
            if (!ms || !ms.isDragging) break;
            const cur = screen.getCursorScreenPoint();
            win.setBounds({
                x:      Math.round(ms.startBounds.x + (cur.x - ms.startMouse.x)),
                y:      Math.round(ms.startBounds.y + (cur.y - ms.startMouse.y)),
                width:  ms.startBounds.width,
                height: ms.startBounds.height
            });
            break;
        }

        // ── SNAP / FULLSCREEN ─────────────────────────────
        case 'full':
            win.setFullScreen(!win.isFullScreen());
            break;

        case 'left':
            win.setBounds({ x: wx, y: wy, width: Math.floor(ww / 2), height: wh });
            break;

        case 'right':
            win.setBounds({ x: wx + Math.floor(ww / 2), y: wy, width: Math.floor(ww / 2), height: wh });
            break;

        case 'top':
            win.setBounds({ x: wx, y: wy, width: ww, height: Math.floor(wh / 2) });
            break;

        case 'bottom':
            win.setBounds({ x: wx, y: wy + Math.floor(wh / 2), width: ww, height: Math.floor(wh / 2) });
            break;

        // ── HTTP SERVER ───────────────────────────────────
        case 'toggle-server':
            if (server) {
                stopServer(() => event.sender.send('server-status', { active: false }));
            } else {
                startServer(event.sender);
            }
            break;
    }
});
