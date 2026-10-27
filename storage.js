// Optional sync of settings and labels through the user's own Chrome sync
// (chrome.storage.sync). Shared by popup.js and background.js.
//
// chrome.storage.local stays the copy everything reads and writes. When
// sync is turned on, background.js mirrors it to and from chrome.storage.sync,
// per data set, by `updatedAt`: whichever side was saved more recently wins.
//
// Sync has much tighter quotas than local (8 KB per item, 100 KB total,
// 120 writes a minute), so labels are split across several items there:
// `sfl_labels` holds the label list plus the number of item chunks, and
// `sfl_labels_items_<n>` hold the item → label ids map. Every chunk carries
// the `updatedAt` of the save it belongs to, so a reader on another computer
// can tell when chunks from a newer save are still arriving.

const SYNC_FLAG_KEY = 'sfl_sync'; // local only, per computer: { enabled, enabledAt }
const SYNC_STATUS_KEY = 'sfl_sync_status'; // local only: { error, at, notice } from the last sync attempt
// Sync only: { at }, left behind when the synced data is deleted, so other
// computers with sync on turn it off rather than upload their copy again.
const SYNC_DELETED_KEY = 'sfl_sync_deleted';
// Same keys popup.js and content.js use in chrome.storage.local.
const SYNCED_KEYS = { settings: 'sfl_settings', labels: 'sfl_labels' };
const SYNC_LABEL_CHUNK_PREFIX = 'sfl_labels_items_';
const SYNC_CHUNK_MAX_BYTES = 7000; // under QUOTA_BYTES_PER_ITEM (8192), which counts key + JSON

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

function splitLabelsForSync(payload) {
  const v = payload.updatedAt || 0;
  const overhead = byteLength(SYNC_LABEL_CHUNK_PREFIX + '999' + JSON.stringify({ v, items: {} }));
  const chunks = [];
  let cur = {};
  let size = 0;
  Object.entries(payload.items || {}).forEach(([key, ids]) => {
    const entry = byteLength(JSON.stringify(key) + ':' + JSON.stringify(ids) + ',');
    if (size && overhead + size + entry > SYNC_CHUNK_MAX_BYTES) {
      chunks.push(cur);
      cur = {};
      size = 0;
    }
    cur[key] = ids;
    size += entry;
  });
  if (size) chunks.push(cur);
  const out = { [SYNCED_KEYS.labels]: { labels: payload.labels || [], updatedAt: v, chunks: chunks.length } };
  chunks.forEach((items, i) => { out[SYNC_LABEL_CHUNK_PREFIX + i] = { v, items }; });
  return out;
}

// Null if there's nothing synced yet, or a newer save is still arriving.
function joinLabelsFromSync(all) {
  const meta = all[SYNCED_KEYS.labels];
  if (!meta) return null;
  const items = {};
  for (let i = 0; i < meta.chunks; i++) {
    const chunk = all[SYNC_LABEL_CHUNK_PREFIX + i];
    if (!chunk || chunk.v !== meta.updatedAt) return null;
    Object.assign(items, chunk.items);
  }
  return { labels: meta.labels, items, updatedAt: meta.updatedAt };
}

// { settings, labels } as currently synced, each null if absent, plus
// deletedAt if the synced data was ever deleted.
async function readSynced() {
  const all = await chrome.storage.sync.get(null);
  return {
    settings: all[SYNCED_KEYS.settings] || null,
    labels: joinLabelsFromSync(all),
    deletedAt: all[SYNC_DELETED_KEY] ? all[SYNC_DELETED_KEY].at : 0
  };
}

// Removes everything this extension keeps in Chrome sync, leaving only the
// deletion marker behind. The marker goes first, so another computer never
// sees the data gone without it (and uploads its own copy again).
async function deleteSynced() {
  await chrome.storage.sync.set({ [SYNC_DELETED_KEY]: { at: Date.now() } });
  const all = await chrome.storage.sync.get(null);
  const rest = Object.keys(all).filter((k) => k !== SYNC_DELETED_KEY);
  if (rest.length) await chrome.storage.sync.remove(rest);
}

// name: 'settings' | 'labels'. Rejects with Chrome's error (e.g. a quota
// being exceeded) if the write didn't go through.
async function writeSynced(name, value) {
  if (name === 'settings') {
    await chrome.storage.sync.set({ [SYNCED_KEYS.settings]: value });
    return;
  }
  const entries = splitLabelsForSync(value);
  await chrome.storage.sync.set(entries);
  // Drop chunks left over from an earlier, larger save.
  const all = await chrome.storage.sync.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith(SYNC_LABEL_CHUNK_PREFIX) && !(k in entries));
  if (stale.length) await chrome.storage.sync.remove(stale);
}

// Labels payloads ({ labels, items }) compared by content, ignoring
// updatedAt and the order items/ids happen to be stored in.
function sameLabelData(a, b) {
  const canon = (p) => JSON.stringify({
    labels: p.labels || [],
    items: Object.entries(p.items || {})
      .map(([key, ids]) => [key, [...ids].sort()])
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  });
  return canon(a) === canon(b);
}
