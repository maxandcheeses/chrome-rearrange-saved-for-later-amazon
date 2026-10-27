// Greys out the toolbar icon everywhere except Amazon cart pages. The
// action is disabled by default and enabled per tab only once that tab's
// content script confirms a cart page (looksLikeCartPage in content.js) —
// the same check the popup itself relies on, so the icon is only clickable
// where the popup can actually do something.

chrome.runtime.onInstalled.addListener(() => chrome.action.disable());
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
function runSync() {
  clearTimeout(syncTimer);
  syncChain = syncChain.then(reconcile, reconcile);
  return syncChain;
}

// Copies each data set from whichever side (local or sync) was saved more
// recently to the other. Data saved before sync existed has no updatedAt and
// counts as oldest, but still beats having nothing on the other side.
// If the synced data was deleted (from any computer) after sync was turned
// on here, turns sync off here instead, so it isn't uploaded again.
// Resolves to the status it recorded: { error, at, notice }.
async function reconcile() {
  const local = await chrome.storage.local.get([SYNC_FLAG_KEY, ...Object.values(SYNCED_KEYS)]);
  const flag = local[SYNC_FLAG_KEY];
  if (!(flag && flag.enabled)) return null;
  let status = { error: null, at: Date.now() };
  try {
    const remote = await readSynced();
    if (remote.deletedAt && remote.deletedAt > (flag.enabledAt || 0)) {
      status = { error: null, notice: 'deleted' };
      await chrome.storage.local.set({ [SYNC_FLAG_KEY]: { enabled: false }, [SYNC_STATUS_KEY]: status });
      return status;
    }
    const toLocal = {};
    for (const name of Object.keys(SYNCED_KEYS)) {
      const l = local[SYNCED_KEYS[name]];
      const r = remote[name];
      const lt = l ? l.updatedAt || 0 : -1;
      const rt = r ? r.updatedAt || 0 : -1;
      if (rt > lt) toLocal[SYNCED_KEYS[name]] = r;
      else if (lt > rt) await writeSynced(name, l);
    }
    if (Object.keys(toLocal).length) await chrome.storage.local.set(toLocal);
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
// Sent by the popup when it opens (to pick up anything missed) and by its
// "Sync now" button, which waits for the result.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'SFL_SYNC_NOW') return false;
  runSync().then((status) => sendResponse(status), (e) => sendResponse({ error: String(e) }));
  return true;
});
