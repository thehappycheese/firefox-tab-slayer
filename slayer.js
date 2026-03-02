// ============================================================
// Tab Slayer — background.js
// ============================================================

// ------ HARD-CODED SETTINGS ---------------------------------

// How long a tab can stay open before being killed (milliseconds)
const TAB_MAX_AGE_MS = 1000 * 60 * 4; // 4 minutes

// How often to run the reaper sweep (milliseconds)
const REAPER_INTERVAL_MS = 1000 * 60 * 1; // every 5 minutes

// If true, pinned tabs are never closed
const SPARE_PINNED_TABS = true;

// If true, the currently active tab in any window is never closed
const SPARE_ACTIVE_TAB = true;

// If true, tabs that are currently audible (playing audio) are spared
const SPARE_AUDIBLE_TABS = true;

// Maximum number of tabs allowed across all windows. When exceeded, the
// oldest non-exempt tabs are closed first until the limit is met.
// Set to Infinity to disable this feature.
const MAX_TABS = 6;

// ------ HARD-CODED EXCEPTION LIST ---------------------------
// Any tab whose URL *starts with* one of these strings is never closed.
// Plain prefix matching — add trailing "/" to avoid partial domain hits.
const EXCEPTION_PREFIXES = [
    "about:",
];

// ============================================================

// Map<tabId, openedAtTimestamp>
const tabOpenedAt = new Map();

// ---- Helpers -----------------------------------------------

function isExempt(tab) {
    if (!tab) return true;

    // Pinned tabs
    if (SPARE_PINNED_TABS && tab.pinned) return true;

    // Active tab in its window
    if (SPARE_ACTIVE_TAB && tab.active) return true;

    // Audible tabs
    if (SPARE_AUDIBLE_TABS && tab.audible) return true;

    // Exception URL list
    const url = tab.url || "";
    if (EXCEPTION_PREFIXES.some(prefix => url.startsWith(prefix))) return true;

    return false;
}

function nowMs() {
    return Date.now();
}

// ---- Track tab creation ------------------------------------

browser.tabs.onCreated.addListener(tab => {
    tabOpenedAt.set(tab.id, nowMs());
    console.log(`[Tab Slayer] Tracking tab ${tab.id} opened at ${new Date().toLocaleTimeString()}`);
});

// Remove tracking when a tab is closed externally
browser.tabs.onRemoved.addListener(tabId => {
    tabOpenedAt.delete(tabId);
});

// ---- Seed existing tabs on extension start -----------------
// Tabs already open when the extension loads get a generous grace period —
// we treat them as if they just opened (current time).  If you'd rather
// kill long-running old tabs quickly, set seedAge to e.g. TAB_MAX_AGE_MS * 0.9.

async function seedExistingTabs() {
    const tabs = await browser.tabs.query({});
    const seed = nowMs();
    for (const tab of tabs) {
        if (!tabOpenedAt.has(tab.id)) {
            tabOpenedAt.set(tab.id, seed);
        }
    }
    console.log(`[Tab Slayer] Seeded ${tabs.length} existing tab(s).`);
}

// ---- Reset timer on tab visit ------------------------------

browser.tabs.onActivated.addListener(({ tabId }) => {
    if (tabOpenedAt.has(tabId)) {
        tabOpenedAt.set(tabId, nowMs());
        console.log(`[Tab Slayer] Timer reset for tab ${tabId} (activated)`);
    }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Only reset on full page navigations, not minor updates (favicon, title, etc.)
    if (changeInfo.status === "loading" && changeInfo.url) {
        tabOpenedAt.set(tabId, nowMs());
        console.log(`[Tab Slayer] Timer reset for tab ${tabId} (navigated to ${changeInfo.url})`);
    }
});

// ---- The Reaper --------------------------------------------

async function reap() {
    console.log("REAP");
    const now = nowMs();
    const tabs = await browser.tabs.query({});

    const victims = new Set();

    // Candidates: non-exempt tabs old enough to close, oldest first.
    const candidates = tabs
        .filter(t => !isExempt(t))
        .filter(t => {
            const openedAt = tabOpenedAt.get(t.id);
            if (openedAt === undefined) {
                tabOpenedAt.set(t.id, now);
                return false;
            }
            return (now - openedAt) >= TAB_MAX_AGE_MS;
        })
        .sort((a, b) => (tabOpenedAt.get(a.id) ?? now) - (tabOpenedAt.get(b.id) ?? now));

    // Never close tabs if doing so would bring the total below MAX_TABS.
    const maxVictims = Math.max(0, tabs.length - MAX_TABS);

    for (const tab of candidates) {
        if (victims.size >= maxVictims) break;
        victims.add(tab.id);
    }

    // ---- Close all victims ---------------------------------
    if (victims.size === 0) {
        console.log(`[Tab Slayer] Reaper ran — no victims at ${new Date().toLocaleTimeString()}`);
        return;
    }

    const tabMap = Object.fromEntries(tabs.map(t => [t.id, t]));
    console.log(`[Tab Slayer] Closing ${victims.size} tab(s):`);
    for (const tabId of victims) {
        const tab = tabMap[tabId];
        const ageMinutes = Math.round((now - (tabOpenedAt.get(tabId) ?? now)) / 60000);
        console.log(`  → [${tabId}] "${tab?.title}" (${ageMinutes}m old) — ${tab?.url}`);
        tabOpenedAt.delete(tabId);
        await browser.tabs.remove(tabId);
    }
}
// ---- Bootstrap ---------------------------------------------

async function init() {
    console.log("THE REAPER AWAKENS")
    await seedExistingTabs();
    // Run an initial sweep after a short grace period
    setTimeout(reap, 30_000);
    // Then on a regular interval
    setInterval(reap, REAPER_INTERVAL_MS);
    console.log(
        `[Tab Slayer] Running. Max age: ${TAB_MAX_AGE_MS / 60000}min, ` +
        `sweep every ${REAPER_INTERVAL_MS / 60000}min.`
    );
}

init();
