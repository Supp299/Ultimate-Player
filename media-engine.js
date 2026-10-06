// ============================================================
//  media-engine.js  —  Grid rendering & playback engine
//
//  Key fixes vs original:
//  · All per-cell mousemove/mouseup listeners are stored and
//    removed on unmount (no more global listener accumulation).
//  · aggressivelyCleanOldMedia: el.load() removed (crashed HW
//    decoders), blob revoke before src clear.
//  · renderMediaContent: single-call transform-bar attachment,
//    no duplicate wheel listener, proper cleanup on re-render.
//  · Seek-after-memory-flush shortcut (configurable delta).
//  · cellTimers pruned with a Set, not a growing array.
//  · getVirtualContentDimensions: safe division guards.
//  · validateMediaRatio: no reentrant mountMediaInCell calls
//    inside loadedmetadata callbacks.
//  · FIX 11: _filterUnseenUnique — sequential mode now excludes
//    files already active in other cells (previously only shuffle
//    mode did), and both sequential + shuffle share one "seen this
//    pass" history so the whole queue is shown once, top to bottom
//    (or fully shuffled), before any file repeats. Fixes the same
//    file appearing in multiple grid cells at once.
// ============================================================

'use strict';

window.shuffleCycleHistory = new Set();

// ── SETTINGS ─────────────────────────────────────────────────
// How many seconds to seek back after the RAM-flush shortcut.
// The user can change this in the keybind panel via `seekBackDelta`.
window.SEEK_BACK_DELTA = -30;   // negative = backward

// ── ICONS ────────────────────────────────────────────────────
const GRID_ICONS = {
    play:      `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
    pause:     `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`,
    mute:      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
    sound:     `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    soundLow:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    loop:      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>`,
    snowflake: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/><path d="M20 16l-4-4 4-4"/><path d="M4 8l4 4-4 4"/><path d="M16 4l-4 4-4-4"/><path d="M8 20l4-4 4 4"/></svg>`,
    navLeft:   `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/></svg>`,
    navRight:  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 17l5-5-5-5M6 17l5-5-5-5"/></svg>`,
    save:      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`
};

const TF_ICONS = {
    rotL:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
    rotR:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`,
    mirH:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h5M17 12h5M7 8l-5 4 5 4M17 8l5 4-5 4"/></svg>`,
    mirV:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h20M12 2v5M12 17v5M8 7l4-5 4 5M8 17l4 5 4-5"/></svg>`,
    strH:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 7l4 5-4 5M6 7l-4 5 4 5M2 12h20"/></svg>`,
    shrH:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 7l5 5-5 5M22 7l-5 5 5 5M12 2v20"/></svg>`,
    strV:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 18l5 4 5-4M7 6l5-4 5 4M12 2v20"/></svg>`,
    shrV:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 2l5 5 5-5M7 22l5-5 5 5M2 12h20"/></svg>`,
    reset:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
    save:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
    active: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v5"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v10"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`
};

// ── TIME FORMAT ───────────────────────────────────────────────
function formatCellTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── TRANSFORM ─────────────────────────────────────────────────
function applyTransform(cell) {
    const media = cell.querySelector('video.media-active, img.media-active, canvas.media-active');
    if (!media) return;
    const r    = parseInt(cell.dataset.tfRot  || 0);
    const sx   = parseFloat(cell.dataset.tfSx   || 1);
    const sy   = parseFloat(cell.dataset.tfSy   || 1);
    const sh   = parseFloat(cell.dataset.tfSh   || 1);
    const sv   = parseFloat(cell.dataset.tfSv   || 1);
    const tx   = parseFloat(cell.dataset.tfX    || 0);
    const ty   = parseFloat(cell.dataset.tfY    || 0);
    const zoom = parseFloat(cell.dataset.tfZoom || 1);

    let ax = 1, ay = 1;
    if (window.settings.rotateFill && (r % 180 !== 0)) {
        const rect = cell.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            ax = rect.height / rect.width;
            ay = rect.width  / rect.height;
        }
    }
    const finalX = sx * sh * ax * zoom;
    const finalY = sy * sv * ay * zoom;
    media.style.setProperty(
        'transform',
        `translate(${tx}px, ${ty}px) rotate(${r}deg) scale(${finalX}, ${finalY})`,
        'important'
    );
}

function getVirtualContentDimensions(cell, media) {
    const cR   = cell.getBoundingClientRect();
    const fit  = cell.dataset.fitMode || 'contain';
    const r    = parseInt(cell.dataset.tfRot  || 0);
    const zoom = parseFloat(cell.dataset.tfZoom || 1);
    const sh   = Math.abs(parseFloat(cell.dataset.tfSh || 1));
    const sv   = Math.abs(parseFloat(cell.dataset.tfSv || 1));
    const nw   = media.naturalWidth  || media.videoWidth  || 1;
    const nh   = media.naturalHeight || media.videoHeight || 1;

    let baseScale = 1;
    if (fit === 'contain') baseScale = Math.min(cR.width / nw, cR.height / nh);
    else if (fit === 'cover') baseScale = Math.max(cR.width / nw, cR.height / nh);
    else if (fit === 'fill') {
        const fw = cR.width  * zoom * sh;
        const fh = cR.height * zoom * sv;
        return (r % 180 !== 0) ? { w: fh, h: fw } : { w: fw, h: fh };
    }
    // fit === 'none' → baseScale stays 1

    const realW = nw * baseScale * zoom * sh;
    const realH = nh * baseScale * zoom * sv;
    return (r % 180 !== 0) ? { w: realH, h: realW } : { w: realW, h: realH };
}

// ── TRANSFORM BAR ─────────────────────────────────────────────
function createTransformBar(cell) {
    const bar = document.createElement('div');
    bar.className = 'transform-bar';
    bar.onclick = e => e.stopPropagation();

    const sections = [
        { icons: ['rotL', 'rotR']       },
        { icons: ['mirH', 'mirV']       },
        { icons: ['strH', 'shrH']       },
        { icons: ['strV', 'shrV']       },
        { icons: ['reset', 'active', 'save'] }
    ];

    const REPEAT_ICONS = new Set(['strH', 'shrH', 'strV', 'shrV']);

    sections.forEach(s => {
        const div = document.createElement('div');
        div.className = 'tf-section';

        s.icons.forEach(ico => {
            const btn = document.createElement('button');
            btn.className = 'tf-btn';
            btn.innerHTML = TF_ICONS[ico];
            btn.title = ico;

            if (ico === 'save'   && cell.dataset.tfSticky   === 'true') btn.classList.add('active');
            if (ico === 'active' && cell.dataset.tfInteract === 'true') btn.classList.add('active');

            let repeatTimer = null;

            const triggerAction = () => {
                switch (ico) {
                    case 'rotL':  cell.dataset.tfRot = parseInt(cell.dataset.tfRot  || 0) - 90; break;
                    case 'rotR':  cell.dataset.tfRot = parseInt(cell.dataset.tfRot  || 0) + 90; break;
                    case 'mirH':  cell.dataset.tfSx  = parseFloat(cell.dataset.tfSx || 1) * -1; break;
                    case 'mirV':  cell.dataset.tfSy  = parseFloat(cell.dataset.tfSy || 1) * -1; break;
                    case 'strH':  cell.dataset.tfSh  = parseFloat(cell.dataset.tfSh || 1) + 0.02; break;
                    case 'shrH':  cell.dataset.tfSh  = Math.max(0.02, parseFloat(cell.dataset.tfSh || 1) - 0.02); break;
                    case 'strV':  cell.dataset.tfSv  = parseFloat(cell.dataset.tfSv || 1) + 0.02; break;
                    case 'shrV':  cell.dataset.tfSv  = Math.max(0.02, parseFloat(cell.dataset.tfSv || 1) - 0.02); break;
                    case 'reset':
                        ['tfRot','tfSx','tfSy','tfSh','tfSv','tfX','tfY','tfZoom'].forEach(k => {
                            cell.dataset[k] = k.endsWith('ot') || k.endsWith('Zoom') ? (k.endsWith('Zoom') ? 1 : 0) :
                                              (k === 'tfX' || k === 'tfY' ? 0 : 1);
                        });
                        cell.dataset.tfRot  = 0;
                        cell.dataset.tfSx   = 1; cell.dataset.tfSy = 1;
                        cell.dataset.tfSh   = 1; cell.dataset.tfSv = 1;
                        cell.dataset.tfX    = 0; cell.dataset.tfY  = 0;
                        cell.dataset.tfZoom = 1;
                        break;
                    case 'save': {
                        const on = cell.dataset.tfSticky !== 'true';
                        cell.dataset.tfSticky = on;
                        btn.classList.toggle('active', on);
                        break;
                    }
                    case 'active': {
                        const on = cell.dataset.tfInteract !== 'true';
                        cell.dataset.tfInteract = on;
                        btn.classList.toggle('active', on);
                        break;
                    }
                }
                applyTransform(cell);
            };

            btn.onmousedown = e => {
                if (e.button !== 0) return;
                const media = cell.querySelector('.media-active');
                if (media) {
                    media.style.transition = (ico === 'rotL' || ico === 'rotR')
                        ? 'transform 0.4s ease-out'
                        : 'transform 0.1s ease-out';
                }
                triggerAction();
                if (REPEAT_ICONS.has(ico)) repeatTimer = setInterval(triggerAction, 50);
            };

            const stopRepeat = () => {
                clearInterval(repeatTimer);
                repeatTimer = null;
                const media = cell.querySelector('.media-active');
                if (media) setTimeout(() => { media.style.transition = ''; }, 200);
            };
            btn.onmouseup    = stopRepeat;
            btn.onmouseleave = stopRepeat;

            div.appendChild(btn);
        });
        bar.appendChild(div);
    });
    return bar;
}

// ── EFFECTS ───────────────────────────────────────────────────
const EFFECT_LIST = ['fade','zoom-in','zoom-out','slide-up','slide-down','slide-left','slide-right',
                     'spin','flip-x','flip-y','blur','elastic','flash','swing','glitch',
                     'rise','diagonal','ripple','curtain','morph','bounce','vortex','shatter'];

// Separate list for video transitions (lighter, safer for video decoders)
const VIDEO_EFFECT_LIST = ['fade-vid','zoom-in-vid','zoom-out-vid','slide-up-vid','slide-dn-vid',
                            'slide-l-vid','slide-r-vid','blur-vid','morph-vid','curtain-vid'];

function getRandomEffect() { return EFFECT_LIST[Math.floor(Math.random() * EFFECT_LIST.length)]; }
function getRandomVideoEffect() { return VIDEO_EFFECT_LIST[Math.floor(Math.random() * VIDEO_EFFECT_LIST.length)]; }
function getRandomDuration() {
    const min = (window.settings.minRandomDuration || 5)  * 1000;
    const max = (window.settings.maxRandomDuration || 30) * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── CELL TIMER TRACKING (Set, not Array — avoids unbounded growth) ──
window._cellTimerSet = window._cellTimerSet || new Set();

function _addCellTimer(t) { window._cellTimerSet.add(t); return t; }
function _removeCellTimer(t) { window._cellTimerSet.delete(t); }

// backward-compat shim: keep window.cellTimers in sync
Object.defineProperty(window, 'cellTimers', {
    get() { return [...window._cellTimerSet]; },
    set(arr) {
        window._cellTimerSet = new Set(arr);
    },
    configurable: true
});

// ── LAZY OBSERVER ─────────────────────────────────────────────
const lazyObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        const cell = entry.target;
        if (entry.isIntersecting) {
            if (!cell.classList.contains('media-loaded') && cell.dataset.lazyIndex)
                renderMediaContent(cell, parseInt(cell.dataset.lazyIndex));
        } else {
            if (cell.classList.contains('media-loaded'))
                unloadMediaContent(cell);
        }
    });
}, { rootMargin: '200px', threshold: 0.01 });

// ── GRID UPDATE ───────────────────────────────────────────────
function updateGridContents() {
    if (window.isEditingLayout) return;
    const els = getEls();
    window.gridCellsRef = Array.from(els.grid.querySelectorAll('.grid-cell'));

    if (window.playlist.length === 0) {
        window.shuffleCycleHistory.clear();
        return;
    }

    // FIX 1: Assign each cell its own sequential cursor (_seqIdx) starting
    // from currentTrack + cellIndex so cells don't share a single pointer.
    // This prevents cells from duplicating or skipping files when individual
    // timers fire asynchronously.  The legacy window.nextQueueIndex is kept
    // in sync for any external code that still reads it.
    const n        = window.playlist.length;
    const baseIdx  = ((window.currentTrack % n) + n) % n;
    let   slotOffset = 0;

    window.gridCellsRef.forEach((cell, i) => {
        if (cell.dataset.locked !== 'true') {
            // Each non-locked cell starts at a unique offset so they display
            // different files even before any timer fires.
            cell._seqIdx = (baseIdx + slotOffset) % n;
            slotOffset++;
        }
    });

    // Keep the shared pointer consistent for mix-ratio cursors and
    // any callers that reference window.nextQueueIndex directly.
    window.nextQueueIndex = (baseIdx + slotOffset) % n;

    // When mix ratio is active, seed independent per-type cursors so that
    // image-phase cells and video-phase cells each walk their own slice of
    // the queue without the shared pointer skipping past what the other needs.
    if (window.settings.advanceRatioMode && window.settings.customMixRatio) {
        _seedMixTypePointers(window.currentTrack);
    }

    window.gridCellsRef.forEach(cell => {
        if (cell.dataset.locked === 'true') return;
        mountMediaInCell(cell, -1, false);
    });
}

// ── RATIO MATCHING ────────────────────────────────────────────
function checkRatioMatch(width, height, reqRatioString, autoTarget, cell) {
    if (!reqRatioString || reqRatioString === 'all') return true;
    if (!height) return false;

    const actualRatio = width / height;
    const tol = (typeof window.settings.ratioTolerance !== 'undefined')
        ? window.settings.ratioTolerance : 0.3;

    let allowed = reqRatioString.split(',');
    if (window.settings.advanceRatioMode && cell?.dataset.customRatios) {
        cell.dataset.customRatios.split(',').map(s => s.trim()).forEach(c => {
            if (c && c.includes(':')) allowed.push(c);
        });
    }

    for (const rLabel of allowed) {
        if (rLabel === 'all') return true;
        if (rLabel === 'auto') {
            if (autoTarget && Math.abs(actualRatio - autoTarget) <= tol) return true;
            continue;
        }
        if (rLabel.includes(':')) {
            const [a, b] = rLabel.split(':').map(Number);
            if (!isNaN(a) && !isNaN(b) && b !== 0 &&
                Math.abs(actualRatio - a / b) <= tol) return true;
        }
    }
    return false;
}

// ── AGGRESSIVE RAM CLEANUP ────────────────────────────────────
window.aggressivelyCleanOldMedia = function(cell) {
    cell.querySelectorAll('.media-old').forEach(el => {

        // 1. Stop playback before clearing src (avoids audio pops)
        if (el.tagName === 'VIDEO') {
            el.pause();
            window.disposeMediaBoost?.(el);          // free Web Audio nodes (volume boost)
            el.removeAttribute('src');
            // Do NOT call el.load() — it re-initialises the HW decoder
            // and can crash other concurrently-decoding videos.
        } else if (el.tagName === 'IMG') {
            el.onload  = null;
            el.onerror = null;
            // Overwrite with 1×1 transparent GIF to flush GPU texture
            el.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            el.removeAttribute('src');
        } else if (el.tagName === 'CANVAS') {
            try {
                const ctx = el.getContext('2d');
                if (ctx) ctx.clearRect(0, 0, el.width, el.height);
            } catch { /* ignore */ }
            el.width = 0;
            el.height = 0;
        }

        // 2. Revoke blob URLs AFTER clearing src
        const blobUrl = el.dataset.blobUrl;
        if (blobUrl && blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);

        el.remove();
    });

    // 3. Request a V8 GC pass (only available in Electron with --expose-gc)
    if (typeof window.gc === 'function') window.gc();
};

// ── RAM FLUSH SHORTCUT ────────────────────────────────────────
// Exposed as triggerAction('ramFlush') in app-controller.
// Unloads every cell, forces GC, then seeks all videos back by
// window.SEEK_BACK_DELTA seconds (default −30) so playback
// continues from a reasonable point.
window.performRamFlush = function() {
    // 1. Unload every cell (releases GPU textures + decoder memory)
    document.querySelectorAll('.grid-cell').forEach(cell => {
        unloadMediaContent(cell);
    });

    // 2. Force GC
    if (typeof window.gc === 'function') window.gc();

    // 3. Re-mount cells from current playlist position so playback resumes
    //    (small delay lets the browser finish GC before re-allocating)
    setTimeout(() => {
        updateGridContents();

        // 4. After re-mount, seek all fresh videos back by the delta
        const delta = window.SEEK_BACK_DELTA || -30;
        if (delta !== 0) {
            setTimeout(() => {
                document.querySelectorAll('.grid-cell video.media-active').forEach(v => {
                    v.currentTime = Math.max(0, v.currentTime + delta);
                });
                // Also seek the single-video-mode player
                const mainVid = document.getElementById('videoPlayer');
                if (mainVid && !mainVid.paused)
                    mainVid.currentTime = Math.max(0, mainVid.currentTime + delta);
            }, 400);
        }

        if (typeof showToast === 'function')
            showToast(`RAM flushed · Seeked ${Math.abs(delta)}s back`, 'info', 'system');
    }, 150);
};

// ── MOUNT MEDIA IN CELL ───────────────────────────────────────
function mountMediaInCell(cell, preferredIndex, isForced = false) {
    if (window.isEditingLayout) return;

    // Sync cell's private queue from the persistent map
    const currentCells = Array.from(document.querySelectorAll('.grid-cell'));
    const cellIdx = currentCells.indexOf(cell);
    if (!cell.privateQueue && window.gridQueueMap?.[cellIdx]) {
        cell.privateQueue = window.gridQueueMap[cellIdx];
        cell.classList.add('has-private-queue');
    }
    if (cell.privateQueue && cellIdx !== -1)
        window.gridQueueMap[cellIdx] = cell.privateQueue;

    // ── Determine file to load ────────────────────────────────
    let finalIndex = -1;
    let fileToLoad = null;

    if (cell.privateQueue?.length > 0) {
        let pIdx = parseInt(cell.dataset.privateIndex || 0);
        if (isForced && preferredIndex !== -1) pIdx = preferredIndex % cell.privateQueue.length;
        else if (!isForced) pIdx = (pIdx + 1) % cell.privateQueue.length;
        cell.dataset.privateIndex = pIdx;
        fileToLoad  = cell.privateQueue[pIdx];
        finalIndex  = -2;      // sentinel: private queue item (safe, never a real index)
    } else if (window.playlist.length > 0) {
        const reqType  = cell.dataset.contentType || 'all';
        const reqRatio = cell.dataset.aspectRatio || 'all';
        let autoTarget = null;
        if (reqRatio.includes('auto')) {
            const rect = cell.getBoundingClientRect();
            if (rect.width && rect.height) autoTarget = rect.width / rect.height;
        }

        // ── MIX RATIO: override effective type for 'all' cells ──────
        // When advanceRatioMode is on and the cell accepts all content,
        // cycle through N images then M videos as set by customMixRatio.
        let effectiveType = reqType;
        if (
            !isForced &&
            window.settings.advanceRatioMode &&
            reqType === 'all' &&
            window.settings.customMixRatio
        ) {
            effectiveType = _getMixRatioType(cell);
        }

        if (isForced && preferredIndex >= 0) {
            finalIndex = preferredIndex;
            cell.dataset.forcedContent = 'true';
        } else if (window.settings.shuffle) {
            finalIndex = _pickShuffleIndex(cell, effectiveType, reqRatio, autoTarget);
        } else {
            finalIndex = _pickSequentialIndex(cell, effectiveType, reqRatio, autoTarget);
        }

        // ── Mix-ratio fallback ────────────────────────────────────
        // If the requested type (e.g. 'image') produced no result because
        // the queue contains only the other type, retry with whatever is
        // available.  This also covers the single-type queue case:
        // all-images or all-videos queue still plays normally.
        if (finalIndex === -1 && effectiveType !== reqType) {
            // effectiveType was overridden by mix ratio — try any type
            if (window.settings.shuffle) {
                finalIndex = _pickShuffleIndex(cell, 'all', reqRatio, autoTarget);
            } else {
                finalIndex = _pickSequentialIndex(cell, 'all', reqRatio, autoTarget);
            }
        }

        if (finalIndex !== -1) fileToLoad = window.playlist[finalIndex];
    }

    // ── Retire current media ──────────────────────────────────
    const _retireVideoEffect = window.settings.videoEffect && window.settings.videoEffect !== 'none' || window.settings.randomVideoEffect;
    cell.querySelectorAll('.media-active').forEach(el => {
        el.classList.remove('media-active');
        el.classList.add('media-old');
        el.style.pointerEvents = 'none';
        // Tag retiring video so the CSS can fade it out visibly
        // instead of snapping to display:none during the transition
        if (el.tagName === 'VIDEO' && _retireVideoEffect) {
            el.classList.add('video-fx-enabled');
        }
    });

    // Clear timers and overlay UI
    if (cell.dataset.cdInterval) { clearInterval(parseInt(cell.dataset.cdInterval)); delete cell.dataset.cdInterval; }
    cell.querySelector('.cell-countdown')?.remove();
    if (cell.dataset.timerId) {
        const t = parseInt(cell.dataset.timerId);
        clearTimeout(t);
        _removeCellTimer(t);
        delete cell.dataset.timerId;
    }
    cell.querySelectorAll('.media-title-overlay,.cell-controls,.cell-nav-btn,.audio-lock-btn,.transform-bar').forEach(el => el.remove());

    lazyObserver.unobserve(cell);
    delete cell.dataset.lazyIndex;
    delete cell.dataset.currentIndex;
    delete cell.dataset.locked;
    delete cell.dataset.abA;
    delete cell.dataset.abB;

    if (!fileToLoad) {
        cell.querySelector('.no-content-msg')?.remove();
        window.aggressivelyCleanOldMedia(cell);
        if (!cell.classList.contains('grid-cell-floating')) {
            const msg = document.createElement('div');
            msg.className = 'no-content-msg';
            Object.assign(msg.style, { color: '#444', textAlign: 'center', fontSize: '0.7rem', position: 'absolute' });
            msg.textContent = 'No content';
            cell.appendChild(msg);
        }
        return;
    }

    cell.dataset.lazyIndex    = finalIndex;
    cell.dataset.currentIndex = finalIndex;
    renderMediaContent(cell, finalIndex, fileToLoad);
}

// ── MIX RATIO PHASE TRACKER ─────────────────────────────────
// Returns 'image' or 'video' for the next slot in this cell.
//
// Cycle mode  (random=false): strict sequence — play imgCount images,
//   then vidCount videos, repeat.  Counters live on the cell node.
//
// Random mode (random=true):  each call independently picks a type
//   with weighted probability: P(image) = images / (images + videos).
//   The number spinners still matter — they set the weight, not a count.
//
// State is stored on the DOM node so it resets automatically when the
// grid is rebuilt, or when setMixRatio() is called by the user.
function _getMixRatioType(cell) {
    const mix = window.settings.customMixRatio || { images: 1, videos: 1, random: false };
    const imgCount = Math.max(1, mix.images);
    const vidCount = Math.max(1, mix.videos);

    // ── Random mode: weighted coin flip ──────────────────────
    if (mix.random) {
        return Math.random() < imgCount / (imgCount + vidCount) ? 'image' : 'video';
    }

    // ── Cycle mode: strict counter ────────────────────────────
    // Initialise counters on first call for this cell
    if (cell._mixPhase === undefined) {
        cell._mixPhase    = 'image';  // start with images
        cell._mixImgCount = 0;
        cell._mixVidCount = 0;
    }

    const phase = cell._mixPhase;

    if (phase === 'image') {
        cell._mixImgCount++;
        if (cell._mixImgCount >= imgCount) {
            cell._mixPhase    = 'video';
            cell._mixImgCount = 0;
        }
        return 'image';
    } else {
        cell._mixVidCount++;
        if (cell._mixVidCount >= vidCount) {
            cell._mixPhase    = 'image';
            cell._mixVidCount = 0;
        }
        return 'video';
    }
}

// Reset mix-ratio phase on ALL grid cells.
// Called by playNext / playPrev / loadAndPlay so each manual navigation
// batch starts a fresh cycle from image-phase again.
function _resetAllMixPhases() {
    document.querySelectorAll('.grid-cell').forEach(c => {
        delete c._mixPhase;
        delete c._mixImgCount;
        delete c._mixVidCount;
    });
    // Also reset the per-type sequential cursors
    window._mixImgQueueIdx = undefined;
    window._mixVidQueueIdx = undefined;
}

// Seed two independent queue cursors — one walking images only,
// one walking videos only — both starting from `startIdx`.
// This prevents the shared nextQueueIndex from skipping past
// files that the other type's cells still need.
function _seedMixTypePointers(startIdx) {
    const n = window.playlist.length;
    if (!n) return;
    const base = ((startIdx % n) + n) % n;

    // Find the first image at or after base
    let imgPtr = -1;
    for (let i = 0; i < n; i++) {
        const idx = (base + i) % n;
        if (getFileType(window.playlist[idx]) === 'image') { imgPtr = idx; break; }
    }
    window._mixImgQueueIdx = imgPtr;

    // Find the first video at or after base
    let vidPtr = -1;
    for (let i = 0; i < n; i++) {
        const idx = (base + i) % n;
        if (getFileType(window.playlist[idx]) === 'video') { vidPtr = idx; break; }
    }
    window._mixVidQueueIdx = vidPtr;
}

// FIX 11: Shared "show every file once before any repeat" filter, used
// by BOTH the shuffle picker and the sequential picker below.
//
// Previously window.shuffleCycleHistory only guarded shuffle mode, and
// the sequential picker never checked getActiveIndices() at all — it
// just walked forward from its own per-cell cursor. Two things could
// then put the same file in more than one cell at once:
//   1. Sequential mode never excluded files already active in other
//      cells, so a cell's cursor could simply land on an index another
//      cell was already showing.
//   2. Per-cell cursors drift apart whenever the playlist is shorter
//      than the number of unlocked cells, a cell has its own type/ratio
//      filter, mix-ratio is on, or the playlist mutates mid-session —
//      after enough auto-advances, two cells' cursors can land on the
//      same index even though each one individually never repeats.
//
// _filterUnseenUnique() fixes both: it drops anything currently active
// in another cell, then drops anything already shown during the current
// top-to-bottom pass (tracked in the shared history Set). Once nothing
// remains that is both unique AND unseen, the history is cleared — that
// is precisely "a new pass may begin" — and the file is chosen from the
// full remaining pool again. This applies equally whether shuffle is on
// or off; only how a candidate is picked FROM the filtered set differs
// (random for shuffle, nearest-in-order for sequential).
function _filterUnseenUnique(pool, cell) {
    if (pool.length === 0) return pool;

    const activeSet = getActiveIndices();
    // FIX 3: Exclude the private-queue sentinel (-2) and guard against
    // any stale negative values so they never pollute the candidate filter.
    // Also don't let a cell's own current file block it from being picked
    // again — that only matters when NO other candidate is left anyway.
    const curIdx = parseInt(cell.dataset.currentIndex);
    if (!isNaN(curIdx) && curIdx >= 0) activeSet.delete(curIdx);

    let available = pool.filter(i => !activeSet.has(i));
    if (available.length === 0) available = pool;

    let fresh = available.filter(i => !window.shuffleCycleHistory.has(i));
    if (fresh.length === 0) {
        // Every remaining candidate has already been shown this pass —
        // the whole queue has been displayed top-to-bottom (or fully
        // shuffled through) at least once. Start a fresh pass.
        window.shuffleCycleHistory.clear();
        fresh = available;
    }
    return fresh;
}

// Smallest candidate at or after startIdx, wrapping to the smallest
// candidate overall if none qualify. `sortedCandidates` is always
// ascending because it's built by _buildCandidatePool() / a plain
// index map, both of which iterate window.playlist in order.
function _nextInOrder(sortedCandidates, startIdx) {
    for (let i = 0; i < sortedCandidates.length; i++) {
        if (sortedCandidates[i] >= startIdx) return sortedCandidates[i];
    }
    return sortedCandidates[0];
}

function _resolveCandidatePool(reqType, reqRatio, autoTarget, cell) {
    let pool = _buildCandidatePool(reqType, reqRatio, autoTarget, cell);
    // autoFallback: if ratio filter wiped the pool, ignore ratio but keep type
    if (pool.length === 0 && window.settings.autoFallback)
        pool = window.playlist.map((_, i) => i)
                              .filter(i => reqType === 'all' || getFileType(window.playlist[i]) === reqType);
    // If still empty (that type simply doesn't exist), allow any type
    if (pool.length === 0 && reqType !== 'all')
        pool = window.playlist.map((_, i) => i);
    return pool;
}

function _pickShuffleIndex(cell, reqType, reqRatio, autoTarget) {
    const pool = _resolveCandidatePool(reqType, reqRatio, autoTarget, cell);
    if (pool.length === 0) return -1;

    const fresh = _filterUnseenUnique(pool, cell);
    if (fresh.length === 0) return -1;

    const idx = fresh[Math.floor(Math.random() * fresh.length)];
    window.shuffleCycleHistory.add(idx);
    return idx;
}

function _pickSequentialIndex(cell, reqType, reqRatio, autoTarget) {
    const n = window.playlist.length;

    // ── Mix-ratio path: use independent per-type cursors ─────────
    // When mix ratio is driving a specific type ('image' or 'video'),
    // use the dedicated cursor for that type so the two types walk
    // the queue independently and neither skips past the other's files.
    if (
        window.settings.advanceRatioMode &&
        window.settings.customMixRatio &&
        (reqType === 'image' || reqType === 'video')
    ) {
        const ptrKey = reqType === 'image' ? '_mixImgQueueIdx' : '_mixVidQueueIdx';

        // If pointers were never seeded (e.g. live-load path), seed now
        if (window[ptrKey] === undefined) _seedMixTypePointers(window.currentTrack);

        let ptr = window[ptrKey];
        if (ptr === -1) {
            // No files of this type exist — fall through to standard path with 'all'
            // (the mountMediaInCell fallback layer also catches this, but
            //  short-circuiting here avoids a redundant scan)
            return _pickSequentialIndex(cell, 'all', reqRatio, autoTarget);
        }

        // FIX 11: respect the same "not active elsewhere / not already
        // shown this pass" rules as the standard path, instead of just
        // walking forward and taking the first type/ratio match.
        const pool = _buildCandidatePool(reqType, reqRatio, autoTarget, cell);
        if (pool.length === 0) return -1;

        const fresh = _filterUnseenUnique(pool, cell);
        if (fresh.length === 0) return -1;

        const idx = _nextInOrder(fresh, ptr);
        window.shuffleCycleHistory.add(idx);

        // Advance this type's cursor to the next file of the same type
        let next = (idx + 1) % n;
        for (let j = 1; j < n; j++) {
            if (getFileType(window.playlist[next]) === reqType) break;
            next = (next + 1) % n;
        }
        window[ptrKey] = next;
        return idx;
    }

    // ── Standard path: shared "show every file once per pass" queue ──
    // FIX 1 originally gave each cell its own cursor (cell._seqIdx) so
    // cells wouldn't fight over one shared pointer. FIX 11 keeps that
    // per-cell cursor (it still decides WHERE in the order each cell is
    // looking) but the actual candidate is now filtered through
    // _filterUnseenUnique() first, so a cell can never land on a file
    // that's already showing in another cell, and the picker always
    // works its way through the full remaining queue before anything
    // repeats — matching sequential mode's "top to bottom, once" order.
    const pool = _resolveCandidatePool(reqType, reqRatio, autoTarget, cell);
    if (pool.length === 0) return -1;

    const fresh = _filterUnseenUnique(pool, cell);
    if (fresh.length === 0) return -1;

    const startIdx = ((cell._seqIdx !== undefined ? cell._seqIdx : (window.nextQueueIndex || 0)) % n + n) % n;
    const idx = _nextInOrder(fresh, startIdx);

    // Advance this cell's own cursor for its next auto-advance.
    cell._seqIdx = (idx + 1) % n;
    // Also advance the shared pointer so external code stays consistent.
    window.nextQueueIndex = cell._seqIdx;
    window.shuffleCycleHistory.add(idx);
    return idx;
}

function _buildCandidatePool(reqType, reqRatio, autoTarget, cell) {
    return window.playlist.reduce((acc, file, i) => {
        if (reqType !== 'all' && getFileType(file) !== reqType) return acc;
        if (window.settings.showQueueInfo && reqRatio !== 'all' && file.metaDataStr) {
            const m = file.metaDataStr.match(/^(\d+)x(\d+)/);
            if (m && !checkRatioMatch(+m[1], +m[2], reqRatio, autoTarget, cell)) return acc;
        }
        acc.push(i);
        return acc;
    }, []);
}

function _ratioOk(file, reqRatio, autoTarget, cell) {
    if (!window.settings.showQueueInfo || reqRatio === 'all') return true;
    const m = file.metaDataStr?.match(/^(\d+)x(\d+)/);
    return !m || checkRatioMatch(+m[1], +m[2], reqRatio, autoTarget, cell);
}

// ── UNLOAD ────────────────────────────────────────────────────
function unloadMediaContent(cell) {
    if (cell.dataset.cdInterval) { clearInterval(parseInt(cell.dataset.cdInterval)); delete cell.dataset.cdInterval; }
    if (cell.dataset.timerId) {
        const t = parseInt(cell.dataset.timerId);
        clearTimeout(t);
        _removeCellTimer(t);
        delete cell.dataset.timerId;
    }

    cell.querySelectorAll('.media-active,.media-old').forEach(el => el.classList.add('media-old'));
    window.aggressivelyCleanOldMedia(cell);
    cell.querySelectorAll('.cell-countdown,.media-title-overlay,.cell-controls,.cell-nav-btn,.no-content-msg,.audio-lock-btn,.transform-bar').forEach(el => el.remove());
    cell.classList.remove('media-loaded');
    delete cell.dataset.abA;
    delete cell.dataset.abB;
}

// ── VALIDATE RATIO ────────────────────────────────────────────
function validateMediaRatio(cell, width, height, fileIndex) {
    if (window.isEditingLayout) return true;
    if (cell.dataset.forcedContent === 'true') return true;
    if (cell.privateQueue?.length > 0) return true;

    // Persist metadata on the file object (dedup write)
    const file = window.playlist[fileIndex];
    if (file && !file.metaDataStr) {
        const rText = typeof getAspectRatio === 'function' ? getAspectRatio(width, height) : '';
        file.metaDataStr = `${width}x${height} [${rText}]`;
        const metaEl = document.getElementById(`meta-${fileIndex}`);
        if (metaEl) metaEl.textContent = file.metaDataStr;
    }

    if (!window.settings.showQueueInfo) return true;
    const reqRatio = cell.dataset.aspectRatio || 'all';
    if (reqRatio === 'all') return true;

    let autoTarget = null;
    if (reqRatio.includes('auto')) {
        const rect = cell.getBoundingClientRect();
        if (rect.width && rect.height) autoTarget = rect.width / rect.height;
    }

    if (!checkRatioMatch(width, height, reqRatio, autoTarget, cell)) {
        // Only remount if no media is showing (avoid recursive storm)
        if (!window.settings.autoFallback && !cell.querySelector('.media-active'))
            mountMediaInCell(cell, -1, false);
        return false;
    }
    return true;
}

// ── RENDER MEDIA ──────────────────────────────────────────────
function renderMediaContent(cell, finalIndex, fileOverride = null) {
    if (window.isEditingLayout) return;
    const file = fileOverride || window.playlist[finalIndex];
    if (!file) return;

    cell.currentFileObject = file;
    if (cell.dataset.timerId) {
        const t = parseInt(cell.dataset.timerId);
        clearTimeout(t);
        _removeCellTimer(t);
        delete cell.dataset.timerId;
    }

    cell.classList.add('media-loaded');

    const titleEl = document.createElement('div');
    titleEl.className = 'media-title-overlay';
    titleEl.textContent = file.name;
    cell.appendChild(titleEl);

    const url     = getFileUrl(file);
    const isBlob  = url.startsWith('blob:');
    const isVideo = getFileType(file) === 'video';
    const fitMode = cell.dataset.fitMode || 'contain';

    // Cache-bust local image files to prevent Chromium from serving stale
    // decoded images from its in-process cache (major RAM source).
    const loadUrl = (!isVideo && !isBlob && url.startsWith('file://'))
        ? `${url}?t=${Date.now()}` : url;

    if (!file.path) cell.dataset.activeUrl = url;

    let effect = window.settings.effect || 'none';
    if (window.settings.randomEffect) effect = getRandomEffect();

    // Separate video effect setting (Feature 4)
    let videoEffect = window.settings.videoEffect || 'none';
    if (window.settings.randomVideoEffect) videoEffect = getRandomVideoEffect();

    const rect    = cell.getBoundingClientRect();
    const targetW = Math.floor(rect.width)  || 300;
    const targetH = Math.floor(rect.height) || 150;

    let visEl;

    if (isVideo) {
        visEl = _buildVideoElement(cell, file, url, isBlob, targetW, targetH, finalIndex);
    } else {
        visEl = _buildImageElement(cell, file, url, loadUrl, isBlob, finalIndex);
    }

    // ── Drag interaction (stored refs so we can remove them on unmount) ──
    _attachDragInteraction(cell, visEl);

    // ── Transform bar ─────────────────────────────────────────
    if (window.settings.showTransformBar) cell.appendChild(createTransformBar(cell));

    // ── Nav buttons ───────────────────────────────────────────
    cell.appendChild(_buildNavBtn(cell, 'left',  finalIndex));
    cell.appendChild(_buildNavBtn(cell, 'right', finalIndex));

    // ── Activate the new element ──────────────────────────────
    visEl.style.objectFit = fitMode;
    if (isVideo) {
        // Feature 4: Video can now have its own transition effect
        if (videoEffect && videoEffect !== 'none') {
            visEl.classList.add('video-fx-enabled', `fx-${videoEffect}`);
        }
    } else {
        visEl.classList.add(`fx-${effect}`);
    }
    cell.appendChild(visEl);
    void visEl.offsetWidth;     // force reflow so CSS transition fires

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            visEl.classList.add('media-active');
            applyTransform(cell);

            const fxMs = (parseFloat(window.settings.effectSpeed) || 0.8) * 1000;
            const hasVideoFx = videoEffect && videoEffect !== 'none';

            // For video effects, delay cleanup until the old video's CSS
            // fade-out transition also finishes (it runs in parallel with
            // the new video's entry). Add 150ms buffer for slow GPUs.
            const cleanupDelay = hasVideoFx ? fxMs + 150 : fxMs + 50;
            setTimeout(() => {
                window.aggressivelyCleanOldMedia(cell);

                if (cell.dataset.tfSticky !== 'true') {
                    ['tfRot','tfSx','tfSy','tfSh','tfSv','tfX','tfY','tfZoom']
                        .forEach(k => delete cell.dataset[k]);
                }
            }, cleanupDelay);
        });
    });
}

// ── VIDEO ELEMENT BUILDER ─────────────────────────────────────
function _buildVideoElement(cell, file, url, isBlob, targetW, targetH, finalIndex) {
    const vid = document.createElement('video');
    vid.src          = url;
    vid.width        = targetW;
    vid.height       = targetH;
    vid.autoplay     = true;
    vid.playsInline  = true;
    if (isBlob) vid.dataset.blobUrl = url;
    vid.dataset.spId = window.getStartPointId?.(file) || '';   // links this <video> to its start point
    vid._spFile      = file;                                    // the exact file shown (also for cell-queue videos)

    const isLocked  = cell.dataset.audioLocked === 'true';
    vid.muted        = isLocked ? false : (window.isGlobalMuted ?? true);
    setMediaVolume(vid, cell.dataset.savedVolume !== undefined
        ? parseFloat(cell.dataset.savedVolume) : (window.settings.globalVolume ?? 1));

    const targetSpeed = cell.dataset.savedSpeed !== undefined
        ? parseFloat(cell.dataset.savedSpeed)
        : parseFloat(document.getElementById('speedSlider')?.value || 1);
    vid.playbackRate = targetSpeed;

    vid.addEventListener('loadedmetadata', () => {
        if (cell.dataset.savedSpeed  !== undefined) vid.playbackRate = parseFloat(cell.dataset.savedSpeed);
        if (cell.dataset.savedVolume !== undefined) setMediaVolume(vid, parseFloat(cell.dataset.savedVolume));
        // Saved start point: jump there when this video is loaded into a cell
        const _sp = window.getStartPoint?.(file);
        if (_sp != null && vid.duration && _sp < vid.duration - 1) { try { vid.currentTime = _sp; } catch {} }
        window.updateStartMarker?.(vid);
        validateMediaRatio(cell, vid.videoWidth, vid.videoHeight, finalIndex);
    });

    vid.onended = () => {
        const hasB = cell.dataset.abB;
        if (!hasB) {
            if (!vid.loop) loadNextIntoCell(cell);
        } else {
            vid.currentTime = parseFloat(cell.dataset.abA) || 0;
            vid.play().catch(() => {});
        }
    };

    // Skip to next only if the video failed before playing anything meaningful.
    vid.onerror = () => {
        if (vid.currentTime < 0.1) loadNextIntoCell(cell);
    };

    if (window.isPaused) vid.pause();
    else vid.play().catch(() => {});

    // End point: when playback reaches it, behave as if the video finished
    vid.addEventListener('timeupdate', () => {
        const ep = window.getEndPoint?.(file);
        if (ep == null || !vid.duration || ep >= vid.duration || cell.dataset.abB) return;   // A/B loop has priority
        if (vid._spSkipEnd) { if (vid.currentTime < ep - 0.3) vid._spSkipEnd = false; return; } // just set → plays through this time
        if (vid.currentTime < ep) return;
        if (vid.loop) { const st = window.getStartPoint?.(file); vid.currentTime = st != null ? st : 0; }
        else if (!vid._spEnded) { vid._spEnded = true; loadNextIntoCell(cell); }
    });

    // Audio lock button
    const audioBtn = document.createElement('div');
    audioBtn.className = `audio-lock-btn ${vid.muted ? '' : 'active'}`;
    audioBtn.innerHTML = vid.muted ? GRID_ICONS.mute : GRID_ICONS.sound;
    audioBtn.onclick = e => {
        e.stopPropagation();
        const locked = cell.dataset.audioLocked === 'true';
        cell.dataset.audioLocked = !locked;
        audioBtn.classList.toggle('active', !locked);
        vid.muted = locked ? (window.isGlobalMuted ?? true) : false;
        audioBtn.innerHTML = vid.muted ? GRID_ICONS.mute : GRID_ICONS.sound;
    };
    cell.appendChild(audioBtn);

    // Controls panel
    cell.appendChild(_buildVideoControls(cell, vid, targetSpeed));

    return vid;
}

function _buildVideoControls(cell, vid, initialSpeed) {
    const controls = document.createElement('div');
    controls.className = 'cell-controls';
    controls.onclick   = e => e.stopPropagation();

    // ── Left column: repeat + play/pause ─────────────────────
    const btnGroup  = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;flex-direction:column;align-items:center;margin-right:8px;';

    const repeatBtn = document.createElement('button');
    repeatBtn.className = 'cell-btn';
    repeatBtn.innerHTML = GRID_ICONS.loop;
    repeatBtn.onclick   = e => {
        e.stopPropagation();
        vid.loop = !vid.loop;
        repeatBtn.style.color = vid.loop ? '#22c55e' : '';
    };

    const playBtn = document.createElement('button');
    playBtn.className = 'cell-btn';
    // Icon always mirrors the real <video> state, so it stays correct when the
    // cell is toggled by double-click or by the global play/pause button.
    const syncPlayIcon = () => { playBtn.innerHTML = vid.paused ? GRID_ICONS.play : GRID_ICONS.pause; };
    syncPlayIcon();
    vid.addEventListener('play',  syncPlayIcon);
    vid.addEventListener('pause', syncPlayIcon);
    playBtn.onclick   = e => {
        e.stopPropagation();
        if (vid.paused) vid.play().catch(() => {});
        else            vid.pause();
    };
    btnGroup.appendChild(repeatBtn);
    btnGroup.appendChild(playBtn);
    controls.appendChild(btnGroup);

    // ── Centre: timeline ──────────────────────────────────────
    const timeline = document.createElement('div');
    timeline.className   = 'timeline-wrapper';
    timeline.style.cssText = 'display:flex;flex-direction:column;flex:1;margin:0 10px;position:relative;';

    const timeLabel = document.createElement('span');
    timeLabel.style.cssText = 'font-size:0.65rem;color:white;font-family:monospace;text-align:center;width:100%;margin-bottom:2px;font-variant-numeric:tabular-nums;';
    timeLabel.textContent   = '0:00 / 0:00';

    const timeRange = document.createElement('input');
    timeRange.type      = 'range';
    timeRange.className = 'cell-range';
    timeRange.style.cssText = 'width:100%;flex:none;';
    timeRange.oninput   = e => {
        e.stopPropagation();
        if (vid.duration) vid.currentTime = (e.target.value / 100) * vid.duration;
    };

    vid.addEventListener('timeupdate', () => {
        if (isNaN(vid.duration)) return;
        timeRange.value   = (vid.currentTime / vid.duration) * 100;
        timeLabel.textContent = `${formatCellTime(vid.currentTime)} / ${formatCellTime(vid.duration)}`;
        const ptB = parseFloat(cell.dataset.abB);
        if (!isNaN(ptB) && vid.currentTime >= ptB) {
            vid.currentTime = parseFloat(cell.dataset.abA) || 0;
            if (vid.paused) vid.play().catch(() => {});
        }
    });

    const markerA = document.createElement('div'); markerA.className = 'marker-a';
    const markerB = document.createElement('div'); markerB.className = 'marker-b';
    timeline.appendChild(timeLabel);
    timeline.appendChild(timeRange);
    timeline.appendChild(markerA);
    timeline.appendChild(markerB);
    const markerS = document.createElement('div'); markerS.className = 'marker-s';
    timeline.appendChild(markerS);
    vid._spMarker = markerS;
    const markerE = document.createElement('div'); markerE.className = 'marker-e';
    timeline.appendChild(markerE);
    vid._epMarker = markerE;
    controls.appendChild(timeline);

    // ── Right column: speed + volume ─────────────────────────
    const stack = document.createElement('div');
    stack.className = 'cell-sliders-stack';

    // Speed row
    const speedRow   = document.createElement('div'); speedRow.className = 'cell-slider-row';
    const speedLabel = document.createElement('span'); speedLabel.className = 'cell-speed-label'; speedLabel.textContent = initialSpeed + 'x';
    const speedSlider = document.createElement('input');
    speedSlider.type  = 'range'; speedSlider.className = 'cell-speed-slider';
    speedSlider.min   = 0.25; speedSlider.max = 4; speedSlider.step = 0.25; speedSlider.value = initialSpeed;
    const saveSpdBtn  = document.createElement('button');
    saveSpdBtn.className = 'cell-save-btn'; saveSpdBtn.innerHTML = GRID_ICONS.save;
    if (cell.dataset.savedSpeed) saveSpdBtn.classList.add('active');

    speedSlider.oninput = e => {
        e.stopPropagation();
        const val = parseFloat(e.target.value);
        vid.playbackRate = val;
        speedLabel.textContent = val + 'x';
        if (saveSpdBtn.classList.contains('active')) cell.dataset.savedSpeed = val;
    };
    saveSpdBtn.onclick = e => {
        e.stopPropagation();
        if (saveSpdBtn.classList.contains('active')) {
            delete cell.dataset.savedSpeed;
            saveSpdBtn.classList.remove('active');
            const g = parseFloat(document.getElementById('speedSlider')?.value || 1);
            vid.playbackRate = g; speedSlider.value = g; speedLabel.textContent = g + 'x';
        } else {
            cell.dataset.savedSpeed = vid.playbackRate;
            saveSpdBtn.classList.add('active');
        }
    };
    speedRow.appendChild(speedLabel); speedRow.appendChild(speedSlider); speedRow.appendChild(saveSpdBtn);

    // Volume row
    const volRow   = document.createElement('div'); volRow.className = 'cell-slider-row';
    const volBtn   = document.createElement('button');
    volBtn.className = 'cell-btn vol-btn';
    volBtn.innerHTML  = vid.muted ? GRID_ICONS.mute : GRID_ICONS.sound;
    volBtn.onclick    = e => { e.stopPropagation(); vid.muted = !vid.muted; updateVolIcon(); };

    const volRange  = document.createElement('input');
    volRange.type   = 'range'; volRange.className = 'cell-vol-slider';
    setVolumeSlider(volRange, getMediaVolume(vid));          // 0–100% normally, 0–1000% with Volume Boost
    volRange.title = Math.round(getMediaVolume(vid) * 100) + '%';

    const saveVolBtn = document.createElement('button');
    saveVolBtn.className = 'cell-save-btn'; saveVolBtn.innerHTML = GRID_ICONS.save;
    if (cell.dataset.savedVolume) saveVolBtn.classList.add('active');

    // ── Live value bubble: shown above the thumb while the slider is grabbed ──
    const THUMB_PX  = 10;                                   // matches .cell-vol-slider thumb width
    const volBubble = document.createElement('div');
    volBubble.className = 'cell-vol-bubble';
    volRow.classList.add('cell-vol-row');                   // positioning context for the bubble
    let bubbleDragging = false, bubbleTimer = null;

    const placeVolBubble = () => {
        const sr = volRange.getBoundingClientRect();
        const rr = volRow.getBoundingClientRect();
        const cr = cell.getBoundingClientRect();
        const span  = (Number(volRange.max) - Number(volRange.min)) || 1;
        const ratio = (Number(volRange.value) - Number(volRange.min)) / span;
        // The thumb only travels inside the slider's padding + border box (a global
        // `input[type=range]` rule adds 8px padding + 1px border), so measure that.
        const cs     = getComputedStyle(volRange);
        const insetL = (parseFloat(cs.paddingLeft)  || 0) + (parseFloat(cs.borderLeftWidth)  || 0);
        const insetR = (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderRightWidth) || 0);
        const trackW = sr.width - insetL - insetR;
        const thumbX = sr.left + insetL + THUMB_PX / 2 + ratio * (trackW - THUMB_PX);   // thumb centre (viewport px)
        const half   = volBubble.offsetWidth / 2;
        // keep the bubble inside the cell (cells clip overflow); the arrow keeps pointing at the thumb
        const cx = Math.min(Math.max(thumbX, cr.left + half + 4), cr.right - half - 4);
        volBubble.style.left = (cx - rr.left) + 'px';
        volBubble.style.setProperty('--arrow-dx', (thumbX - cx) + 'px');
    };
    const hideVolBubble = () => { clearTimeout(bubbleTimer); volBubble.classList.remove('show'); };
    const showVolBubble = () => {
        const v = readVolumeSlider(volRange);
        volBubble.textContent = Math.round(v * 100) + '%';
        volBubble.classList.toggle('boost', v > 1);         // amber above 100%
        volBubble.classList.toggle('max',   v >= 4);        // red from 400% (likely to distort)
        placeVolBubble();
        volBubble.classList.add('show');
        clearTimeout(bubbleTimer);
        if (!bubbleDragging) bubbleTimer = setTimeout(hideVolBubble, 900);   // keyboard / click: auto-hide
    };
    const endVolDrag = () => {
        bubbleDragging = false;
        clearTimeout(bubbleTimer);
        bubbleTimer = setTimeout(hideVolBubble, 700);       // linger so the final value can be read
    };
    volRange.addEventListener('pointerdown', () => {
        bubbleDragging = true;
        showVolBubble();
        window.addEventListener('pointerup',     endVolDrag, { once: true });
        window.addEventListener('pointercancel', endVolDrag, { once: true });
    });
    volRange.addEventListener('blur', hideVolBubble);

    const updateVolIcon = () => {
        const lv = getMediaVolume(vid);
        volBtn.innerHTML = (vid.muted || lv === 0) ? GRID_ICONS.mute :
                           (lv < 0.5 ? GRID_ICONS.soundLow : GRID_ICONS.sound);
    };
    volRange.oninput = e => {
        e.stopPropagation();
        const val = readVolumeSlider(e.target);
        setMediaVolume(vid, val);
        volRange.title = Math.round(val * 100) + '%';
        if (val > 0 && vid.muted) vid.muted = false;
        updateVolIcon();
        showVolBubble();
        if (saveVolBtn.classList.contains('active')) cell.dataset.savedVolume = val;
    };
    saveVolBtn.onclick = e => {
        e.stopPropagation();
        if (saveVolBtn.classList.contains('active')) {
            delete cell.dataset.savedVolume;
            saveVolBtn.classList.remove('active');
            const g = clampVolume(window.settings.globalVolume ?? 1);
            setMediaVolume(vid, g); setVolumeSlider(volRange, g); volRange.title = Math.round(g * 100) + '%'; updateVolIcon();
        } else {
            cell.dataset.savedVolume = getMediaVolume(vid);
            saveVolBtn.classList.add('active');
        }
    };
    volRow.appendChild(volBtn); volRow.appendChild(volRange); volRow.appendChild(saveVolBtn); volRow.appendChild(volBubble);

    stack.appendChild(speedRow);
    stack.appendChild(volRow);
    controls.appendChild(stack);
    return controls;
}

// ── IMAGE / CANVAS ELEMENT BUILDER ───────────────────────────
function _buildImageElement(cell, file, url, loadUrl, isBlob, finalIndex) {
    let visEl;
    if (window.settings.hybridMode) {
        visEl = document.createElement('canvas');
        if (isBlob) visEl.dataset.blobUrl = url;

        let logicImg = new Image();
        logicImg.src = loadUrl;
        logicImg.onload = () => {
            if (!validateMediaRatio(cell, logicImg.naturalWidth, logicImg.naturalHeight, finalIndex)) {
                logicImg.onload = logicImg.onerror = null;
                logicImg = null;
                return;
            }
            visEl.width  = logicImg.naturalWidth;
            visEl.height = logicImg.naturalHeight;
            const ctx = visEl.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(logicImg, 0, 0);
            // Release the proxy image
            logicImg.onload = logicImg.onerror = null;
            logicImg.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            logicImg = null;
        };
        logicImg.onerror = () => { logicImg = null; };
    } else {
        visEl = document.createElement('img');
        if (isBlob) visEl.dataset.blobUrl = url;
        visEl.src     = loadUrl;
        visEl.onload  = () => validateMediaRatio(cell, visEl.naturalWidth, visEl.naturalHeight, finalIndex);
    }

    // Image slideshow timer
    if (!window.isPaused) {
        let duration = window.settings.duration;
        if (window.settings.randomDuration) duration = getRandomDuration();
        if (window.startCellCountdown) window.startCellCountdown(cell, duration);
        const t = _addCellTimer(setTimeout(() => loadNextIntoCell(cell), duration));
        cell.dataset.timerId = t;
    }

    // Freeze button
    const controls = document.createElement('div');
    controls.className  = 'cell-controls';
    controls.style.justifyContent = 'center';
    controls.onclick    = e => e.stopPropagation();

    const keepBtn = document.createElement('button');
    keepBtn.className = 'cell-btn';
    keepBtn.innerHTML = GRID_ICONS.snowflake;
    if (cell.dataset.locked === 'true') keepBtn.style.backgroundColor = '#800080';

    keepBtn.onclick = e => {
        e.stopPropagation();
        const locked = cell.dataset.locked === 'true';
        if (locked) {
            cell.dataset.locked = 'false';
            keepBtn.style.backgroundColor = '';
            if (!window.isPaused && !cell.dataset.timerId) {
                let d = window.settings.duration;
                if (window.settings.randomDuration) d = getRandomDuration();
                const t = _addCellTimer(setTimeout(() => loadNextIntoCell(cell), d));
                cell.dataset.timerId = t;
                if (window.startCellCountdown) window.startCellCountdown(cell, d);
            }
        } else {
            cell.dataset.locked = 'true';
            keepBtn.style.backgroundColor = '#800080';
            if (cell.dataset.timerId) {
                const t = parseInt(cell.dataset.timerId);
                clearTimeout(t);
                _removeCellTimer(t);
                delete cell.dataset.timerId;
            }
            if (window.stopCellCountdown) window.stopCellCountdown(cell);
        }
    };
    controls.appendChild(keepBtn);
    cell.appendChild(controls);
    return visEl;
}

// ── DRAG INTERACTION ──────────────────────────────────────────
// Stores refs so they can be removed if the cell is re-rendered.
function _attachDragInteraction(cell, visEl) {
    // Remove any previous handlers stored on the cell
    if (cell._dragCleanup) cell._dragCleanup();

    let isDragging = false;
    let dragMode   = 0;
    let startX, startY;

    const onContextMenu = e => {
        if (cell.dataset.tfInteract === 'true') { e.preventDefault(); e.stopPropagation(); }
    };

    const onMouseDown = e => {
        if (cell.dataset.tfInteract !== 'true') return;
        if (e.target.closest('.transform-bar,.cell-controls,.cell-nav-btn,.audio-lock-btn,.cell-save-btn,.floating-handle,.resize-handle')) return;
        if (e.button !== 0 && e.button !== 2) return;
        e.preventDefault();
        isDragging = true;
        dragMode   = e.button;
        cell.classList.add('is-dragging');
        startX = e.clientX - parseFloat(cell.dataset.tfX || 0);
        startY = e.clientY - parseFloat(cell.dataset.tfY || 0);
    };

    const onMouseMove = e => {
        if (!isDragging) return;
        let tx = e.clientX - startX;
        let ty = e.clientY - startY;
        if (dragMode === 2) {
            const cR   = cell.getBoundingClientRect();
            const vDim = getVirtualContentDimensions(cell, visEl);
            if (vDim.w > cR.width)  { const lx = (vDim.w - cR.width)  / 2; tx = Math.max(-lx, Math.min(lx, tx)); } else tx = 0;
            if (vDim.h > cR.height) { const ly = (vDim.h - cR.height) / 2; ty = Math.max(-ly, Math.min(ly, ty)); } else ty = 0;
        }
        cell.dataset.tfX = tx;
        cell.dataset.tfY = ty;
        applyTransform(cell);
    };

    const onMouseUp = () => { isDragging = false; cell.classList.remove('is-dragging'); };

    const onWheel = e => {
        if (e.ctrlKey && cell.dataset.tfInteract === 'true') {
            e.preventDefault();
            let zoom = parseFloat(cell.dataset.tfZoom || 1);
            zoom = Math.max(0.1, zoom + (e.deltaY > 0 ? -0.1 : 0.1));
            cell.dataset.tfZoom = zoom;
            applyTransform(cell);
        }
    };

    cell.addEventListener('contextmenu', onContextMenu);
    cell.addEventListener('mousedown',   onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
    cell.addEventListener('wheel',       onWheel, { passive: false });

    // Store cleanup function on cell so re-renders remove listeners
    cell._dragCleanup = () => {
        cell.removeEventListener('contextmenu', onContextMenu);
        cell.removeEventListener('mousedown',   onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup',   onMouseUp);
        cell.removeEventListener('wheel',       onWheel);
        cell._dragCleanup = null;
    };
}

// ── NAV BUTTONS ───────────────────────────────────────────────
function _buildNavBtn(cell, direction, finalIndex) {
    const btn = document.createElement('div');
    btn.className = `cell-nav-btn cell-nav-${direction}`;
    btn.innerHTML = direction === 'left' ? GRID_ICONS.navLeft : GRID_ICONS.navRight;
    btn.onclick   = e => {
        e.stopPropagation();
        if (cell.privateQueue?.length > 0) {
            let pIdx = parseInt(cell.dataset.privateIndex || 0);
            pIdx = direction === 'left'
                ? (pIdx - 1 + cell.privateQueue.length) % cell.privateQueue.length
                : (pIdx + 1) % cell.privateQueue.length;
            mountMediaInCell(cell, pIdx, true);
            return;
        }
        const reqType  = cell.dataset.contentType || 'all';
        const reqRatio = cell.dataset.aspectRatio || 'all';
        const len      = window.playlist.length;
        let autoTarget = null;
        if (reqRatio.includes('auto')) {
            const rect = cell.getBoundingClientRect();
            if (rect.width && rect.height) autoTarget = rect.width / rect.height;
        }
        // FIX 4: Read the live index from dataset at click time — not from
        // the stale closure variable `finalIndex` which may be -2 (sentinel)
        // or a position that has already advanced since the button was built.
        const liveIdx = parseInt(cell.dataset.currentIndex);
        let idx   = (!isNaN(liveIdx) && liveIdx >= 0) ? liveIdx : (finalIndex >= 0 ? finalIndex : 0);
        let found = false;
        for (let k = 0; k < len; k++) {
            idx = direction === 'left'
                ? (idx - 1 + len) % len
                : (idx + 1) % len;
            const f  = window.playlist[idx];
            const ft = getFileType(f);
            if (reqType !== 'all' && ft !== reqType) continue;
            if (_ratioOk(f, reqRatio, autoTarget, cell)) { found = true; break; }
        }
        if (found) mountMediaInCell(cell, idx, true);
    };
    return btn;
}

// ── PLAYBACK HELPERS ──────────────────────────────────────────
function loadNextIntoCell(cell) {
    if (window.isPaused)                   return;
    if (cell.dataset.locked === 'true')    return;
    mountMediaInCell(cell, -1);
}

function clearAllTimers() {
    window._cellTimerSet.forEach(t => clearTimeout(t));
    window._cellTimerSet.clear();
    document.querySelectorAll('.grid-cell').forEach(c => {
        if (c.dataset.timerId) clearTimeout(parseInt(c.dataset.timerId));
    });
}

function loadAndPlay(index) {
    if (window.playlist.length === 0) return;
    if (index >= window.playlist.length) index = 0;
    window.currentTrack = index;
    clearAllTimers();
    // FIX 9: When starting from index 0 (fresh load or clear+reload), wipe
    // the shuffle cycle history so old indices don't bleed into the new playlist.
    if (index === 0) window.shuffleCycleHistory?.clear();
    if (typeof saveState   === 'function') saveState();
    if (typeof renderPlaylist === 'function') renderPlaylist();

    const els = getEls();
    if (window.settings.mode === 'video') {
        els.grid.style.display  = 'none';
        els.img.style.display   = 'none';
        els.video.style.display = 'block';
        if (window.playlist.length > 0) {
            const file = window.playlist[window.currentTrack];
            els.video.src = getFileUrl(file);
            const spd = parseFloat(document.getElementById('speedSlider')?.value || 1);
            els.video.playbackRate = spd;
            els.video.play().catch(() => {});
            window.isPaused = false;
            const ppBtn = document.getElementById('playPauseBtn');
            if (ppBtn) ppBtn.innerHTML = GRID_ICONS.pause;
        }
    } else {
        els.video.pause();
        els.video.style.display = 'none';
        els.img.style.display   = 'none';
        els.grid.style.display  = 'block';
        if (!els.grid.innerHTML.trim()) window.initGrid?.();
        // Reset mix-ratio phases on explicit track jumps (queue click, auto-advance)
        if (window.settings.advanceRatioMode) _resetAllMixPhases();
        if (window.playlist.length > 0) updateGridContents();
    }
}

function getGridCapacity() {
    return document.querySelectorAll('#gridContainer .grid-cell').length || 1;
}

function playNext() {
    if (!window.playlist.length) return;
    if (window.settings.mode === 'video') {
        loadAndPlay(window.currentTrack + 1);
    } else {
        // FIX 5: Kill all pending timers BEFORE updating cells so stale
        // image timers cannot fire a second advance on top of this one.
        clearAllTimers();
        window.currentTrack = (window.currentTrack + getGridCapacity()) % window.playlist.length;
        // Reset mix-ratio phase so the new batch starts a fresh cycle
        if (window.settings.advanceRatioMode) _resetAllMixPhases();
        updateGridContents();
    }
}

function playPrev() {
    if (!window.playlist.length) return;
    if (window.settings.mode === 'video') {
        loadAndPlay(window.currentTrack <= 0 ? window.playlist.length - 1 : window.currentTrack - 1);
    } else {
        // FIX 5: Same as playNext — clear before updating.
        clearAllTimers();
        const step = getGridCapacity();
        window.currentTrack = (window.currentTrack - step + window.playlist.length) % window.playlist.length;
        // Reset mix-ratio phase so the new batch starts a fresh cycle
        if (window.settings.advanceRatioMode) _resetAllMixPhases();
        updateGridContents();
    }
}

function toggleGlobalPlayPause() {
    window.isPaused = !window.isPaused;
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.innerHTML = window.isPaused ? GRID_ICONS.play : GRID_ICONS.pause;

    document.querySelectorAll('video').forEach(vid => {
        if (window.isPaused) vid.pause();
        else if ((vid.closest('.grid-cell') && !vid.classList.contains('media-old')) ||
                 (vid.id === 'videoPlayer' && window.settings.mode === 'video'))
            vid.play().catch(() => {});
    });

    document.querySelectorAll('.grid-cell').forEach(cell => {
        const img = cell.querySelector('img, canvas');
        if (!img) return;
        if (window.isPaused) {
            if (cell.dataset.timerId) {
                const t = parseInt(cell.dataset.timerId);
                clearTimeout(t);
                _removeCellTimer(t);
                delete cell.dataset.timerId;
            }
            if (window.stopCellCountdown) window.stopCellCountdown(cell);
        } else if (!cell.dataset.locked) {
            let duration = window.settings.duration;
            if (window.settings.randomDuration) duration = getRandomDuration();
            const t = _addCellTimer(setTimeout(() => loadNextIntoCell(cell), duration));
            cell.dataset.timerId = t;
            if (window.startCellCountdown) window.startCellCountdown(cell, duration);
        }
    });
}

// ── COUNTDOWN ────────────────────────────────────────────────
window.startCellCountdown = function(cell, duration) {
    if (!window.settings.showCountdown) return;
    if (cell.dataset.cdInterval) clearInterval(parseInt(cell.dataset.cdInterval));
    let cdEl = cell.querySelector('.cell-countdown');
    if (!cdEl) { cdEl = document.createElement('div'); cdEl.className = 'cell-countdown'; cell.appendChild(cdEl); }
    const endTime = Date.now() + duration;
    cdEl.textContent = Math.ceil(duration / 1000);
    const id = setInterval(() => {
        const rem = Math.ceil((endTime - Date.now()) / 1000);
        if (rem >= 0) cdEl.textContent = rem; else clearInterval(id);
    }, 200);
    cell.dataset.cdInterval = id;
};

window.stopCellCountdown = function(cell) {
    if (cell.dataset.cdInterval) { clearInterval(parseInt(cell.dataset.cdInterval)); delete cell.dataset.cdInterval; }
};

// ── START POINT MARKER (S) ────────────────────────────────────
window.updateStartMarker = function(vid) {          // updates both the S and E markers
    if (!vid) return;
    const e   = window.startPoints?.[vid.dataset.spId];
    const dur = vid.duration;
    const ok  = dur && isFinite(dur);
    const place = (m, v, label) => {
        if (!m) return;
        if (ok && typeof v === 'number' && isFinite(v) && v < dur) {
            m.style.display = 'block';
            m.style.left    = (v / dur * 100) + '%';
            m.title         = label + ' ' + formatCellTime(v);
        } else {
            m.style.display = 'none';
        }
    };
    place(vid._spMarker, e?.time, 'Start point');
    place(vid._epMarker, e?.end,  'End point');
};
window.refreshStartMarkers = function() {
    document.querySelectorAll('.grid-cell video').forEach(window.updateStartMarker);
};

// ── A/B REPEAT ────────────────────────────────────────────────
window.toggleABRepeat = function(cell, point) {
    const vid = cell.querySelector('video.media-active');
    if (!vid) return;
    const markA = cell.querySelector('.marker-a');
    const markB = cell.querySelector('.marker-b');

    if (point === 'A') {
        if (cell.dataset.abA) {
            delete cell.dataset.abA;
            if (markA) markA.style.display = 'none';
            if (typeof showToast === 'function') showToast('Replay A: OFF', 'info');
        } else {
            const t = vid.currentTime;
            if (cell.dataset.abB && t >= parseFloat(cell.dataset.abB)) {
                if (typeof showToast === 'function') showToast('Start point cannot be after End point', 'warning');
                return;
            }
            cell.dataset.abA = t;
            if (markA) { markA.style.display = 'block'; markA.style.left = (t / vid.duration * 100) + '%'; }
            if (typeof showToast === 'function') showToast('Replay A: Set', 'success');
        }
    } else {
        if (cell.dataset.abB) {
            delete cell.dataset.abB;
            if (markB) markB.style.display = 'none';
            if (typeof showToast === 'function') showToast('Replay B: OFF', 'info');
        } else {
            const t = vid.currentTime;
            if (cell.dataset.abA && t <= parseFloat(cell.dataset.abA)) {
                if (typeof showToast === 'function') showToast('End point cannot be before Start point', 'warning');
                return;
            }
            cell.dataset.abB = t;
            if (markB) { markB.style.display = 'block'; markB.style.left = (t / vid.duration * 100) + '%'; }
            if (typeof showToast === 'function') showToast('Replay B: Set (Loop Active)', 'success');
        }
    }
};
