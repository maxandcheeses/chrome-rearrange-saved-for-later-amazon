const STORAGE_KEY = 'sfl_settings';
const DEFAULTS = {
  bumpDelayMs: 600,
  reloadAfterApply: true,
  tileSize: 'm',
  defaultView: 'popup',
  titleLinksEnabled: true,
  tableView: false
};

let order = []; // array of keys, top to bottom (may include manual reordering)
let naturalOrder = []; // array of keys in the order Amazon's page actually shows them
let itemsByKey = new Map();
let cartItems = []; // items currently in the cart, eligible to be saved for later
let savingCartKey = null; // key currently being moved from cart -> saved, if any
let deletingKey = null; // key currently being deleted from saved-for-later, if any
let activeTabId = null;
let statusPollHandle = null;
let watchHandle = null;
let applyInProgress = false;
let loadingAll = false;
let estimateDebounceHandle = null;
let estimateRequestSeq = 0;
let gridMode = false;
let tableView = false;
let tileSize = 'm';
let titleLinksEnabled = true;
let defaultView = 'popup'; // 'grid' means Extended is the default — closeGridBtn closes the popup instead of returning to compact
const TILE_SIZES = { s: { min: '110px', img: '70px' }, m: { min: '150px', img: '100px' }, l: { min: '200px', img: '140px' } };

// User-defined labels ("Grocery", "Electronics"…) that can be put on items
// and used to filter the view. An item can have any number of labels.
// Labels don't affect ordering at all — reordering and Apply always work on
// the full list, even while filtered. Persisted in chrome.storage.local,
// keyed by item key (the ASIN), so they survive popup closes and reloads.
const LABELS_STORAGE_KEY = 'sfl_labels';
const LABEL_COLORS = 8; // see .label-c0 … .label-c7 in popup.html
const LABEL_NAME_MAX = 40;
let labels = []; // [{ id, name, color }]
let labelsOf = new Map(); // item key -> Set of label ids
let labelFilter = 'all'; // 'all' | 'none' | label id
// While the label editor is open: the state from before it opened. Edits
// made in it show up live but aren't saved or recorded as undo steps until
// Done (one step for the whole session); dismissing the editor any other
// way restores this. Null when the editor isn't open.
let labelEditBefore = null;
// updatedAt of the settings/labels this popup last loaded or saved, to tell
// its own writes apart from ones that came in through sync while it's open.
const seenUpdatedAt = { settings: undefined, labels: undefined };
// Items picked with Shift+click. Dragging any of them moves them all as one
// block (see moveKeysTo). Display-only state — never persisted.
let selectedKeys = new Set();
// "Show interposing items": while filtered, also show (dimmed) the
// non-matching items sitting between the first and last match, for context
// when reordering. Deliberately not persisted, and reset whenever the
// filter changes — it always starts off.
let showInBetween = false;

function $(id) { return document.getElementById(id); }

// Item titles are hyperlinks to the product when we know its URL (falls back
// to plain text otherwise, e.g. for items scanned before a url field existed
// in an older cached snapshot).
function makeTitleEl(item, key) {
  const text = item ? item.title : key;
  const useLink = titleLinksEnabled && item && item.url;
  const el = document.createElement(useLink ? 'a' : 'span');
  el.className = 'title';
  el.textContent = text;
  el.title = text;
  if (useLink) {
    el.href = item.url;
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
    // <a> elements are natively draggable, and since the parent row also
    // has draggable=true for our own drag-to-reorder, a mousedown on the
    // link would otherwise kick off the browser's native link-drag instead
    // of a click. Disabling that lets clicks through normally.
    el.draggable = false;
    // Don't let clicking the link kick off a drag on the parent row.
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      // Shift+click selects the row (handled by the row's own listener)
      // rather than opening the product.
      if (e.shiftKey) { e.preventDefault(); return; }
      e.stopPropagation();
      // A normal target="_blank" navigation opens a focused foreground tab,
      // which steals window focus and causes Chrome to auto-close this
      // popup. Opening the tab in the background (active: false) via the
      // extension API keeps focus on the popup so it stays open.
      e.preventDefault();
      chrome.tabs.create({ url: item.url, active: false });
    });
  }
  return el;
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(res);
      }
    });
  });
}

async function getActiveTab() {
  const [tab] = await new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, resolve)
  );
  return tab;
}

function renderList() {
  renderLabelFilter();
  const listEl = $('list');
  listEl.innerHTML = '';
  order.forEach((key, idx) => {
    const visibility = labelVisibility(key, idx);
    if (!visibility) return;
    const item = itemsByKey.get(key);
    const li = document.createElement('li');
    if (visibility === 'between') li.classList.add('between-item');
    li.draggable = true;
    li.dataset.key = key;
    setupSelectable(li, key);
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openItemMenu(key, e.clientX, e.clientY);
    });

    const badge = document.createElement('input');
    badge.type = 'number';
    badge.className = 'badge';
    badge.min = '1';
    badge.max = String(order.length);
    badge.value = String(idx + 1);
    badge.title = 'Type a number to jump this item to that position';
    badge.addEventListener('mousedown', (e) => e.stopPropagation());
    badge.addEventListener('focus', () => { li.draggable = false; });
    badge.addEventListener('blur', () => { li.draggable = true; });
    badge.addEventListener('change', () => {
      const newPos = Math.min(Math.max(1, Math.round(Number(badge.value)) || (idx + 1)), order.length);
      moveKeyToPosition(key, newPos);
    });
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') badge.blur();
    });

    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = '⠿';

    const img = document.createElement('img');
    img.alt = '';
    if (item && item.image) {
      img.src = item.image;
    } else {
      img.style.visibility = 'hidden';
    }
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });

    const title = makeTitleEl(item, key);

    li.append(badge, handle, img, title, makeLabelChips(key));
    listEl.appendChild(li);
  });
  appendFilterEmptyNote(listEl);
  attachDragHandlers();
  renderTileGrid();
}

// Tile-based view shown alongside the plain list (toggled via body.grid-mode
// in CSS) so users reordering long lists can see many items at once instead
// of scrolling through a narrow single-column list. Shares `order` /
// `itemsByKey` and the same move/persist logic as the list view — only the
// markup and drag handlers are separate, so both views always stay in sync.
function renderTileGrid() {
  const gridEl = $('tileGrid');
  gridEl.innerHTML = '';
  order.forEach((key, idx) => {
    const visibility = labelVisibility(key, idx);
    if (!visibility) return;
    const item = itemsByKey.get(key);
    const li = document.createElement('li');
    li.className = visibility === 'between' ? 'tile between-item' : 'tile';
    li.draggable = true;
    li.dataset.key = key;
    setupSelectable(li, key);
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openItemMenu(key, e.clientX, e.clientY);
    });

    const badge = document.createElement('input');
    badge.type = 'number';
    badge.className = 'badge';
    badge.min = '1';
    badge.max = String(order.length);
    badge.value = String(idx + 1);
    badge.title = 'Type a number to jump this item to that position';
    badge.addEventListener('mousedown', (e) => e.stopPropagation());
    badge.addEventListener('focus', () => { li.draggable = false; });
    badge.addEventListener('blur', () => { li.draggable = true; });
    badge.addEventListener('change', () => {
      const newPos = Math.min(Math.max(1, Math.round(Number(badge.value)) || (idx + 1)), order.length);
      moveKeyToPosition(key, newPos);
    });
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') badge.blur();
    });

    const imgWrap = document.createElement('div');
    imgWrap.className = 'imgwrap';
    const img = document.createElement('img');
    img.alt = '';
    if (item && item.image) {
      img.src = item.image;
    } else {
      img.style.visibility = 'hidden';
    }
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    imgWrap.appendChild(img);

    const title = makeTitleEl(item, key);

    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = '⠿';

    li.append(badge, handle, imgWrap, title, makeLabelChips(key));
    gridEl.appendChild(li);
  });
  appendFilterEmptyNote(gridEl);
  attachTileDragHandlers();
}

function attachTileDragHandlers() {
  const gridEl = $('tileGrid');
  // Table view lays tiles out as a single top-to-bottom column, so the
  // drop-line split should follow the vertical midpoint there, same as the
  // plain list; the real tile grid flows left-to-right, so it uses the
  // horizontal midpoint instead.
  const axis = gridEl.classList.contains('table-view') ? 'y' : 'x';
  attachReorderDragHandlers(gridEl, 'li.tile', axis);
}

function applyTileSize(size, persist = true) {
  tileSize = size;
  const cfg = TILE_SIZES[size] || TILE_SIZES.m;
  document.documentElement.style.setProperty('--tile-min', cfg.min);
  document.documentElement.style.setProperty('--tile-img', cfg.img);
  document.querySelectorAll('.tileSizeBtn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });
  if (persist) saveSettings();
}

function setTableView(on, persist = true) {
  tableView = on;
  $('tileGrid').classList.toggle('table-view', on);
  const btn = $('tableViewBtn');
  btn.classList.toggle('active', on);
  btn.textContent = on ? '▦' : '☰';
  btn.title = on ? 'Switch to grid view' : 'Switch to table view';
  // Zoom doesn't apply to the single-column table layout.
  $('gridModalHeader').classList.toggle('table-view', on);
  if (persist) saveSettings();
}

// Hovering an item thumbnail for IMAGE_PREVIEW_DELAY_MS pops up an enlarged
// copy beside it. Uses delegated listeners on the document since the list,
// tile grid and cart list are all re-rendered from scratch on every change.
// The preview has pointer-events: none so it never steals hover from the
// thumbnail or intercepts drags. Once a preview has been shown, moving onto
// another thumbnail within IMAGE_PREVIEW_WARM_MS shows its preview
// immediately, so scanning across items doesn't pay the delay every time.
const IMAGE_PREVIEW_DELAY_MS = 500;
const IMAGE_PREVIEW_WARM_MS = 400;
const PREVIEW_IMG_SELECTOR = '#list img, #tileGrid img, #cartList img';
let previewTimer = null;
let previewTarget = null;
let previewWarmUntil = 0;

// keepWarm: leaving a thumbnail (as opposed to clicking/dragging/scrolling)
// keeps the instant-show window open if a preview was actually visible.
function hideImagePreview(keepWarm = false) {
  const preview = $('imagePreview');
  previewWarmUntil = keepWarm && preview.classList.contains('show') ? Date.now() + IMAGE_PREVIEW_WARM_MS : 0;
  clearTimeout(previewTimer);
  previewTimer = null;
  previewTarget = null;
  preview.classList.remove('show');
}

function showImagePreview(img) {
  // The thumbnail may have been re-rendered away while we were waiting.
  if (!img.isConnected) { hideImagePreview(); return; }
  const preview = $('imagePreview');
  const previewImg = preview.querySelector('img');
  const place = () => {
    if (previewTarget !== img) return;
    preview.classList.add('show');
    const rect = img.getBoundingClientRect();
    const pw = preview.offsetWidth;
    const ph = preview.offsetHeight;
    const gap = 8;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Prefer the right side of the thumbnail, then the left, then centered
    // over it if neither side has room (e.g. the narrow compact popup).
    let left = rect.right + gap;
    if (left + pw > vw - margin) left = rect.left - gap - pw;
    if (left < margin) left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(margin, Math.min(left, vw - margin - pw));
    const top = Math.max(margin, Math.min(rect.top + rect.height / 2 - ph / 2, vh - margin - ph));
    preview.style.left = `${left}px`;
    preview.style.top = `${top}px`;
  };
  previewImg.onload = place;
  previewImg.src = img.currentSrc || img.src;
  if (previewImg.complete) place();
}

function setupImagePreview() {
  document.addEventListener('mouseover', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.matches(PREVIEW_IMG_SELECTOR)) return;
    if (img === previewTarget) return;
    const warm = $('imagePreview').classList.contains('show') || Date.now() < previewWarmUntil;
    hideImagePreview();
    if (!img.src || img.style.visibility === 'hidden') return;
    previewTarget = img;
    if (warm) {
      showImagePreview(img);
    } else {
      previewTimer = setTimeout(() => showImagePreview(img), IMAGE_PREVIEW_DELAY_MS);
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target === previewTarget) hideImagePreview(true);
  });
  // Starting a drag, clicking, or scrolling should dismiss the preview right
  // away rather than leaving it floating over a moved/scrolled thumbnail.
  const dismiss = () => hideImagePreview();
  document.addEventListener('mousedown', dismiss, true);
  document.addEventListener('dragstart', dismiss, true);
  document.addEventListener('scroll', dismiss, true);
}

// Custom tooltips for every element with a `title`, because Chrome's native
// tooltip delay is long and can't be configured. Shows after
// TOOLTIP_DELAY_MS, then instantly for neighbouring elements within
// TOOLTIP_WARM_MS (like native tooltips). Code keeps setting `.title` as
// usual: on hover it's moved into data-tip so the native tooltip never also
// appears, and a later `.title` write (e.g. a toggle's Show/Hide text) is
// picked up on the next hover.
const TOOLTIP_DELAY_MS = 1000;
const TOOLTIP_WARM_MS = 400;
let tooltipTimer = null;
let tooltipTarget = null;
let tooltipWarmUntil = 0;

function tooltipText(el) {
  if (el.hasAttribute('title')) {
    el.dataset.tip = el.getAttribute('title');
    el.removeAttribute('title');
  }
  return el.dataset.tip || '';
}

function hideTooltip(keepWarm = false) {
  const tip = $('tooltip');
  tooltipWarmUntil = keepWarm && tip.classList.contains('show') ? Date.now() + TOOLTIP_WARM_MS : 0;
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  tooltipTarget = null;
  tip.classList.remove('show');
}

function showTooltip(el) {
  if (!el.isConnected || tooltipTarget !== el) { hideTooltip(); return; }
  const tip = $('tooltip');
  tip.textContent = tooltipText(el);
  tip.classList.add('show');
  // Below the element, centered; above it if there's no room below.
  const rect = el.getBoundingClientRect();
  const gap = 6;
  const margin = 4;
  let top = rect.bottom + gap;
  if (top + tip.offsetHeight > window.innerHeight - margin) top = rect.top - gap - tip.offsetHeight;
  const left = rect.left + rect.width / 2 - tip.offsetWidth / 2;
  tip.style.top = `${Math.max(margin, top)}px`;
  tip.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - margin - tip.offsetWidth))}px`;
}

function setupTooltips() {
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[title], [data-tip]');
    if (!el || el === tooltipTarget) return;
    const warm = $('tooltip').classList.contains('show') || Date.now() < tooltipWarmUntil;
    hideTooltip();
    if (!tooltipText(el)) return;
    tooltipTarget = el;
    if (warm) showTooltip(el);
    else tooltipTimer = setTimeout(() => showTooltip(el), TOOLTIP_DELAY_MS);
  });
  document.addEventListener('mouseout', (e) => {
    if (!tooltipTarget || !tooltipTarget.contains(e.target)) return;
    if (e.relatedTarget && tooltipTarget.contains(e.relatedTarget)) return;
    hideTooltip(true);
  });
  const dismiss = () => hideTooltip();
  document.addEventListener('mousedown', dismiss, true);
  document.addEventListener('dragstart', dismiss, true);
  document.addEventListener('scroll', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
}

function setGridMode(on) {
  gridMode = on;
  document.body.classList.toggle('grid-mode', on);
}

// Chrome caps popups at 800x600 screen pixels, so at a page zoom above 100%
// the body's fixed 800px width / 600px max-height no longer fit and the
// popup shows scrollbars. Once the popup has had time to grow, any remaining
// overflow means it hit the cap — shrink the body to the space it got.
let fitBodyTimer = null;
function fitBodyToPopup() {
  clearTimeout(fitBodyTimer);
  fitBodyTimer = setTimeout(() => {
    const body = document.body;
    if (body.offsetWidth > window.innerWidth) body.style.maxWidth = `${window.innerWidth}px`;
    if (body.offsetHeight > window.innerHeight) body.style.maxHeight = `${window.innerHeight}px`;
  }, 300);
}
window.addEventListener('resize', fitBodyToPopup);
new ResizeObserver(fitBodyToPopup).observe(document.body);

function renderCartList() {
  const section = $('cartSection');
  const listEl = $('cartList');
  listEl.innerHTML = '';

  if (cartItems.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  cartItems.forEach((item) => {
    const li = document.createElement('li');

    const img = document.createElement('img');
    img.alt = '';
    if (item.image) {
      img.src = item.image;
    } else {
      img.style.visibility = 'hidden';
    }
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });

    const title = makeTitleEl(item, item.key);

    const btn = document.createElement('button');
    btn.textContent = savingCartKey === item.key ? 'Saving…' : 'Save for later';
    btn.disabled = !!savingCartKey || applyInProgress;
    btn.addEventListener('click', () => saveCartItemForLater(item.key));

    li.append(img, title, btn);
    listEl.appendChild(li);
  });
}

async function saveCartItemForLater(key) {
  if (!activeTabId || savingCartKey || applyInProgress) return;
  savingCartKey = key;
  renderCartList();
  try {
    const res = await sendToTab(activeTabId, { type: 'SFL_SAVE_FOR_LATER', key });
    if (!res || !res.ok) {
      setStatus(res && res.error ? res.error : 'Could not move that item to Saved for later.', true);
    }
  } catch (err) {
    setStatus(`Could not reach the page: ${err.message}`, true);
  }
  savingCartKey = null;
  await fetchCartItems();
  await loadItems();
}

async function fetchCartItems() {
  if (!activeTabId) return;
  let res;
  try {
    res = await sendToTab(activeTabId, { type: 'SFL_GET_CART_ITEMS' });
  } catch (err) {
    return;
  }
  cartItems = (res && res.items) || [];
  renderCartList();
}

function moveKeyToPosition(key, newPos) {
  const fromIdx = order.indexOf(key);
  if (fromIdx === -1) return;
  const before = snapshotState();
  order.splice(fromIdx, 1);
  order.splice(newPos - 1, 0, key);
  recordChange(before);
  renderList();
  updateApplyButton();
  persistOrder();
}

// ---- Undo / redo ----

// Snapshots of the arrangement and labels, taken before each change. Lives
// only in popup memory (gone when the popup closes) and is cleared once an
// Apply completes, since the page's real order has moved on by then.
const HISTORY_LIMIT = 100;
let undoStack = [];
let redoStack = [];

function snapshotState() {
  return {
    order: order.slice(),
    labels: labels.map((l) => ({ ...l })),
    labelsOf: [...labelsOf].map(([key, ids]) => [key, [...ids]])
  };
}

// Records `before` as an undo step if anything actually changed since it
// was taken; a new change also discards any redo steps.
function recordChange(before) {
  if (labelEditBefore) return; // the label editor records one step on Done
  if (JSON.stringify(before) === JSON.stringify(snapshotState())) return;
  undoStack.push(before);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

// Restores a snapshot onto the items currently loaded: items the snapshot
// doesn't know about (loaded since) keep their place at the end, and items
// no longer on the page are dropped.
function restoreState(snap) {
  const live = new Set(order);
  const kept = snap.order.filter((k) => live.has(k));
  const keptSet = new Set(kept);
  order = kept.concat(order.filter((k) => !keptSet.has(k)));
  labels = snap.labels.map((l) => ({ ...l }));
  labelsOf = new Map(snap.labelsOf.map(([key, ids]) => [key, new Set(ids)]));
  commitLabelChange();
  updateApplyButton();
  persistOrder();
  if (arraysEqual(order, naturalOrder)) setApplyBtnSub('');
}

function undo() {
  if (!undoStack.length || applyInProgress) return;
  redoStack.push(snapshotState());
  restoreState(undoStack.pop());
  updateHistoryButtons();
}

function redo() {
  if (!redoStack.length || applyInProgress) return;
  undoStack.push(snapshotState());
  restoreState(redoStack.pop());
  updateHistoryButtons();
}

function clearHistory() {
  undoStack = [];
  redoStack = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const noUndo = !undoStack.length || applyInProgress;
  const noRedo = !redoStack.length || applyInProgress;
  $('undoBtn').disabled = noUndo;
  $('undoBtnModal').disabled = noUndo;
  $('redoBtn').disabled = noRedo;
  $('redoBtnModal').disabled = noRedo;
}

// ---- Labels ----

function getLabel(id) {
  return labels.find((l) => l.id === id);
}

function itemLabelIds(key) {
  return labelsOf.get(key) || new Set();
}

function matchesLabelFilter(key) {
  if (labelFilter === 'all') return true;
  const ids = itemLabelIds(key);
  return labelFilter === 'none' ? ids.size === 0 : ids.has(labelFilter);
}

// 'match' if the item passes the label filter, 'between' if it doesn't but
// "Show interposing items" is on and it sits between the first and last
// match in the full order (idx is its index in `order`), otherwise null.
function labelVisibility(key, idx) {
  if (matchesLabelFilter(key)) return 'match';
  if (!showInBetween) return null;
  const first = order.findIndex(matchesLabelFilter);
  if (first === -1 || idx < first) return null;
  for (let i = order.length - 1; i > idx; i--) {
    if (matchesLabelFilter(order[i])) return 'between';
  }
  return null;
}

function loadLabels() {
  return new Promise((resolve) => {
    chrome.storage.local.get(LABELS_STORAGE_KEY, (res) => {
      const saved = res[LABELS_STORAGE_KEY] || {};
      seenUpdatedAt.labels = saved.updatedAt;
      labels = Array.isArray(saved.labels) ? saved.labels : [];
      labelsOf = new Map();
      Object.entries(saved.items || {}).forEach(([key, ids]) => {
        const valid = (ids || []).filter((id) => getLabel(id));
        if (valid.length) labelsOf.set(key, new Set(valid));
      });
      resolve();
    });
  });
}

function saveLabels() {
  const items = {};
  labelsOf.forEach((ids, key) => { if (ids.size) items[key] = [...ids]; });
  const updatedAt = Date.now();
  seenUpdatedAt.labels = updatedAt;
  chrome.storage.local.set({ [LABELS_STORAGE_KEY]: { labels, items, updatedAt } });
}

// Common tail for anything that changes labels: persist, then refresh the
// filter controls (names/counts) and both views.
function commitLabelChange() {
  if (labelFilter !== 'all' && labelFilter !== 'none' && !getLabel(labelFilter)) {
    labelFilter = 'all';
    showInBetween = false;
  }
  if (!labelEditBefore) saveLabels();
  renderList();
}

function finishLabelEdit() {
  if (!labelEditBefore) return;
  const before = labelEditBefore;
  labelEditBefore = null;
  recordChange(before);
  saveLabels();
}

function discardLabelEdit() {
  if (!labelEditBefore) return;
  labels = labelEditBefore.labels.map((l) => ({ ...l }));
  labelsOf = new Map(labelEditBefore.labelsOf.map(([key, ids]) => [key, new Set(ids)]));
  labelEditBefore = null;
  commitLabelChange();
}

function createLabel(name, forKey) {
  const before = snapshotState();
  const id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Reuse the least-used color so neighbouring labels stay distinguishable.
  const used = labels.map((l) => l.color);
  let color = 0;
  for (let c = 0; c < LABEL_COLORS; c++) {
    if (used.filter((u) => u === c).length < used.filter((u) => u === color).length) color = c;
  }
  labels.push({ id, name, color });
  if (forKey) setItemLabel(forKey, id, true);
  recordChange(before);
  commitLabelChange();
}

function setItemLabel(key, id, on) {
  const ids = new Set(itemLabelIds(key));
  if (on) ids.add(id); else ids.delete(id);
  if (ids.size) labelsOf.set(key, ids); else labelsOf.delete(key);
}

function toggleItemLabel(key, id) {
  const before = snapshotState();
  setItemLabel(key, id, !itemLabelIds(key).has(id));
  recordChange(before);
  commitLabelChange();
}

// Moves a label before/after another in the label list. The order is what
// the filter dropdown, the right-click menu and item chips follow.
function moveLabel(id, targetId, position) {
  if (id === targetId) return;
  const before = snapshotState();
  const moving = getLabel(id);
  if (!moving || !getLabel(targetId)) return;
  labels = labels.filter((l) => l !== moving);
  const idx = labels.findIndex((l) => l.id === targetId);
  labels.splice(position === 'after' ? idx + 1 : idx, 0, moving);
  recordChange(before);
  commitLabelChange();
}

function renameLabel(id, name) {
  const label = getLabel(id);
  if (!label) return;
  const before = snapshotState();
  label.name = name;
  recordChange(before);
  commitLabelChange();
}

function setLabelColor(id, color) {
  const label = getLabel(id);
  if (!label || label.color === color) return;
  const before = snapshotState();
  label.color = color;
  recordChange(before);
  commitLabelChange();
}

// Deletes a label. With targetId, every item that had it gets that label
// instead; otherwise the label is just removed from them. Item positions
// never change either way.
function deleteLabel(id, targetId) {
  const before = snapshotState();
  labelsOf.forEach((ids, key) => {
    if (!ids.has(id)) return;
    setItemLabel(key, id, false);
    if (getLabel(targetId)) setItemLabel(key, targetId, true);
  });
  labels = labels.filter((l) => l.id !== id);
  recordChange(before);
  commitLabelChange();
}

function labelCount(id) {
  return order.filter((k) => itemLabelIds(k).has(id)).length;
}

function makeLabelChips(key) {
  const wrap = document.createElement('span');
  wrap.className = 'label-chips';
  labels.forEach((label) => {
    if (!itemLabelIds(key).has(label.id)) return;
    const chip = document.createElement('span');
    chip.className = `label-chip label-c${label.color}`;
    chip.textContent = label.name;
    chip.title = label.name;
    wrap.appendChild(chip);
  });
  return wrap;
}

function appendFilterEmptyNote(container) {
  if (labelFilter === 'all' || !order.length || order.some(matchesLabelFilter)) return;
  const li = document.createElement('li');
  li.className = 'filter-empty';
  li.textContent = labelFilter === 'none' ? 'Every item has a label.' : 'No items have this label yet. Right-click an item to add it.';
  container.appendChild(li);
}

// Value of the "Edit labels…" entry at the bottom of the filter dropdowns.
// It's an action, not a filter: picking it opens the label editor and the
// dropdown snaps back to the current filter.
const EDIT_LABELS_OPTION = '__edit';

// Fills both filter dropdowns (compact + grid) and updates the interposing
// items toggle.
function renderLabelFilter() {
  ['labelFilter', 'labelFilterModal'].forEach((id) => {
    const select = $(id);
    select.innerHTML = '';
    const add = (value, text) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    };
    add('all', `All items (${order.length})`);
    labels.forEach((l) => add(l.id, `${l.name} (${labelCount(l.id)})`));
    if (labels.length) {
      add('none', `No label (${order.filter((k) => itemLabelIds(k).size === 0).length})`);
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '──────────';
      select.appendChild(sep);
      add(EDIT_LABELS_OPTION, '✎ Edit labels…');
    }
    select.value = labelFilter;
  });
  ['inBetweenBtn', 'inBetweenBtnModal'].forEach((id) => {
    const btn = $(id);
    btn.style.display = labelFilter === 'all' ? 'none' : '';
    btn.classList.toggle('active', showInBetween);
    btn.setAttribute('aria-pressed', String(showInBetween));
    const text = `${showInBetween ? 'Hide' : 'Show'} interposing items`;
    btn.title = text;
    btn.setAttribute('aria-label', text);
  });
}

function setLabelFilter(value) {
  labelFilter = value;
  showInBetween = false;
  // A hidden item staying selected would get dragged along unseen.
  selectedKeys.clear();
  renderList();
}

// ---- Context menu ----

function closeContextMenu() {
  $('ctxMenu').classList.remove('show');
}

// entries: [{ label, onClick, danger }] | { heading } | 'sep'
function openContextMenu(entries, x, y) {
  const menu = $('ctxMenu');
  menu.innerHTML = '';
  entries.forEach((entry) => {
    if (entry === 'sep') {
      menu.appendChild(document.createElement('hr'));
    } else if (entry.heading) {
      const el = document.createElement('div');
      el.className = 'ctx-heading';
      const text = document.createElement('span');
      text.textContent = entry.heading;
      el.appendChild(text);
      if (entry.closable) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'ctx-close';
        close.textContent = '✕';
        close.title = 'Close';
        close.addEventListener('click', closeContextMenu);
        el.appendChild(close);
      }
      menu.appendChild(el);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = entry.label;
      btn.title = entry.label;
      if (entry.danger) btn.classList.add('danger');
      // keepOpen entries (label toggles) leave the menu up so several can
      // be ticked in a row; their onClick re-opens it to refresh the ✓s.
      btn.addEventListener('click', () => {
        if (!entry.keepOpen) closeContextMenu();
        entry.onClick();
      });
      menu.appendChild(btn);
    }
  });
  menu.classList.add('show');
  const margin = 4;
  const left = Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openItemMenu(key, x, y) {
  if (applyInProgress || deletingKey) return;
  const current = itemLabelIds(key);
  const entries = [{ heading: 'Labels', closable: true }];
  labels.forEach((l) => {
    entries.push({
      label: `${current.has(l.id) ? '✓' : ' '} ${l.name}`,
      keepOpen: true,
      onClick: () => {
        toggleItemLabel(key, l.id);
        openItemMenu(key, x, y);
      }
    });
  });
  if (labels.length) entries.push('sep');
  entries.push({ label: '＋ New label…', onClick: () => promptLabelName('New label', '', (name) => createLabel(name, key)) });
  entries.push('sep');
  entries.push({ label: 'Delete from Saved for later…', danger: true, onClick: () => confirmDeleteItem(key) });
  openContextMenu(entries, x, y);
}

// Deleting goes through Amazon's own "Delete" control, so it's permanent
// and outside undo/redo — hence the confirmation.
function confirmDeleteItem(key) {
  const item = itemsByKey.get(key);
  const text = document.createElement('p');
  text.textContent = `Delete “${(item && item.title) || key}” from your Saved for later list on Amazon? This can't be undone.`;
  openDialog('Delete item', [text], [
    { label: 'Cancel' },
    { label: 'Delete', danger: true, onClick: () => { deleteSavedItem(key); } }
  ]);
}

async function deleteSavedItem(key) {
  if (!activeTabId || deletingKey || applyInProgress) return;
  deletingKey = key;
  setStatus('Deleting…');
  try {
    const res = await sendToTab(activeTabId, { type: 'SFL_DELETE_ITEM', key });
    if (res && res.ok) {
      setStatus('');
    } else {
      setStatus(res && res.error ? res.error : 'Could not delete that item.', true);
    }
  } catch (err) {
    setStatus(`Could not reach the page: ${err.message}`, true);
  }
  deletingKey = null;
  await loadItems();
}

function onLabelFilterChange(select) {
  if (select.value === EDIT_LABELS_OPTION) {
    select.value = labelFilter;
    openLabelEditor();
    return;
  }
  setLabelFilter(select.value);
}

// ---- Dialogs ----

function closeDialog() {
  // Blur first so a field edited in place (e.g. a label name in the editor)
  // fires its change handler before the dialog's content goes away.
  if ($('dialog').contains(document.activeElement)) document.activeElement.blur();
  $('dialog').classList.remove('show');
  $('dialogBackdrop').classList.remove('show');
  document.body.classList.remove('dialog-open');
}

let dialogOnDismiss = null;

// Closes the dialog without picking any of its actions (✕, backdrop click,
// Escape, controls being disabled), running its onDismiss afterwards.
function dismissDialog() {
  if (!$('dialog').classList.contains('show')) return;
  const onDismiss = dialogOnDismiss;
  dialogOnDismiss = null;
  closeDialog();
  if (onDismiss) onDismiss();
}

// actions: [{ label, primary, danger, onClick }] — onClick returning false
// keeps the dialog open (e.g. for validation). `closable` adds a ✕ in the
// header for dialogs that are browsed rather than answered. `onDismiss` runs
// when the dialog is closed without one of its actions (see dismissDialog).
function openDialog(title, bodyNodes, actions, { closable = false, onDismiss = null } = {}) {
  closeContextMenu();
  dialogOnDismiss = onDismiss;
  $('dialogTitle').textContent = title;
  $('dialogCloseBtn').style.display = closable ? '' : 'none';
  $('dialogBody').replaceChildren(...bodyNodes);
  const actionsEl = $('dialogActions');
  actionsEl.innerHTML = '';
  actions.forEach((action) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    if (action.primary) btn.classList.add('primary');
    if (action.danger) btn.classList.add('danger');
    btn.addEventListener('click', () => {
      if (action.onClick && action.onClick() === false) return;
      closeDialog();
    });
    actionsEl.appendChild(btn);
  });
  document.body.classList.add('dialog-open');
  $('dialogBackdrop').classList.add('show');
  $('dialog').classList.add('show');
}

function promptLabelName(title, initial, onSave) {
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = LABEL_NAME_MAX;
  input.placeholder = 'e.g. Grocery, Recurring, Electronics';
  input.value = initial;
  const submit = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return false; }
    onSave(name);
    return true;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && submit()) closeDialog();
  });
  openDialog(title, [input], [
    { label: 'Cancel' },
    { label: 'Save', primary: true, onClick: submit }
  ]);
  input.focus();
  input.select();
}

const TRASH_ICON_PATH = 'M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H16V19H8V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z'; // "delete-outline" from Material Design Icons (@mdi/svg 7.4.47, Apache-2.0)

// Lists every label with a color swatch (click to pick from the palette),
// its name editable in place (applied on Enter or when the field loses
// focus), its item count, and a delete button that goes through confirmDeleteLabel and then
// comes back here. Rows can be dragged by their ⠿ handle to reorder labels.
function openLabelEditor() {
  closeContextMenu();
  // Also re-entered mid-session (after a reorder or a delete), which keeps
  // the original starting point.
  if (!labelEditBefore) labelEditBefore = snapshotState();
  const list = document.createElement('div');
  list.className = 'label-editor';
  if (!labels.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No labels yet. Right-click an item or use “＋ Label” to create one.';
    list.appendChild(empty);
  }
  labels.forEach((label) => {
    const row = document.createElement('div');
    row.className = 'label-editor-row';
    row.dataset.id = label.id;
    attachLabelRowDrag(row, list);

    const handle = document.createElement('span');
    handle.className = 'label-editor-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to reorder';
    // Rows are only draggable while grabbed by the handle, so dragging in
    // the name field still selects text as usual.
    handle.addEventListener('mousedown', () => { row.draggable = true; });
    row.addEventListener('mouseup', () => { row.draggable = false; });

    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = `label-swatch label-c${label.color}`;
    swatch.title = 'Change color';
    swatch.setAttribute('aria-label', `Change color of “${label.name}”`);
    swatch.setAttribute('aria-expanded', 'false');
    swatch.addEventListener('click', () => toggleLabelPalette(row, label, swatch));

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = LABEL_NAME_MAX;
    input.value = label.name;
    input.setAttribute('aria-label', `Name of label “${label.name}”`);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    input.addEventListener('change', () => {
      const name = input.value.trim();
      if (!name || name === label.name) { input.value = label.name; return; }
      renameLabel(label.id, name);
    });

    const count = document.createElement('span');
    count.className = 'label-editor-count';
    const n = labelCount(label.id);
    count.textContent = `${n} item${n === 1 ? '' : 's'}`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'label-editor-delete';
    del.title = `Delete “${label.name}”`;
    del.setAttribute('aria-label', `Delete “${label.name}”`);
    del.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${TRASH_ICON_PATH}"/></svg>`;
    del.addEventListener('click', () => confirmDeleteLabel(label.id, openLabelEditor));

    row.append(handle, swatch, input, count, del);
    list.appendChild(row);
  });
  openDialog('Edit labels', [list], [{
    label: 'Done',
    primary: true,
    onClick: () => {
      // Apply a name still being typed before saving.
      if (list.contains(document.activeElement)) document.activeElement.blur();
      finishLabelEdit();
    }
  }], { closable: true, onDismiss: discardLabelEdit });
}

// Opens (or closes) the color palette right below a label editor row. Only
// one palette is open at a time; picking a color updates the swatch in place
// rather than re-rendering the editor, so focus and scroll stay put.
function toggleLabelPalette(row, label, swatch) {
  const list = row.parentElement;
  const open = list.querySelector('.label-palette');
  const wasThisRow = open && open.previousElementSibling === row;
  if (open) {
    open.remove();
    list.querySelectorAll('.label-swatch').forEach((s) => s.setAttribute('aria-expanded', 'false'));
  }
  if (wasThisRow) return;
  const palette = document.createElement('div');
  palette.className = 'label-palette';
  palette.setAttribute('role', 'radiogroup');
  palette.setAttribute('aria-label', `Color of “${label.name}”`);
  for (let c = 0; c < LABEL_COLORS; c++) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = `label-palette-opt label-c${c}`;
    opt.setAttribute('role', 'radio');
    opt.setAttribute('aria-checked', String(c === label.color));
    opt.setAttribute('aria-label', `Color ${c + 1}`);
    opt.textContent = 'Aa';
    opt.addEventListener('click', () => {
      setLabelColor(label.id, c);
      swatch.className = `label-swatch label-c${c}`;
      swatch.setAttribute('aria-expanded', 'false');
      palette.remove();
      swatch.focus();
    });
    palette.appendChild(opt);
  }
  row.after(palette);
  swatch.setAttribute('aria-expanded', 'true');
}

function attachLabelRowDrag(row, list) {
  const clear = () => list.querySelectorAll('.label-editor-row').forEach((r) => {
    r.classList.remove('drag-over-before', 'drag-over-after');
  });
  row.addEventListener('dragstart', (e) => {
    list.dataset.dragging = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('drag-source');
  });
  row.addEventListener('dragend', () => {
    row.draggable = false;
    row.classList.remove('drag-source');
    delete list.dataset.dragging;
    clear();
  });
  row.addEventListener('dragover', (e) => {
    if (!list.dataset.dragging) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    clear();
    row.classList.add(before ? 'drag-over-before' : 'drag-over-after');
    row.dataset.dropPosition = before ? 'before' : 'after';
  });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = list.dataset.dragging;
    clear();
    if (!id) return;
    moveLabel(id, row.dataset.id, row.dataset.dropPosition || 'before');
    openLabelEditor();
  });
}

// onDone: when given (e.g. from the label editor), called after Cancel or
// Delete instead of just closing, so the user lands back where they were.
function confirmDeleteLabel(id, onDone) {
  const label = getLabel(id);
  if (!label) return;
  const count = labelCount(id);
  const others = labels.filter((l) => l.id !== id);
  const text = document.createElement('p');
  const body = [text];
  let select = null;
  if (count === 0) {
    text.textContent = `Delete the label “${label.name}”? No items have it.`;
  } else {
    text.textContent = `${count} item${count === 1 ? ' has' : 's have'} the label “${label.name}”. Their positions won't change.`;
    if (others.length) {
      select = document.createElement('select');
      const keep = document.createElement('option');
      keep.value = '';
      keep.textContent = 'Just remove the label from them';
      select.appendChild(keep);
      others.forEach((l) => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = `Move them to “${l.name}”`;
        select.appendChild(opt);
      });
      body.push(select);
    }
  }
  // Returning false keeps the dialog open, since onDone re-fills it.
  const finish = () => (onDone ? (onDone(), false) : true);
  // Dismissing it from the editor counts as Cancel and goes back there.
  openDialog('Delete label', body, [
    { label: 'Cancel', onClick: finish },
    { label: 'Delete', danger: true, onClick: () => { deleteLabel(id, select ? select.value : null); return finish(); } }
  ], { onDismiss: onDone });
}

// Saves the current manual arrangement in the content script's memory so
// it survives the popup being closed (Chrome throws away all popup JS
// state on close). Deliberately NOT chrome.storage: that would survive
// page reloads/navigation/tab close too, and a stale reorder silently
// reapplying itself after the user has navigated away and back (or the
// page reloaded) would be surprising. Keeping it in the content script's
// memory means it's naturally wiped whenever that script is torn down —
// i.e. exactly when the page is closed, reloaded, or navigated away from.
function persistOrder() {
  if (!activeTabId) return;
  const isCustom = !arraysEqual(order, naturalOrder);
  sendToTab(activeTabId, { type: 'SFL_SET_PENDING_ORDER', order: isCustom ? order : null }).catch(() => {});
  updateResetButton();
  scheduleApplyEstimate();
}

// Debounced pre-apply estimate: after any reorder change, ask the content
// script how many bumps the current arrangement would take and shows it
// under "Apply order" — before the user has even clicked it — so they know
// roughly what they're committing to. Only runs while idle (not mid-apply).
function scheduleApplyEstimate() {
  if (estimateDebounceHandle) clearTimeout(estimateDebounceHandle);
  estimateDebounceHandle = setTimeout(refreshApplyEstimate, 250);
}

async function refreshApplyEstimate() {
  if (applyInProgress || !activeTabId) return;
  if (order.length === 0 || arraysEqual(order, naturalOrder)) {
    setApplyBtnSub('');
    return;
  }
  const seq = ++estimateRequestSeq;
  let res;
  try {
    res = await sendToTab(activeTabId, { type: 'SFL_ESTIMATE_ORDER', order });
  } catch (err) {
    return;
  }
  // Bail if a newer request has since been kicked off, or an apply started
  // while this one was in flight — stale results shouldn't clobber the UI.
  if (seq !== estimateRequestSeq || applyInProgress) return;
  const eta = formatEta(res && res.estimatedMs);
  setApplyBtnSub(eta ? `~${eta} to apply` : '');
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function updateResetButton() {
  const isNatural = arraysEqual(order, naturalOrder);
  $('resetBtn').disabled = isNatural;
  $('resetBtnModal').disabled = isNatural;
}

// Nothing to apply if there are no items, or the current arrangement
// already matches what's on the page.
function updateApplyButton() {
  if (applyInProgress) return;
  const disabled = order.length === 0 || arraysEqual(order, naturalOrder);
  $('applyBtn').disabled = disabled;
  $('applyBtnModal').disabled = disabled;
}

// Reverts to the order items actually appear in on the Amazon page,
// discarding any pending manual arrangement.
function resetOrder() {
  const before = snapshotState();
  order = naturalOrder.slice();
  recordChange(before);
  if (activeTabId) {
    sendToTab(activeTabId, { type: 'SFL_SET_PENDING_ORDER', order: null }).catch(() => {});
  }
  renderList();
  updateResetButton();
  updateApplyButton();
  setApplyBtnSub('');
}

async function applyPendingOrder(tabId) {
  let res;
  try {
    res = await sendToTab(tabId, { type: 'SFL_GET_PENDING_ORDER' });
  } catch (err) {
    return;
  }
  const pending = res && res.order;
  if (Array.isArray(pending) && pending.length) {
    const liveSet = new Set(order);
    const pendingFiltered = pending.filter((k) => liveSet.has(k));
    const pendingSet = new Set(pendingFiltered);
    const remaining = order.filter((k) => !pendingSet.has(k));
    order = pendingFiltered.concat(remaining);
  }
}

// Native HTML5 drag-and-drop suppresses normal wheel/trackpad scrolling on
// the container while a drag is in progress, so a drag started near the top
// or bottom of a scrollable list would otherwise strand the user unable to
// reach items further down. This nudges the container's scrollTop while the
// dragged pointer hovers near an edge, standing in for the scroll the OS
// would normally allow.
function autoScrollContainerOnDragover(container, clientY) {
  const rect = container.getBoundingClientRect();
  const edge = 32;
  const maxSpeed = 14;
  const distFromTop = clientY - rect.top;
  const distFromBottom = rect.bottom - clientY;
  if (distFromTop < edge) {
    container.scrollTop -= maxSpeed * (1 - Math.max(distFromTop, 0) / edge);
  } else if (distFromBottom < edge) {
    container.scrollTop += maxSpeed * (1 - Math.max(distFromBottom, 0) / edge);
  }
}

// ---- Multi-select (Shift+click) ----

function setupSelectable(li, key) {
  if (selectedKeys.has(key)) li.classList.add('selected');
  li.addEventListener('click', (e) => {
    if (e.target.closest('input, button')) return;
    if (e.shiftKey) toggleSelected(key);
    else if (selectedKeys.size) clearSelection();
  });
}

function toggleSelected(key) {
  if (selectedKeys.has(key)) selectedKeys.delete(key);
  else selectedKeys.add(key);
  renderSelection();
}

function clearSelection() {
  if (!selectedKeys.size) return;
  selectedKeys.clear();
  renderSelection();
}

// Updates highlight classes in both views without a full re-render.
function renderSelection() {
  document.querySelectorAll('#list li[data-key], #tileGrid li[data-key]').forEach((li) => {
    li.classList.toggle('selected', selectedKeys.has(li.dataset.key));
  });
}

// The keys a drag starting on `key` should move: the whole selection (in
// current top-to-bottom order) if `key` is part of a multi-selection,
// otherwise just `key`.
function keysToDrag(key) {
  if (!selectedKeys.has(key) || selectedKeys.size < 2) return [key];
  return order.filter((k) => selectedKeys.has(k));
}

// Moves `keys` (already in their relative order) to sit as one contiguous
// block before/after `targetKey`. If the target is itself one of the moving
// keys, the block closes up at the target's current spot. Returns false if
// nothing changed.
function moveKeysTo(keys, targetKey, position) {
  const moving = new Set(keys);
  const targetIdx = order.indexOf(targetKey);
  if (targetIdx === -1) return false;
  let insertAt = order.slice(0, targetIdx).filter((k) => !moving.has(k)).length;
  if (position === 'after' && !moving.has(targetKey)) insertAt += 1;
  const rest = order.filter((k) => !moving.has(k));
  rest.splice(insertAt, 0, ...keys);
  if (arraysEqual(rest, order)) return false;
  order = rest;
  return true;
}

// Replaces the browser's default drag ghost (just the grabbed row) with a
// small "Moving N items" pill so it's clear the whole selection is coming.
function setMultiDragImage(e, count) {
  const ghost = $('dragGhost');
  ghost.textContent = `Moving ${count} items`;
  e.dataTransfer.setDragImage(ghost, 12, 12);
}

// Shared drag-to-reorder wiring for both the plain list and the tile grid.
// `axis` picks whether the before/after split (and therefore the drop-line
// indicator) is judged along the vertical or horizontal midpoint of the
// hovered item — vertical for stacked rows, horizontal for a left-to-right
// grid flow.
function attachReorderDragHandlers(container, itemSelector, axis) {
  let dragSourceKey = null;
  let dropTargetKey = null;
  let dropPosition = 'before';
  let cancelled = false;
  // Chrome only fires 'dragover' a few times a second, so driving autoscroll
  // off that event alone feels laggy. Instead we stash the latest pointer
  // position from whatever dragover events do arrive and re-apply the scroll
  // nudge every animation frame, decoupling scroll smoothness from the
  // native event cadence.
  let lastClientY = null;
  let rafHandle = null;

  function clearIndicators() {
    container.querySelectorAll(itemSelector).forEach((el) => {
      el.classList.remove('drag-over-before', 'drag-over-after');
    });
  }

  function autoScrollTick() {
    if (lastClientY !== null) autoScrollContainerOnDragover(container, lastClientY);
    rafHandle = requestAnimationFrame(autoScrollTick);
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    cancelled = true;
    clearIndicators();
  }

  container.querySelectorAll(itemSelector).forEach((item) => {
    item.addEventListener('dragstart', (e) => {
      dragSourceKey = item.dataset.key;
      dropTargetKey = null;
      cancelled = false;
      item.classList.add('drag-source');
      // Dragging a selected item carries the whole selection along.
      const moving = keysToDrag(dragSourceKey);
      if (moving.length > 1) {
        container.querySelectorAll(itemSelector).forEach((el) => {
          if (selectedKeys.has(el.dataset.key)) el.classList.add('drag-source');
        });
        setMultiDragImage(e, moving.length);
      }
      document.addEventListener('keydown', onKeyDown);
      rafHandle = requestAnimationFrame(autoScrollTick);
    });
    item.addEventListener('dragend', () => {
      container.querySelectorAll('.drag-source').forEach((el) => el.classList.remove('drag-source'));
      clearIndicators();
      dragSourceKey = null;
      lastClientY = null;
      document.removeEventListener('keydown', onKeyDown);
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      rafHandle = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      lastClientY = e.clientY;
      if (cancelled) return;
      const rect = item.getBoundingClientRect();
      const before = axis === 'x'
        ? (e.clientX - rect.left) < rect.width / 2
        : (e.clientY - rect.top) < rect.height / 2;
      dropTargetKey = item.dataset.key;
      dropPosition = before ? 'before' : 'after';
      clearIndicators();
      item.classList.add(before ? 'drag-over-before' : 'drag-over-after');
    });
    item.addEventListener('dragleave', () => {
      if (dropTargetKey === item.dataset.key) item.classList.remove('drag-over-before', 'drag-over-after');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      clearIndicators();
      if (cancelled || !dragSourceKey || !dropTargetKey) return;
      const moving = keysToDrag(dragSourceKey);
      if (moving.length === 1 && dragSourceKey === dropTargetKey) return;
      const before = snapshotState();
      if (!moveKeysTo(moving, dropTargetKey, dropPosition)) return;
      recordChange(before);
      renderList();
      updateApplyButton();
      persistOrder();
    });
  });
}

function attachDragHandlers() {
  attachReorderDragHandlers($('list'), 'li', 'y');
}

function setMsg(text, isWarning, isLoading) {
  const el = $('msg');
  el.textContent = text;
  el.classList.toggle('warning', !!isWarning);
  el.classList.toggle('loading', !!isLoading);

  // The grid modal covers the whole popup, hiding #msg behind it — mirror
  // the text into its own footer so status is still visible while open.
  const modalEl = $('modalMsg');
  modalEl.textContent = text;
  modalEl.classList.toggle('warning', !!isWarning);
  modalEl.classList.toggle('loading', !!isLoading);
}

function setStatus(text, isError) {
  const el = $('status');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

// Quiet space at the bottom of the popup for secondary messaging (tips,
// announcements) that shouldn't compete with #msg/#status for attention.
function setFooterMsg(text) {
  $('popupFooter').textContent = text || '';
}

function setApplyBtnSub(text) {
  $('applyBtnSub').textContent = text || '';
  $('applyBtnModalSub').textContent = text || '';
}

function setIncompleteBanner(show) {
  $('incompleteBanner').style.display = show ? 'flex' : 'none';
  $('modalIncompleteBanner').style.display = show ? 'flex' : 'none';
}

function setLoadAllDisabled(disabled) {
  $('loadAllBtnInline').disabled = disabled;
  $('loadAllBtnModal').disabled = disabled;
}

// Merge a fresh snapshot from the page into our local order/metadata rather
// than blindly replacing it: newly-discovered items (from Amazon lazy-
// loading more as you scroll) are appended to the end, items no longer on
// the page are dropped, and the relative order of items we already know
// about — including any manual drag-reordering — is left untouched.
function mergeItems(items) {
  const liveKeys = items.map((i) => i.key);
  const liveSet = new Set(liveKeys);
  items.forEach((i) => itemsByKey.set(i.key, i));

  order = order.filter((k) => liveSet.has(k));
  selectedKeys.forEach((k) => { if (!liveSet.has(k)) selectedKeys.delete(k); });
  const knownSet = new Set(order);
  const newKeys = liveKeys.filter((k) => !knownSet.has(k));
  order = order.concat(newKeys);

  naturalOrder = naturalOrder.filter((k) => liveSet.has(k)).concat(newKeys);

  return newKeys.length;
}

// Runs continuously while the popup is open (started as soon as we confirm
// we're on a cart tab with a saved-for-later section), polling for a quick
// snapshot of whatever Amazon currently has rendered. This picks up items
// that show up from the user's own manual scrolling, not just from the
// "Load all items" button.
function startWatching(tabId) {
  stopWatching();
  watchHandle = setInterval(async () => {
    if (applyInProgress) return;

    let snap;
    try {
      snap = await sendToTab(tabId, { type: 'SFL_GET_ITEMS', skipScroll: true });
    } catch (err) {
      stopWatching();
      return;
    }

    const items = (snap && snap.items) || [];
    if (items.length === 0) return;

    const added = mergeItems(items);
    if (added > 0) {
      renderList();
      updateResetButton();
    }

    if (loadingAll) {
      setMsg(`Scrolling to load all saved items… ${order.length} found so far.`, false, true);
    } else {
      setMsg(`${order.length} saved item(s). Drag or type a position number to reorder, right-click to label, then Apply.`);
      setIncompleteBanner(!!(snap && snap.mayBeIncomplete));
    }
    updateApplyButton();
  }, 1200);
}

function stopWatching() {
  if (watchHandle) {
    clearInterval(watchHandle);
    watchHandle = null;
  }
}

// Polls the content script's live auto-scroll progress (SFL_GET_LOAD_STATUS)
// while "Load all items" is running, so the message shows a growing count
// instead of one static string for the whole scroll. Returns a function
// that stops the polling.
function pollLoadAllStatus(tabId) {
  const handle = setInterval(async () => {
    let res;
    try {
      res = await sendToTab(tabId, { type: 'SFL_GET_LOAD_STATUS' });
    } catch (err) {
      clearInterval(handle);
      return;
    }
    const ls = res && res.loadStatus;
    if (!ls || !ls.loading) return;
    setMsg(`Scrolling through the page to load all saved items… ${ls.foundCount} found so far.`, false, true);
  }, 400);
  return () => clearInterval(handle);
}

// skipScroll=true (default, used on popup open / Refresh): quick scan of
// whatever Amazon has already rendered, no page scrolling.
// skipScroll=false (used by the "Load all items" button): scrolls the page
// to force Amazon to lazy-load every saved item first.
// Amazon's cart page can still be loading (or still rendering the "Saved
// for later" section via JS after DOMContentLoaded) at the moment the
// popup happens to open, which used to just show an empty "no items
// found" message. Retry a few times with a short delay whenever the page
// still looks like a cart page but hasn't produced a saved-items section
// yet, instead of giving up on the first check.
const PING_RETRY_MAX = 6;
const PING_RETRY_DELAY_MS = 800;

async function fetchItems(skipScroll, checkForInProgressApply = false, retryCount = 0) {
  setIncompleteBanner(false);
  setMsg(skipScroll ? 'Loading items from the page…' : 'Scrolling through the page to load all saved items…', false, !skipScroll);
  $('applyBtn').disabled = true;
  setLoadAllDisabled(true);

  const tab = await getActiveTab();
  if (!tab) {
    setMsg('No active tab found.');
    setLoadAllDisabled(false);
    return;
  }
  activeTabId = tab.id;

  let ping;
  try {
    ping = await sendToTab(tab.id, { type: 'SFL_PING' });
  } catch (err) {
    setMsg('Open your Amazon cart page (with "Saved for later" items) in this tab, then reopen this popup.');
    setLoadAllDisabled(false);
    return;
  }

  if (!ping || !ping.hasSavedItems) {
    if (ping && ping.isCartPage && retryCount < PING_RETRY_MAX) {
      setMsg('Cart page is still loading… retrying', false, true);
      setTimeout(() => fetchItems(skipScroll, checkForInProgressApply, retryCount + 1), PING_RETRY_DELAY_MS);
      return;
    }
    setMsg('No "Saved for later" section found on this page. Scroll to it or reload, then hit Refresh.');
    setLoadAllDisabled(false);
    return;
  }

  // Keep (or start) the live background watcher going regardless of which
  // button triggered this — it's what picks up items from manual scrolling.
  startWatching(tab.id);
  loadingAll = !skipScroll;

  // While Amazon is being scrolled to force-load every item, poll the
  // content script's live scroll progress so the message updates in real
  // time instead of sitting on a single static "Scrolling…" string for
  // however long the scroll takes.
  const stopLoadStatusPoll = skipScroll ? null : pollLoadAllStatus(tab.id);

  let res;
  try {
    res = await sendToTab(tab.id, { type: 'SFL_GET_ITEMS', skipScroll });
  } catch (err) {
    setMsg(`Could not reach the page: ${err.message}`, true);
    loadingAll = false;
    if (stopLoadStatusPoll) stopLoadStatusPoll();
    setLoadAllDisabled(false);
    return;
  }
  loadingAll = false;
  if (stopLoadStatusPoll) stopLoadStatusPoll();

  const items = (res && res.items) || [];
  mergeItems(items);
  await applyPendingOrder(tab.id);
  fetchCartItems();

  setLoadAllDisabled(false);

  if (order.length === 0) {
    setMsg('No saved items found.');
    return;
  }

  setMsg(`${order.length} saved item(s). Drag or type a position number to reorder, right-click to label, then Apply.`);
  setIncompleteBanner(!!(res && res.mayBeIncomplete));
  renderList();
  updateResetButton();
  updateApplyButton();
  scheduleApplyEstimate();

  // In case a reorder from a previous popup session is still running.
  // Only relevant right after the popup opens — not after we've already
  // just processed a completed apply ourselves, since content.js's status
  // stays at done:true until the next apply starts and would otherwise
  // make us re-detect the same "completed" apply forever.
  if (checkForInProgressApply) pollStatus();
}

function loadItems(checkForInProgressApply = false) {
  return fetchItems(true, checkForInProgressApply);
}

function loadAllItems() {
  return fetchItems(false);
}

// Disables (or restores) every popup control while a reorder is being
// applied — the list, settings, load-all — since the page's DOM and item
// keys are shifting under bumpItem and none of those actions are safe to
// trigger mid-apply. Apply's own button is handled separately since it also
// carries the live countdown text. refreshBtn is left alone here — it turns
// into a Cancel button instead (see setRefreshBtnMode) and stays enabled.
function setControlsDisabled(disabled) {
  $('settingsBtn').disabled = disabled;
  $('settingsBtnModal').disabled = disabled;
  $('gridViewBtn').disabled = disabled;
  ['addLabelBtn', 'addLabelBtnModal', 'labelFilter', 'labelFilterModal', 'inBetweenBtn', 'inBetweenBtnModal']
    .forEach((id) => { $(id).disabled = disabled; });
  if (disabled) { closeContextMenu(); dismissDialog(); }
  $('loadAllBtnInline').disabled = disabled;
  $('loadAllBtnModal').disabled = disabled;
  $('list').classList.toggle('disabled', disabled);
  $('tileGrid').classList.toggle('disabled', disabled);
  $('tableViewBtn').disabled = disabled;
  document.querySelectorAll('.tileSizeBtn').forEach((btn) => { btn.disabled = disabled; });
  if (disabled) {
    $('resetBtn').disabled = true;
    $('resetBtnModal').disabled = true;
  } else {
    updateResetButton();
  }
  updateHistoryButtons();
}

// Swaps refreshBtn between its normal "Refresh" behavior and a "Cancel"
// button that halts an in-progress reorder.
function setRefreshBtnMode(cancelling) {
  const btn = $('refreshBtn');
  btn.textContent = cancelling ? 'Cancel' : 'Refresh';
  btn.title = cancelling ? 'Stop the in-progress reorder' : 'Quickly rescan without scrolling';
  btn.classList.toggle('cancel', cancelling);
  btn.disabled = false;
}

let cancelRequested = false;

async function cancelApply() {
  if (!activeTabId || cancelRequested) return;
  cancelRequested = true;
  setRefreshBtnMode(true);
  $('refreshBtn').disabled = true;
  setStatus('Cancelling…');
  try {
    await sendToTab(activeTabId, { type: 'SFL_CANCEL_APPLY' });
  } catch (err) {
    // Ignore — the status poll will surface any real connection loss.
  }
}

async function applyOrder() {
  if (!activeTabId) return;
  applyInProgress = true;
  cancelRequested = false;
  $('applyBtn').disabled = true;
  $('applyBtnModal').disabled = true;
  setControlsDisabled(true);
  setRefreshBtnMode(true);
  setStatus('Starting…');
  try {
    await sendToTab(activeTabId, { type: 'SFL_APPLY_ORDER', order });
  } catch (err) {
    setStatus(`Could not reach the page: ${err.message}`, true);
    setApplyBtnSub('');
    applyInProgress = false;
    updateApplyButton();
    setControlsDisabled(false);
    setRefreshBtnMode(false);
    return;
  }
  pollStatus();
}

// Formats a rough ETA (content.js's estimatedRemainingMs — an
// approximation, not a measured value) into a short "1m 20s" / "45s" string.
function formatEta(ms) {
  if (!ms || ms <= 0) return null;
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function pollStatus() {
  if (statusPollHandle) clearInterval(statusPollHandle);
  statusPollHandle = setInterval(async () => {
    if (!activeTabId) return;
    let res;
    try {
      res = await sendToTab(activeTabId, { type: 'SFL_GET_STATUS' });
    } catch (err) {
      clearInterval(statusPollHandle);
      // Losing the connection while an apply was in progress almost always
      // means the page reloaded right after finishing (content.js only
      // reloads after a successful completion) — the poll can land on this
      // catch block instead of ever seeing the final s.done tick, since the
      // reload can sever the connection before the next 800ms poll fires.
      // Without this, the UI is left stuck showing the last "Reordering
      // N/N…" text with no further update. Treat it as done.
      if (applyInProgress) {
        applyInProgress = false;
        stopWatching();
        setStatus('Done! Page refreshed.');
        setApplyBtnSub('');
        order = [];
        naturalOrder = [];
        clearHistory();
        updateApplyButton();
        setControlsDisabled(false);
        setRefreshBtnMode(false);
        cancelRequested = false;
        // Give the reloaded page a moment to finish loading and re-inject
        // its content script before trying to reconnect.
        setTimeout(loadItems, 1500);
      }
      return;
    }
    const s = res && res.status;
    if (!s) return;
    if (s.running) {
      applyInProgress = true;
      setStatus(s.message || `Reordering ${s.current}/${s.total}…`);
      const eta = formatEta(s.estimatedRemainingMs);
      setApplyBtnSub(eta ? `~${eta} remaining` : (s.total ? `${s.current}/${s.total}` : ''));
      $('applyBtn').disabled = true;
      $('applyBtnModal').disabled = true;
      setControlsDisabled(true);
      setRefreshBtnMode(true);
      $('refreshBtn').disabled = cancelRequested;
    } else if (s.error) {
      applyInProgress = false;
      setStatus(s.message, true);
      setApplyBtnSub('');
      updateApplyButton();
      setControlsDisabled(false);
      setRefreshBtnMode(false);
      cancelRequested = false;
      clearInterval(statusPollHandle);
    } else if (s.done) {
      applyInProgress = false;
      stopWatching();
      setStatus(s.message);
      setApplyBtnSub('');
      setControlsDisabled(false);
      setRefreshBtnMode(false);
      cancelRequested = false;
      clearInterval(statusPollHandle);
      // mergeItems only filters/appends onto the existing order/naturalOrder
      // arrays (so incremental lazy-load scans don't churn existing
      // ordering) — but that's wrong right after an apply, since the page's
      // real order just changed and naturalOrder would otherwise be left
      // pointing at the stale pre-apply arrangement. Clear both so the next
      // scan rebuilds them fresh from the page's actual new order, keeping
      // order/naturalOrder in sync (avoids a stale nonzero apply estimate).
      order = [];
      naturalOrder = [];
      clearHistory();
      // The content script already cleared its pending order as soon as
      // SFL_APPLY_ORDER was sent — the applied order is now the page's
      // real order.
      loadItems();
    }
  }, 800);
}

function loadSettings(onLoaded) {
  chrome.storage.local.get(STORAGE_KEY, (res) => {
    const s = { ...DEFAULTS, ...(res[STORAGE_KEY] || {}) };
    seenUpdatedAt.settings = s.updatedAt;
    $('delay').value = s.bumpDelayMs;
    $('reloadAfterApply').checked = s.reloadAfterApply;
    $('defaultView').value = s.defaultView === 'grid' ? 'grid' : 'popup';
    defaultView = s.defaultView === 'grid' ? 'grid' : 'popup';
    $('closeGridBtn').title = defaultView === 'grid' ? 'Close popup' : 'Close grid view';
    $('titleLinksEnabled').checked = s.titleLinksEnabled;
    titleLinksEnabled = s.titleLinksEnabled;
    applyTileSize(TILE_SIZES[s.tileSize] ? s.tileSize : DEFAULTS.tileSize, false);
    setTableView(!!s.tableView, false);
    if (onLoaded) onLoaded(s);
  });
}

function saveSettings() {
  titleLinksEnabled = $('titleLinksEnabled').checked;
  const s = {
    bumpDelayMs: Number($('delay').value) || DEFAULTS.bumpDelayMs,
    reloadAfterApply: $('reloadAfterApply').checked,
    tileSize,
    defaultView: $('defaultView').value === 'grid' ? 'grid' : 'popup',
    titleLinksEnabled,
    tableView,
    updatedAt: Date.now()
  };
  seenUpdatedAt.settings = s.updatedAt;
  chrome.storage.local.set({ [STORAGE_KEY]: s });
  // Only switch views when the Default view setting itself changed — every
  // other save (zoom, table view, delay…) must leave the current view alone,
  // or e.g. toggling table view inside the grid would drop back to compact.
  const defaultViewChanged = s.defaultView !== defaultView;
  defaultView = s.defaultView;
  $('closeGridBtn').title = defaultView === 'grid' ? 'Close popup' : 'Close grid view';
  if (defaultViewChanged) setGridMode(defaultView === 'grid');
  renderList();
  renderCartList();
}

function toggleSettingsPanel(forceOpen) {
  const panel = $('settingsPanel');
  const backdrop = $('settingsBackdrop');
  const opening = forceOpen !== undefined ? forceOpen : !panel.classList.contains('show');
  panel.classList.toggle('show', opening);
  backdrop.classList.toggle('show', opening);
}

// ---- Sync (see storage.js) ----
// The popup flips the per-computer switch, settles a conflict when turning
// it on, and offers Sync now / Delete synced data; background.js does the
// actual copying.

function setSyncEnabled(enabled) {
  $('syncEnabled').checked = enabled;
  $('syncNowBtn').disabled = !enabled;
  // enabledAt: synced data deleted before this point doesn't turn it back off.
  chrome.storage.local.set({ [SYNC_FLAG_KEY]: enabled ? { enabled, enabledAt: Date.now() } : { enabled } });
  if (!enabled) chrome.storage.local.remove(SYNC_STATUS_KEY);
  renderSyncStatus(null);
}

// status: { error, at, notice } as recorded by background.js, or
// { notice: 'deletedHere' } right after deleting from this popup.
function renderSyncStatus(status) {
  const el = $('syncStatus');
  el.classList.remove('sync-error');
  el.textContent = '';
  if (!status) return;
  if (status.notice === 'deleted') {
    el.textContent = 'Your synced data was deleted from another computer, so sync was turned off here. Everything is still saved on this computer.';
  } else if (status.notice === 'deletedHere') {
    el.textContent = 'Synced data deleted. Everything is still saved on this computer.';
  } else if (status.error) {
    let reason = 'Chrome sync rejected the last update';
    if (/QUOTA_BYTES/.test(status.error)) reason = 'Your labels are too large for Chrome sync (100 KB limit)';
    else if (/WRITE_OPERATIONS/.test(status.error)) reason = 'Too many changes in a short time — try Sync now in a minute';
    el.textContent = `${reason}. Everything is still saved on this computer.`;
    el.classList.add('sync-error');
  } else if (status.at && $('syncEnabled').checked) {
    el.textContent = `Last synced ${new Date(status.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }
}

async function syncNow() {
  const btn = $('syncNowBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: 'SFL_SYNC_NOW' });
  } catch (e) {
    status = { error: String(e.message || e) };
  }
  btn.textContent = 'Sync now';
  btn.disabled = !$('syncEnabled').checked;
  renderSyncStatus(status);
}

// Sync is turned off here first so background.js doesn't upload this
// computer's copy straight back; the marker deleteSynced leaves turns it
// off on the other computers too.
function confirmDeleteSynced() {
  const text = document.createElement('p');
  text.textContent = 'This removes your settings and labels from your Chrome account and turns sync off on all your computers. ' +
    'Each computer keeps its own copy.';
  openDialog('Delete synced data', [text], [
    { label: 'Cancel' },
    {
      label: 'Delete',
      danger: true,
      onClick: async () => {
        setSyncEnabled(false);
        try {
          await deleteSynced();
          renderSyncStatus({ notice: 'deletedHere' });
        } catch (e) {
          renderSyncStatus({ error: String(e.message || e) });
        }
      }
    }
  ]);
}

// Turning sync on: if this computer and Chrome sync both have labels and
// they differ, ask which to keep (otherwise the more recently saved copy
// would silently replace the other). Settings just go by the newer copy.
async function onSyncToggle() {
  if (!$('syncEnabled').checked) { setSyncEnabled(false); return; }
  $('syncEnabled').checked = false; // until settled
  let remote;
  try {
    remote = await readSynced();
  } catch (e) {
    renderSyncStatus({ error: String(e.message || e) });
    return;
  }
  const items = {};
  labelsOf.forEach((ids, key) => { if (ids.size) items[key] = [...ids]; });
  const here = { labels, items };
  const synced = remote.labels;
  if (!synced || !synced.labels.length || !labels.length || sameLabelData(here, synced)) {
    setSyncEnabled(true);
    return;
  }
  const text = document.createElement('p');
  text.textContent = `Chrome sync already has labels from another computer (${synced.labels.length}), ` +
    `and they differ from this computer's (${labels.length}). Which should be kept on both?`;
  openDialog('Turn on sync', [text], [
    { label: 'Cancel' },
    {
      label: "This computer's",
      onClick: () => { saveLabels(); setSyncEnabled(true); } // a fresh save is the newer copy
    },
    {
      label: 'Synced',
      primary: true,
      onClick: () => {
        chrome.storage.local.set({ [LABELS_STORAGE_KEY]: synced }, () => {
          loadLabels().then(() => { commitLabelChange(); setSyncEnabled(true); });
        });
      }
    }
  ]);
}

function setupSync() {
  chrome.storage.local.get([SYNC_FLAG_KEY, SYNC_STATUS_KEY], (res) => {
    const enabled = !!(res[SYNC_FLAG_KEY] && res[SYNC_FLAG_KEY].enabled);
    $('syncEnabled').checked = enabled;
    $('syncNowBtn').disabled = !enabled;
    renderSyncStatus(res[SYNC_STATUS_KEY]);
    if (enabled) chrome.runtime.sendMessage({ type: 'SFL_SYNC_NOW' }).catch(() => {});
  });
  $('syncEnabled').addEventListener('change', onSyncToggle);
  $('syncNowBtn').addEventListener('click', syncNow);
  $('deleteSyncBtn').addEventListener('click', confirmDeleteSynced);
  // Pick up what background.js pulls in from sync while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // background.js turns sync off when the synced data was deleted elsewhere.
    if (changes[SYNC_FLAG_KEY]) {
      const enabled = !!(changes[SYNC_FLAG_KEY].newValue && changes[SYNC_FLAG_KEY].newValue.enabled);
      $('syncEnabled').checked = enabled;
      $('syncNowBtn').disabled = !enabled;
    }
    if (changes[SYNC_STATUS_KEY] && changes[SYNC_STATUS_KEY].newValue) renderSyncStatus(changes[SYNC_STATUS_KEY].newValue);
    const settings = changes[STORAGE_KEY] && changes[STORAGE_KEY].newValue;
    if (settings && settings.updatedAt !== seenUpdatedAt.settings) loadSettings();
    const saved = changes[LABELS_STORAGE_KEY] && changes[LABELS_STORAGE_KEY].newValue;
    // Not mid-edit: the label editor's session would be built on stale state.
    if (saved && saved.updatedAt !== seenUpdatedAt.labels && !labelEditBefore) loadLabels().then(renderList);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupSync();
  loadSettings((s) => {
    if (s.defaultView === 'grid') setGridMode(true);
  });
  loadLabels().then(renderList);
  loadItems(true);
  setFooterMsg('💡 Try Grid view for reordering long lists faster.');
  setupImagePreview();
  setupTooltips();

  $('refreshBtn').addEventListener('click', () => {
    if (applyInProgress) {
      cancelApply();
    } else {
      loadItems();
    }
  });
  $('loadAllBtnInline').addEventListener('click', loadAllItems);
  $('loadAllBtnModal').addEventListener('click', loadAllItems);
  $('gridViewBtn').addEventListener('click', () => setGridMode(true));
  $('closeGridBtn').addEventListener('click', () => {
    // With Extended set as the default view there's no plain popup to fall
    // back to, so closing the grid there closes the popup entirely instead.
    if (defaultView === 'grid') { window.close(); return; }
    setGridMode(false);
  });
  $('tableViewBtn').addEventListener('click', () => setTableView(!tableView));
  document.querySelectorAll('.tileSizeBtn').forEach((btn) => {
    btn.addEventListener('click', () => applyTileSize(btn.dataset.size));
  });
  $('applyBtn').addEventListener('click', applyOrder);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('undoBtnModal').addEventListener('click', undo);
  $('redoBtnModal').addEventListener('click', redo);
  // ⌘Z / Ctrl+Z undo; ⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y redo. Left alone while
  // typing in a field (where they mean text undo) or with a dialog open.
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.target.closest('input, select, textarea') || $('dialog').classList.contains('show')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });
  const mod = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';
  ['undoBtn', 'undoBtnModal'].forEach((id) => { $(id).title = `Undo (${mod}Z)`; });
  ['redoBtn', 'redoBtnModal'].forEach((id) => { $(id).title = mod === '⌘' ? 'Redo (⇧⌘Z)' : 'Redo (Ctrl+Y)'; });
  $('resetBtn').addEventListener('click', resetOrder);
  $('applyBtnModal').addEventListener('click', applyOrder);
  $('resetBtnModal').addEventListener('click', resetOrder);
  $('settingsBtn').addEventListener('click', () => toggleSettingsPanel());
  $('settingsBtnModal').addEventListener('click', () => toggleSettingsPanel());
  $('settingsBackdrop').addEventListener('click', () => toggleSettingsPanel(false));
  $('closeSettingsBtn').addEventListener('click', () => toggleSettingsPanel(false));
  const addLabel = () => promptLabelName('New label', '', (name) => createLabel(name));
  $('addLabelBtn').addEventListener('click', addLabel);
  $('addLabelBtnModal').addEventListener('click', addLabel);
  $('labelFilter').addEventListener('change', (e) => onLabelFilterChange(e.target));
  $('labelFilterModal').addEventListener('change', (e) => onLabelFilterChange(e.target));
  const toggleInBetween = () => { showInBetween = !showInBetween; renderList(); };
  $('inBetweenBtn').addEventListener('click', toggleInBetween);
  $('inBetweenBtnModal').addEventListener('click', toggleInBetween);
  $('dialogBackdrop').addEventListener('click', dismissDialog);
  $('dialogCloseBtn').addEventListener('click', dismissDialog);
  // A click elsewhere or Escape dismisses the context menu (as does its ✕).
  // Deliberately not scrolling: ticking a label re-renders the list, which
  // fires scroll events and would close the menu mid-way through labeling.
  document.addEventListener('mousedown', (e) => {
    if (!$('ctxMenu').contains(e.target)) closeContextMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlayOpen = $('ctxMenu').classList.contains('show') || $('dialog').classList.contains('show');
    closeContextMenu();
    dismissDialog();
    if (!overlayOpen) clearSelection();
  });
  $('delay').addEventListener('change', saveSettings);
  $('reloadAfterApply').addEventListener('change', saveSettings);
  $('defaultView').addEventListener('change', saveSettings);
  $('titleLinksEnabled').addEventListener('change', saveSettings);
});

window.addEventListener('unload', () => {
  stopWatching();
  if (statusPollHandle) clearInterval(statusPollHandle);
});
