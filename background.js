// Greys out the toolbar icon everywhere except Amazon cart pages. The
// action is disabled by default and enabled per tab only once that tab's
// content script confirms a cart page (looksLikeCartPage in content.js) —
// the same check the popup itself relies on, so the icon is only clickable
// where the popup can actually do something.

chrome.runtime.onInstalled.addListener(() => chrome.action.disable());
// The side panel is only ever opened per tab, from the popup's "Open in
// side panel" button (which enables it for that tab), so keep the
// window-wide panel off: it would otherwise follow the user to every tab.
chrome.runtime.onInstalled.addListener(() => chrome.sidePanel.setOptions({ enabled: false }).catch(() => {}));

// "Always open in the side panel" setting: with it on, the toolbar icon has
// no popup, so clicking it fires action.onClicked, which toggles the side
// panel for that tab: closes it if it's open, otherwise opens it the same
// way the popup's button does (neither call awaited, so open() stays in the
// click's user gesture — which is also why whether it's open has to be
// known without an async lookup). The icon is only enabled on cart pages,
// so this never fires anywhere else.
//
// Open panels are tracked by the port each one keeps open to this worker
// (popup.js keepPanelPort, named "sfl-panel:<tabId>"): the port closes with
// the panel. If this worker is stopped while idle, the ports drop and the
// panels reconnect at once, so the set is rebuilt before any click needs it.
const openPanels = new Set();
chrome.runtime.onConnect.addListener((port) => {
  const m = /^sfl-panel:(\d+)$/.exec(port.name);
  if (!m) return;
  const tabId = Number(m[1]);
  openPanels.add(tabId);
  port.onDisconnect.addListener(() => openPanels.delete(tabId));
});

// sidePanel.close() is Chrome 141+; before that, disabling the tab's panel
// closes it (opening it again re-enables it).
function closeSidePanel(tabId) {
  const disable = () => chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
  if (chrome.sidePanel.close) chrome.sidePanel.close({ tabId }).catch(disable);
  else disable();
}
async function applyOpenInSidePanel() {
  const res = await chrome.storage.local.get(SYNCED_KEYS.settings);
  const s = res[SYNCED_KEYS.settings] || {};
  const on = !!s.openInSidePanel && !!(chrome.sidePanel && chrome.sidePanel.open);
  await chrome.action.setPopup({ popup: on ? '' : 'popup.html' });
}

chrome.action.onClicked.addListener((tab) => {
  if (openPanels.has(tab.id)) {
    closeSidePanel(tab.id);
    return;
  }
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `popup.html?tabId=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => { applyOpenInSidePanel(); });
chrome.runtime.onStartup.addListener(() => { applyOpenInSidePanel(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SYNCED_KEYS.settings]) applyOpenInSidePanel();
});
chrome.runtime.onStartup.addListener(() => chrome.action.disable());

function enableIfCartPage(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'SFL_PING' }, (res) => {
    // No content script there (non-Amazon page, or not injected yet).
    if (chrome.runtime.lastError) return;
    if (res && res.isCartPage) chrome.action.enable(tabId);
  });
}

// Per-tab enabled state survives navigation, so reset it whenever a tab
// starts loading something new, then re-check once it's done. The re-check
// also covers same-document navigations, where the content script isn't
// re-injected and so can't report in on its own.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') chrome.action.disable(tabId);
  else if (changeInfo.status === 'complete') enableIfCartPage(tabId);
});

// The content script reports in itself too, since Amazon can render the
// "Saved for later" section well after the page has finished loading.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'SFL_PAGE_SUPPORTED' && sender.tab) chrome.action.enable(sender.tab.id);
});

// ---- Optional sync (see storage.js) ----
importScripts('storage.js');

// Debounced to stay well inside chrome.storage.sync's write limits (120 a
// minute, 1800 an hour) while settings or labels are being changed rapidly.
const SYNC_DEBOUNCE_MS = 2000;
let syncTimer = null;
let syncChain = Promise.resolve();

function scheduleSync(delay = SYNC_DEBOUNCE_MS) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

// Runs reconciles one at a time; resolves once this one has finished.
function runSync(manual = false) {
  clearTimeout(syncTimer);
  const run = () => reconcile(manual);
  syncChain = syncChain.then(run, run);
  return syncChain;
}

// Copies each data set from whichever side (local or sync) was saved more
// recently to the other. Data saved before sync existed has no updatedAt and
// counts as oldest, but still beats having nothing on the other side.
// Automatic syncs only run while it's on here (flag.enabled); a manual one
// (Sync now) runs either way.
// If the synced data was deleted (from any computer) after automatic sync
// was turned on here, turns it off here instead, so it isn't uploaded
// again. A manual sync is asked for, so it uploads anyway — and moves
// enabledAt past the deletion, so automatic sync isn't turned off for it.
// Resolves to the status it recorded: { error, at, notice }.
async function reconcile(manual = false) {
  const local = await chrome.storage.local.get([SYNC_FLAG_KEY, ...Object.values(SYNCED_KEYS)]);
  const flag = local[SYNC_FLAG_KEY] || {};
  if (!flag.enabled && !manual) return null;
  let status = { error: null, at: Date.now() };
  try {
    const remote = await readSynced();
    if (remote.deletedAt && remote.deletedAt > (flag.enabledAt || 0)) {
      if (!manual) {
        status = { error: null, notice: 'deleted' };
        await chrome.storage.local.set({ [SYNC_FLAG_KEY]: { enabled: false }, [SYNC_STATUS_KEY]: status });
        return status;
      }
      await chrome.storage.local.set({ [SYNC_FLAG_KEY]: { ...flag, enabledAt: Date.now() } });
    }
    const toLocal = {};
    for (const name of Object.keys(SYNCED_KEYS)) {
      const l = local[SYNCED_KEYS[name]];
      const r = remote[name];
      const lt = l ? l.updatedAt || 0 : -1;
      const rt = r ? r.updatedAt || 0 : -1;
      if (rt > lt) toLocal[SYNCED_KEYS[name]] = name === 'labels' ? withLocalRuleFields(r, l) : r;
      else if (lt > rt) await writeSynced(name, l);
    }
    // A save made here since the read above is newer than what's being
    // copied in, so keep it (its own change schedules the next sync).
    const keys = Object.keys(toLocal);
    if (keys.length) {
      const now = await chrome.storage.local.get(keys);
      keys.forEach((k) => {
        const was = local[k] ? local[k].updatedAt : undefined;
        const is = now[k] ? now[k].updatedAt : undefined;
        if (is !== was) delete toLocal[k];
      });
      if (Object.keys(toLocal).length) await chrome.storage.local.set(toLocal);
    }
  } catch (e) {
    status = { error: String((e && e.message) || e) };
  }
  await chrome.storage.local.set({ [SYNC_STATUS_KEY]: status });
  return status;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') scheduleSync();
  else if (area === 'local' && (changes[SYNC_FLAG_KEY] || Object.values(SYNCED_KEYS).some((k) => changes[k]))) {
    scheduleSync(changes[SYNC_FLAG_KEY] ? 0 : SYNC_DEBOUNCE_MS);
  }
});
chrome.runtime.onStartup.addListener(() => scheduleSync(0));
chrome.runtime.onInstalled.addListener(() => scheduleSync(0));
// Sent by the popup when it opens (to pick up anything missed, if automatic
// sync is on) and by its "Sync now" button (manual: true), which waits for
// the result.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'SFL_SYNC_NOW') return false;
  runSync(!!msg.manual).then((status) => sendResponse(status), (e) => sendResponse({ error: String(e) }));
  return true;
});
