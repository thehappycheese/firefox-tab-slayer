// ============================================================
// Tab Slayer — background.js  (MV3-safe)
// ============================================================

// ------ SETTINGS --------------------------------------------

// Grace period: once a window is ARMED, a tab must sit past this before
// it's eligible to be closed (ms). This is the "age" clock.
const TAB_MAX_AGE_MS = 1000 * 60 * 4; // 4 minutes

// How often the reaper sweeps (ms).
const REAPER_INTERVAL_MS = 1000 * 60 * 1; // every 1 minute

// Arming FLOOR, per window, counted over *unpinned* tabs only.
//   unpinned <= MAX_TABS → disarmed: reaper idle, age clocks held at zero.
//   unpinned >  MAX_TABS → armed:    age clocks tick from the crossing.
// Crossing up resets every age clock; dropping back to/below the floor
// (by user OR reaper) resets them again. Infinity = never arm.
const MAX_TABS = 6;

const SPARE_PINNED_TABS  = true;
const SPARE_ACTIVE_TAB   = true;
const SPARE_AUDIBLE_TABS = true;

const EXCEPTION_PREFIXES = ["about:"];

// ============================================================

// ---- Two clocks + arming set (the persisted state) ---------
let lastTouchedAt = new Map(); // tabId -> ms of last real interaction (RANKING)
let graceStartAt  = new Map(); // tabId -> ms the age clock started   (ELIGIBILITY)
let armedWindows  = new Set(); // windowIds currently above the floor

const nowMs = () => Date.now();

// ---- Persistence (survives background-worker suspension) ----
const SESSION_KEY = "tabSlayerState";
let hydrated = false;

async function ensureLoaded() {
    if (hydrated) return;            // already live in this worker
    const stored = await browser.storage.session.get(SESSION_KEY);
    const s = stored[SESSION_KEY];
    if (s) {
        lastTouchedAt = new Map(s.lastTouched);
        graceStartAt  = new Map(s.grace);
        armedWindows  = new Set(s.armed);
    }
    hydrated = true;
}

async function persist() {
    await browser.storage.session.set({
        [SESSION_KEY]: {
            lastTouched: [...lastTouchedAt],
            grace:       [...graceStartAt],
            armed:       [...armedWindows],
        },
    });
}

// ---- Clock helpers -----------------------------------------

function touch(tabId, now = nowMs()) {
    lastTouchedAt.set(tabId, now); // ranking clock only — NOT eligibility
}

// Seed both clocks for a tab we haven't seen before.
function ensureKnown(tabId, now) {
    if (!lastTouchedAt.has(tabId)) lastTouchedAt.set(tabId, now);
    if (!graceStartAt.has(tabId))  graceStartAt.set(tabId, now);
}

// Reset only the AGE clock for a whole window (arm/disarm transition).
function resetAges(tabs, now) {
    for (const tab of tabs) graceStartAt.set(tab.id, now);
}

function forget(tabId) {
    lastTouchedAt.delete(tabId);
    graceStartAt.delete(tabId);
}

// ---- Counting & exemptions ---------------------------------

function unpinnedCount(tabs) {
    return tabs.filter(tab => !tab.pinned).length; // pinned never counted
}

function isExempt(tab) {
    if (!tab) return true;
    if (SPARE_PINNED_TABS  && tab.pinned)  return true;
    if (SPARE_ACTIVE_TAB   && tab.active)  return true;
    if (SPARE_AUDIBLE_TABS && tab.audible) return true;
    const url = tab.url || "";
    if (EXCEPTION_PREFIXES.some(p => url.startsWith(p))) return true;
    return false;
}

// ---- Arming state machine ----------------------------------
// Resets the AGE clocks on either crossing; leaves last-touched alone.
function syncArming(windowId, tabs, now) {
    const overFloor = unpinnedCount(tabs) > MAX_TABS;
    const wasArmed  = armedWindows.has(windowId);

    if (overFloor && !wasArmed) {
        armedWindows.add(windowId);
        resetAges(tabs, now); // crossed up → ages begin counting
        console.log(`[Tab Slayer] Window ${windowId} ARMED — age clocks started.`);
    } else if (!overFloor && wasArmed) {
        armedWindows.delete(windowId);
        resetAges(tabs, now); // dropped back → ages reset to zero
        console.log(`[Tab Slayer] Window ${windowId} disarmed — age clocks reset.`);
    }
    return overFloor;
}

// ---- Victim selection (pure, one window) -------------------
// Eligibility by AGE (graceStartAt); ordering by LAST-TOUCHED.
function chooseVictims(tabs, now) {
    const overBy = unpinnedCount(tabs) - MAX_TABS;
    if (overBy <= 0) return new Set();

    const eligible = tabs
        .filter(tab => !isExempt(tab))
        .filter(tab => now - (graceStartAt.get(tab.id) ?? now) >= TAB_MAX_AGE_MS)
        // oldest first = smallest last-touched time = least recently used
        .sort((a, b) =>
            (lastTouchedAt.get(a.id) ?? now) - (lastTouchedAt.get(b.id) ?? now));

    const victims = new Set();
    for (const tab of eligible) {
        if (victims.size >= overBy) break; // only trim back to the floor
        victims.add(tab.id);
    }
    return victims;
}

// ---- The Reaper (alarm-driven) -----------------------------

async function reap() {
    await ensureLoaded();
    const now = nowMs();
    const windows = await browser.windows.getAll({
        populate: true,
        windowTypes: ["normal"],
    });

    let total = 0;
    for (const win of windows) {
        for (const t of win.tabs) ensureKnown(t.id, now);

        if (!syncArming(win.id, win.tabs, now)) continue;

        const victims = chooseVictims(win.tabs, now);
        if (victims.size === 0) continue;

        const byId = Object.fromEntries(win.tabs.map(t => [t.id, t]));
        console.log(`[Tab Slayer] Window ${win.id}: closing ${victims.size} tab(s):`);
        for (const tabId of victims) {
            const tab = byId[tabId];
            const ageMin   = Math.round((now - (graceStartAt.get(tabId)  ?? now)) / 60000);
            const idleMin  = Math.round((now - (lastTouchedAt.get(tabId) ?? now)) / 60000);
            console.log(`  → [${tabId}] "${tab?.title}" (age ${ageMin}m, idle ${idleMin}m) — ${tab?.url}`);
            forget(tabId);
            await browser.tabs.remove(tabId);
        }

        // Re-evaluate now that the window is smaller (may disarm + reset ages).
        const after = await browser.windows.get(win.id, { populate: true });
        syncArming(win.id, after.tabs, nowMs());
        total += victims.size;
    }

    if (total === 0) {
        console.log(`[Tab Slayer] Reaper ran — no victims at ${new Date().toLocaleTimeString()}`);
    }
    await persist();
}

// ---- Re-evaluate one window after a change -----------------
async function refreshWindow(windowId) {
    if (windowId === undefined || windowId === browser.windows.WINDOW_ID_NONE) return;
    await ensureLoaded();
    let win;
    try {
        win = await browser.windows.get(windowId, { populate: true });
    } catch {
        armedWindows.delete(windowId); // window gone
        await persist();
        return;
    }
    if (win.type !== "normal") return;
    const now = nowMs();
    for (const t of win.tabs) ensureKnown(t.id, now);
    syncArming(win.id, win.tabs, now);
    await persist();
}

// ---- Tab lifecycle tracking --------------------------------

browser.tabs.onCreated.addListener(async tab => {
    await ensureLoaded();
    const now = nowMs();
    ensureKnown(tab.id, now); // new tab gets its own fresh age + touch
    await persist();
    await refreshWindow(tab.windowId); // may push window over the floor
});

browser.tabs.onRemoved.addListener(async (tabId, info) => {
    await ensureLoaded();
    forget(tabId);
    await persist();
    if (!info.isWindowClosing) await refreshWindow(info.windowId); // user closed one → maybe disarm
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
    await ensureLoaded();
    touch(tabId);            // ranking only
    await persist();
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    await ensureLoaded();
    let dirty = false;
    if (changeInfo.status === "loading" && changeInfo.url) { touch(tabId); dirty = true; }
    await persist();
    if (changeInfo.pinned !== undefined) await refreshWindow(tab.windowId); // pin/unpin shifts count
    else if (dirty) { /* already persisted */ }
});

browser.tabs.onAttached.addListener((tabId, info) => refreshWindow(info.newWindowId));
browser.tabs.onDetached.addListener((tabId, info) => refreshWindow(info.oldWindowId));

// ---- Bootstrap ---------------------------------------------

async function seedExistingTabs() {
    await ensureLoaded();
    const now = nowMs();
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) ensureKnown(tab.id, now); // seeds only unknowns
    await persist();
    console.log(`[Tab Slayer] Seeded ${tabs.length} existing tab(s).`);
}

function installAlarm() {
    browser.alarms.create("reaper", {
        delayInMinutes: 0.5,
        periodInMinutes: REAPER_INTERVAL_MS / 60000,
    });
}

browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === "reaper") reap();
});

// Runs on every cold start of the background worker (idempotent).
(async function init() {
    await seedExistingTabs();
    installAlarm();
    console.log(
        `[Tab Slayer] Running. Grace: ${TAB_MAX_AGE_MS / 60000}min, ` +
        `arm floor: ${MAX_TABS} unpinned/window, sweep every ${REAPER_INTERVAL_MS / 60000}min.`
    );
})();