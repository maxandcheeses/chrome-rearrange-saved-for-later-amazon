const STORAGE_KEY = 'sfl_settings';
const DEFAULTS = {
  bumpDelayMs: 600,
  reloadAfterApply: true,
  tileSize: 'm',
  defaultView: 'popup',
  titleLinksEnabled: true,
  tableView: false,
  theme: 'auto'
};

let order = []; // array of keys, top to bottom (may include manual reordering)
let naturalOrder = []; // array of keys in the order Amazon's page actually shows them
let itemsByKey = new Map();
let cartItems = []; // items currently in the cart, eligible to be saved for later
let savingCartKey = null; // key currently being moved from cart -> saved, if any
let deletingKey = null; // key currently being deleted from saved-for-later, if any
let addingToCartKey = null; // key currently being added to the cart, if any
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
let labels = []; // [{ id, name, color, target }] — target: made as a price-target label
let labelsOf = new Map(); // item key -> Set of label ids
// target id -> { key, labelId, min, max, applied, added, muted,
// dismissedPrice, rank, title, url, image, price, priceText } — see "Price
// targets". `key` is the item's; an item can have several targets.
let priceRules = new Map();
let labelFilter = 'all'; // 'all' | 'none' | label id
// While the label editor is open: the state from before it opened. Edits
// made in it show up live but aren't saved or recorded as undo steps until
// Done (one step for the whole session); dismissing the editor any other
// way restores this. Null when the editor isn't open.
let labelEditBefore = null;
// updatedAt of the settings/labels this popup last loaded or saved, to tell
// its own writes apart from ones that came in through sync while it's open.
const seenUpdatedAt = { settings: undefined, labels: undefined };
// Items picked with ⌘/Ctrl+click or Shift+click. Dragging any of them moves
// them all as one block (see moveKeysTo). Display-only state — never persisted.
let selectedKeys = new Set();
// The item Shift+click ranges extend from: the last item plain- or
// ⌘/Ctrl+clicked, as in Finder / Explorer.
let selectionAnchor = null;
const IS_MAC = /Mac/i.test(navigator.platform);
// "Show interposing items": while filtered, also show (dimmed) the
// non-matching items sitting between the first and last match, for context
// when reordering. Deliberately not persisted, and reset whenever the
// filter changes — it always starts off.
let showInBetween = false;
let activeTab = 'saved'; // 'saved' | 'targets' — see renderPriceTargets
// Price targets tab filter: 'all' | 'hit' | 'miss' | 'offpage' | 'muted' |
// 'label:<id>' (the target's own label) | 'item:<id>' (a general label on the target's item).
// Display-only and not persisted, like labelFilter.
let targetFilter = 'all';

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
      // Shift or ⌘/Ctrl+click selects the row (handled by the row's own
      // listener) rather than opening the product.
      if (e.shiftKey || isToggleClick(e)) { e.preventDefault(); return; }
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

    li.append(badge, handle, img, title, makeLabelChips(key, true));
    listEl.appendChild(li);
  });
  appendFilterEmptyNote(listEl);
  holdListHeight(listEl);
  attachDragHandlers();
  renderTileGrid();
  renderPriceTargets();
}

// The list sizes to its items, so filtering down to a few would shrink the
// popup. While filtered, it keeps the height it last had unfiltered.
let unfilteredListHeight = 0;
function rememberUnfilteredListHeight() {
  const listEl = $('list');
  // Hidden (e.g. on the Price targets tab) it measures 0, so keep the last.
  // clientHeight, not offsetHeight: min-height doesn't include the border.
  if (labelFilter === 'all' && listEl.offsetParent) unfilteredListHeight = listEl.clientHeight;
}

function holdListHeight(listEl) {
  if (labelFilter === 'all') {
    listEl.style.minHeight = '';
    rememberUnfilteredListHeight();
  } else {
    listEl.style.minHeight = `${unfilteredListHeight}px`;
  }
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

    li.append(badge, handle, imgWrap, title, makeLabelChips(key, true));
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
  $('targetsListModal').classList.toggle('table-view', on);
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
// The item's price, when known, is shown under the enlarged image.
const IMAGE_PREVIEW_DELAY_MS = 500;
const IMAGE_PREVIEW_WARM_MS = 400;
const PREVIEW_IMG_SELECTOR = '#list img, #tileGrid img, #cartList img, .targetsList img';
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
  preview.querySelector('.preview-price').textContent = previewPriceText(img);
  previewImg.onload = place;
  previewImg.src = img.currentSrc || img.src;
  if (previewImg.complete) place();
}

// The displayed price of the item a thumbnail belongs to, or '' if none is
// known (cart rows aren't priced). Price targets rows carry their target id,
// so off-page targets fall back to the item's remembered price.
function previewPriceText(img) {
  const li = img.closest('li');
  if (!li) return '';
  const item = li.dataset.id && priceRules.has(li.dataset.id)
    ? targetItem(li.dataset.id)
    : li.dataset.key && itemsByKey.get(li.dataset.key);
  return (item && item.priceText) || '';
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
  matchTargetsFooterHeight();
  applyPendingScroll();
  saveViewState({ gridMode: on });
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

// Snapshots of the arrangement and labels, taken before each change. Kept by
// the page until it reloads (see "View memory"), and cleared once an Apply
// completes, since the page's real order has moved on by then.
const HISTORY_LIMIT = 100;
let undoStack = [];
let redoStack = [];

function snapshotState() {
  return {
    order: order.slice(),
    labels: labels.map((l) => ({ ...l })),
    labelsOf: [...labelsOf].map(([key, ids]) => [key, [...ids]]),
    priceRules: [...priceRules].map(([key, rule]) => [key, { ...rule }])
  };
}

function restorePriceRules(snap) {
  priceRules = new Map((snap.priceRules || []).map(([key, rule]) => [key, { ...rule }]));
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
  restorePriceRules(snap);
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
  saveViewState({ history: { undo: undoStack, redo: redoStack } });
}

// ---- Labels ----

// Ids of price-target labels: ones made for price targets (`target`, e.g.
// from the Price targets tab's "＋ Label") plus any some target applies.
// They're kept apart from the
// general labels: listed after them (with a divider) in the filter and the
// label editor, first in the price-target dialog, and left out of the item
// right-click menu.
function priceTargetLabelIds() {
  return new Set([
    ...labels.filter((l) => l.target).map((l) => l.id),
    ...[...priceRules.values()].map((r) => r.labelId)
  ]);
}

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
      priceRules = new Map();
      Object.entries(saved.priceRules || {}).forEach(([id, rule]) => {
        if (!rule || !getLabel(rule.labelId)) return;
        // Targets saved before items could have several were keyed by the
        // item's key, with no `key` field of their own.
        if (rule.key) priceRules.set(id, { ...rule });
        else priceRules.set(newTargetId(), { ...rule, key: id });
      });
      resolve();
    });
  });
}

function saveLabels() {
  const items = {};
  labelsOf.forEach((ids, key) => { if (ids.size) items[key] = [...ids]; });
  const rules = Object.fromEntries(priceRules);
  const updatedAt = Date.now();
  seenUpdatedAt.labels = updatedAt;
  chrome.storage.local.set({ [LABELS_STORAGE_KEY]: { labels, items, priceRules: rules, updatedAt } });
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
  restorePriceRules(labelEditBefore);
  labelEditBefore = null;
  commitLabelChange();
}

function createLabel(name, forKey, target = false) {
  const before = snapshotState();
  const id = addLabel(name, target);
  if (forKey) setItemLabel(forKey, id, true);
  recordChange(before);
  commitLabelChange();
}

// Adds a label to the list (no undo step or save) and returns its id.
function addLabel(name, target = false) {
  const id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Reuse the least-used color so neighbouring labels stay distinguishable.
  const used = labels.map((l) => l.color);
  let color = 0;
  for (let c = 0; c < LABEL_COLORS; c++) {
    if (used.filter((u) => u === c).length < used.filter((u) => u === color).length) color = c;
  }
  labels.push(target ? { id, name, color, target: true } : { id, name, color });
  return id;
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
  priceRules.forEach((rule, rid) => {
    if (rule.labelId !== id) return;
    if (getLabel(targetId)) rule.labelId = targetId; else priceRules.delete(rid);
  });
  labels = labels.filter((l) => l.id !== id);
  recordChange(before);
  commitLabelChange();
}

function labelCount(id) {
  return order.filter((k) => itemLabelIds(k).has(id)).length;
}

// The item's label chips. In the saved list (withTargets), each price target
// shows as a pill with its target price instead (makePriceTags), and the
// labels those targets apply aren't repeated as chips.
function makeLabelChips(key, withTargets = false) {
  const wrap = document.createElement('span');
  wrap.className = 'label-chips';
  if (withTargets) wrap.append(...makePriceTags(key));
  const targetLabels = new Set(itemTargetIds(key).map((rid) => priceRules.get(rid).labelId));
  labels.forEach((label) => {
    if (!itemLabelIds(key).has(label.id)) return;
    if (withTargets && targetLabels.has(label.id)) return;
    const chip = document.createElement('span');
    chip.className = `label-chip label-c${label.color}`;
    chip.textContent = label.name;
    chip.title = label.name;
    wrap.appendChild(chip);
  });
  return wrap;
}

// ---- Price targets ----

// A price target: while its item's price on the page is within [min, max]
// (either end may be null, i.e. open), the item gets the target's label. An
// item can have several targets (e.g. "Good price" at $40, "Buy now" at
// $20); each is keyed by its own id and names its item in `key`. Prices are
// only seen while the popup is open on the cart, so that's when targets are
// checked (applyPriceRules, after every scan) — there's no background price
// tracking. `applied` marks that the target has fired for the current
// in-range stretch, so removing the label by hand sticks until the price
// leaves the range and comes back. `added` marks that the target put the
// label on (rather than the item already having it), so it only takes off a
// label it added itself once the price leaves the range — and not while
// another of the item's targets with the same label is still applying it.
// Stored with the labels (`priceRules` in sfl_labels), so they sync and undo
// along with them. Each target also keeps the item's title/url/image and
// last price seen, so the "Price targets" tab can list items that are no
// longer on the page.
//
// While an item on the page is in range of a target, a notification card
// shows at the top of the popup (renderPriceAlerts), one per target.
// "Dismiss" sets `dismissedPrice` to the current price, hiding it until the
// price changes (applyPriceRules clears it on any change, so it comes back
// even if the price returns to the same amount later); "Don't show again"
// sets `muted`, which the edit dialog's "Notify me" checkbox turns back off.
// Saving a target from the dialog clears `dismissedPrice`.
//
// The Price targets tab lists one row per target in the user's own order
// (drag to rearrange), kept as a `rank` on each target rather than as a
// separate list, so it syncs in the same chunks as the targets. Targets
// without one sort last, in the order they were stored.

const RULE_ITEM_FIELDS = ['title', 'url', 'image', 'price', 'priceText'];

function newTargetId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// The item's target ids, in the Price targets tab's order.
function itemTargetIds(key) {
  return targetIds().filter((rid) => priceRules.get(rid).key === key);
}

// The short form of an Amazon product link ("https://www.amazon.com/dp/<ASIN>"
// rather than the long one with the product name in it), to keep targets
// small in sync; other links just lose their query string.
function shortProductUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
    return m ? `${u.origin}/dp/${m[1]}` : url.split('?')[0];
  } catch (e) {
    return url;
  }
}

// Copies the item's details onto its target; returns whether any changed.
function rememberRuleItem(rule, item) {
  let changed = false;
  RULE_ITEM_FIELDS.forEach((f) => {
    const value = f === 'url' && item.url ? shortProductUrl(item.url) : item[f];
    if (value === undefined || value === null || rule[f] === value) return;
    rule[f] = value;
    changed = true;
  });
  return changed;
}

function priceInRange(price, rule) {
  return (rule.min === null || price >= rule.min) && (rule.max === null || price <= rule.max);
}

// Formats an amount the way Amazon wrote `priceText` ("$18.99", "18,99 €"):
// same currency symbol and decimal mark, two decimals, no thousands marks.
function formatPriceLike(priceText, amount) {
  const fixed = amount.toFixed(2);
  const m = (priceText || '').match(/\d(?:[\d.,\s ]*\d)?/);
  if (!m) return fixed;
  const decimalComma = /,\d{2}$/.test(m[0]);
  return priceText.replace(m[0], decimalComma ? fixed.replace('.', ',') : fixed);
}

// How far the price is from the target: { text, hit } or null if unknown.
// Above the range it's the drop still needed; below a minimum, how far
// under; in range with a maximum, how far under that maximum it is.
function priceTargetGap(price, priceText, rule) {
  if (typeof price !== 'number') return null;
  const round = (n) => Math.round(n * 100) / 100;
  if (rule.max !== null && price > rule.max) {
    return { text: `${formatPriceLike(priceText, round(price - rule.max))} above target`, hit: false };
  }
  if (rule.min !== null && price < rule.min) {
    return { text: `${formatPriceLike(priceText, round(rule.min - price))} below range`, hit: false };
  }
  if (rule.max !== null) {
    const under = round(rule.max - price);
    return { text: under ? `${formatPriceLike(priceText, under)} under target` : 'At target', hit: true };
  }
  return { text: 'In range', hit: true };
}

// priceText (optional) is a price Amazon showed for the item, to borrow its
// currency format from; without one the bounds are plain numbers.
function formatPriceRange(rule, priceText) {
  const fmt = (n) => (priceText ? formatPriceLike(priceText, n) : `${n}`);
  if (rule.min !== null && rule.max !== null) return rule.min === rule.max ? fmt(rule.min) : `${fmt(rule.min)}–${fmt(rule.max)}`;
  return rule.min !== null ? `${fmt(rule.min)} or more` : `${fmt(rule.max)} or less`;
}

// Whether another of the item's targets (other than `exceptId`) is
// currently applying `labelId` — if so, that label stays on.
function labelHeldByOtherTarget(key, labelId, exceptId) {
  return itemTargetIds(key).some((rid) => {
    const r = priceRules.get(rid);
    return rid !== exceptId && r.labelId === labelId && r.applied;
  });
}

// Adds/removes target labels for the prices currently known. Returns whether
// anything changed; callers save and re-render. Not an undo step, since it's
// the page's prices changing, not the user. Holds off while the label editor
// is open so its snapshot stays accurate.
function applyPriceRules() {
  if (labelEditBefore) return false;
  let changed = false;
  priceRules.forEach((rule, rid) => {
    const key = rule.key;
    const item = itemsByKey.get(key);
    if (!item) return;
    if (rememberRuleItem(rule, item)) changed = true;
    if (rule.dismissedPrice != null && item.price !== rule.dismissedPrice) {
      rule.dismissedPrice = null;
      changed = true;
    }
    if (typeof item.price !== 'number' || !getLabel(rule.labelId)) return;
    const inRange = priceInRange(item.price, rule);
    if (inRange && !rule.applied) {
      rule.added = !itemLabelIds(key).has(rule.labelId);
      if (rule.added) setItemLabel(key, rule.labelId, true);
      rule.applied = true;
      changed = true;
    } else if (!inRange && rule.applied) {
      if (rule.added && !labelHeldByOtherTarget(key, rule.labelId, rid)) setItemLabel(key, rule.labelId, false);
      rule.applied = false;
      rule.added = false;
      changed = true;
    }
  });
  return changed;
}

// Undoes whatever the target did to its item's labels, before it's replaced
// or removed.
function retractPriceRule(rid) {
  const rule = priceRules.get(rid);
  if (rule && rule.added && !labelHeldByOtherTarget(rule.key, rule.labelId, rid)) setItemLabel(rule.key, rule.labelId, false);
}

// Saves a target: the existing one `rid`, or a new one for item `key` when
// rid is null.
function setPriceRule(key, rid, { min, max, labelId, newLabelName, notify }) {
  const before = snapshotState();
  if (rid) retractPriceRule(rid);
  const id = newLabelName ? addLabel(newLabelName, true) : labelId;
  const old = (rid && priceRules.get(rid)) || {};
  const rank = old.rank !== undefined ? old.rank : nextTargetRank();
  const rule = { key, labelId: id, min, max, applied: false, added: false, muted: !notify, dismissedPrice: null, rank };
  RULE_ITEM_FIELDS.forEach((f) => { if (old[f] !== undefined) rule[f] = old[f]; });
  if (!rid) {
    const item = itemsByKey.get(key);
    if (item) rememberRuleItem(rule, item);
  }
  priceRules.set(rid || newTargetId(), rule);
  applyPriceRules();
  recordChange(before);
  commitLabelChange();
}

function removePriceRule(rid) {
  const before = snapshotState();
  retractPriceRule(rid);
  priceRules.delete(rid);
  recordChange(before);
  commitLabelChange();
}

// Targets whose item is on the page with its price in range right now, and
// whose notification hasn't been dismissed or muted, in list order.
function priceAlertIds() {
  return order.flatMap((key) => itemTargetIds(key).filter((rid) => {
    const rule = priceRules.get(rid);
    const item = itemsByKey.get(key);
    if (rule.muted || !item || typeof item.price !== 'number') return false;
    return priceInRange(item.price, rule) && rule.dismissedPrice !== item.price;
  }));
}

// permanently: "Don't show again" (until re-enabled in the edit dialog);
// otherwise hidden until the price changes.
function dismissPriceAlert(rid, permanently) {
  const rule = priceRules.get(rid);
  if (!rule) return;
  const item = itemsByKey.get(rule.key);
  const before = snapshotState();
  if (permanently) rule.muted = true;
  else if (item) rule.dismissedPrice = item.price;
  recordChange(before);
  commitLabelChange();
}

function renderPriceAlerts() {
  const ids = priceAlertIds();
  ['priceAlerts', 'priceAlertsModal'].forEach((containerId) => {
    const container = $(containerId);
    container.innerHTML = '';
    container.hidden = !ids.length;
    ids.forEach((rid) => {
      const rule = priceRules.get(rid);
      const item = itemsByKey.get(rule.key);
      const label = getLabel(rule.labelId);
      const gap = priceTargetGap(item.price, item.priceText, rule);

      const card = document.createElement('div');
      card.className = 'price-alert';
      card.setAttribute('role', 'status');
      const text = document.createElement('div');
      text.className = 'price-alert-text';
      const heading = document.createElement('strong');
      heading.textContent = label ? `Price target hit: ${label.name}` : 'Price target hit';
      const title = makeTitleEl(item, rule.key);
      const detail = document.createElement('span');
      detail.className = 'price-alert-detail';
      detail.textContent = `Now ${item.priceText} · target ${formatPriceRange(rule, item.priceText)}${gap ? ` · ${gap.text}` : ''}`;
      text.append(heading, title, detail);

      const actions = document.createElement('div');
      actions.className = 'price-alert-actions';
      [
        { text: 'Edit', title: 'Edit this price target', onClick: () => openPriceRuleDialog(rule.key, rid) },
        { text: 'Dismiss', title: 'Hide until the price changes', onClick: () => dismissPriceAlert(rid, false) },
        { text: "Don't show again", title: 'Stop notifying for this target (turn back on with Edit)', onClick: () => dismissPriceAlert(rid, true) }
      ].forEach((a) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = a.text;
        btn.title = a.title;
        btn.addEventListener('click', a.onClick);
        actions.appendChild(btn);
      });
      card.append(text, actions);
      container.appendChild(card);
    });
  });
}

// The item details a target row shows: live from the page when it's there,
// otherwise what the target remembers.
function targetItem(rid) {
  const rule = priceRules.get(rid);
  return (order.includes(rule.key) && itemsByKey.get(rule.key)) || rule;
}

function targetIsHit(rid) {
  const item = targetItem(rid);
  return typeof item.price === 'number' && priceInRange(item.price, priceRules.get(rid));
}

const TARGET_FILTERS = {
  hit: { text: 'In range', test: (rid) => targetIsHit(rid) },
  miss: { text: 'Not in range', test: (rid) => !targetIsHit(rid) },
  offpage: { text: 'Not on this page', test: (rid) => !order.includes(priceRules.get(rid).key) },
  muted: { text: 'Notifications off', test: (rid) => !!priceRules.get(rid).muted }
};

function matchesTargetFilter(rid, filter = targetFilter) {
  if (filter === 'all') return true;
  if (filter.startsWith('label:')) return priceRules.get(rid).labelId === filter.slice(6);
  if (filter.startsWith('item:')) return itemLabelIds(priceRules.get(rid).key).has(filter.slice(5));
  return TARGET_FILTERS[filter] ? TARGET_FILTERS[filter].test(rid) : true;
}

// One-line summary in #msg's slot on the Price targets tab, like the saved
// tab's item count.
function renderTargetSummary() {
  const ids = [...priceRules.keys()];
  const hits = ids.filter(targetIsHit).length;
  const offPage = ids.filter((rid) => !order.includes(priceRules.get(rid).key)).length;
  const parts = [`${ids.length} price target${ids.length === 1 ? '' : 's'}`, `${hits} in range`];
  if (offPage) parts.push(`${offPage} not on this page`);
  $('targetsHint').textContent = parts.join(' · ');
}

// Fills both targets filter dropdowns (compact + grid) with counts, in the
// shared layout (see appendLabelGroups): status filters, general labels
// (matching targets whose item has them), price-target labels.
function renderTargetFilter() {
  const ids = [...priceRules.keys()];
  const count = (filter) => ids.filter((rid) => matchesTargetFilter(rid, filter)).length;
  const targetIds = priceTargetLabelIds();
  const usedLabels = labels.filter((l) => targetIds.has(l.id));
  const generalLabels = labels.filter((l) => !targetIds.has(l.id));
  const valid = ['all', ...Object.keys(TARGET_FILTERS), ...usedLabels.map((l) => `label:${l.id}`), ...generalLabels.map((l) => `item:${l.id}`)];
  if (!valid.includes(targetFilter)) targetFilter = 'all';
  document.querySelectorAll('.targetsFilter').forEach((select) => {
    select.innerHTML = '';
    const add = (parent, value, text) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = `${text} (${count(value)})`;
      parent.appendChild(opt);
    };
    add(select, 'all', 'All targets');
    const withCount = (value, text) => [value, `${text} (${count(value)})`];
    appendLabelGroups(select, [
      { title: 'Status', options: Object.entries(TARGET_FILTERS).map(([value, f]) => withCount(value, f.text)) },
      { title: 'Labels', options: generalLabels.map((l) => withCount(`item:${l.id}`, l.name)) },
      { title: 'Price target labels', options: usedLabels.map((l) => withCount(`label:${l.id}`, l.name)) }
    ]);
    appendFilterActions(select);
    select.value = targetFilter;
  });
}

// Target ids in the order the Price targets tab shows them.
function targetIds() {
  const rank = (rid) => { const r = priceRules.get(rid).rank; return typeof r === 'number' ? r : Infinity; };
  return [...priceRules.keys()].sort((a, b) => rank(a) - rank(b));
}

function nextTargetRank() {
  return targetIds().reduce((max, rid) => Math.max(max, priceRules.get(rid).rank ?? -1), -1) + 1;
}

// Moves a target before/after another in the Price targets tab, then
// renumbers every rank so they stay 0..n-1.
function moveTarget(rid, targetRid, position) {
  if (rid === targetRid) return;
  const ids = targetIds().filter((r) => r !== rid);
  const idx = ids.indexOf(targetRid);
  if (idx === -1) return;
  ids.splice(position === 'after' ? idx + 1 : idx, 0, rid);
  const before = snapshotState();
  ids.forEach((r, i) => { priceRules.get(r).rank = i; });
  recordChange(before);
  commitLabelChange();
}

function attachTargetRowDrag(li, listEl) {
  const clear = () => listEl.querySelectorAll('li').forEach((r) => r.classList.remove('drag-over-before', 'drag-over-after'));
  li.addEventListener('dragstart', (e) => {
    listEl.dataset.dragging = li.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('drag-source');
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('drag-source');
    delete listEl.dataset.dragging;
    clear();
  });
  li.addEventListener('dragover', (e) => {
    if (!listEl.dataset.dragging) return;
    e.preventDefault();
    // In the grid view it's the panel around the list that scrolls.
    autoScrollContainerOnDragover(listEl.id === 'targetsListModal' ? listEl.parentElement : listEl, e.clientY);
    // The grid view's cards flow left to right like the saved tiles (except
    // in table view), so split them on the horizontal midpoint there.
    const rect = li.getBoundingClientRect();
    const horizontal = listEl.id === 'targetsListModal' && !listEl.classList.contains('table-view');
    const before = horizontal ? e.clientX - rect.left < rect.width / 2 : e.clientY - rect.top < rect.height / 2;
    clear();
    li.classList.add(before ? 'drag-over-before' : 'drag-over-after');
    li.dataset.dropPosition = before ? 'before' : 'after';
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const rid = listEl.dataset.dragging;
    clear();
    if (rid) moveTarget(rid, li.dataset.id, li.dataset.dropPosition || 'before');
  });
}

// Compact form of a target range for the saved list's pills: "$20.00" (a
// highest price — the usual target), "≥ $5.00", "$5.00–$10.00".
function formatPriceRangeShort(rule, priceText) {
  const fmt = (n) => (priceText ? formatPriceLike(priceText, n) : `${n}`);
  if (rule.min !== null && rule.max !== null) return rule.min === rule.max ? fmt(rule.min) : `${fmt(rule.min)}–${fmt(rule.max)}`;
  return rule.min !== null ? `≥ ${fmt(rule.min)}` : fmt(rule.max);
}

// One pill per price target of the item, showing its target price;
// highlighted while the current price is in range. Hovering names the
// target's label and shows the current price.
function makePriceTags(key) {
  const item = itemsByKey.get(key);
  const known = item && typeof item.price === 'number';
  return itemTargetIds(key).flatMap((rid) => {
    const rule = priceRules.get(rid);
    const label = getLabel(rule.labelId);
    if (!label) return [];
    const priceText = (item && item.priceText) || rule.priceText;
    const tag = document.createElement('span');
    tag.className = 'price-tag';
    tag.textContent = formatPriceRangeShort(rule, priceText);
    if (known && priceInRange(item.price, rule)) tag.classList.add('hit');
    tag.title = `“${label.name}” when the price is ${formatPriceRange(rule, priceText)}` +
      ` · now ${known ? item.priceText : 'no price shown'}`;
    return [tag];
  });
}

const NEW_LABEL_OPTION = '__new';

// camelcamelcamel's price-history site for each Amazon storefront it covers.
const CAMEL_HOSTS = {
  'amazon.com': 'camelcamelcamel.com',
  'amazon.co.uk': 'uk.camelcamelcamel.com',
  'amazon.de': 'de.camelcamelcamel.com',
  'amazon.fr': 'fr.camelcamelcamel.com',
  'amazon.ca': 'ca.camelcamelcamel.com',
  'amazon.com.au': 'au.camelcamelcamel.com',
  'amazon.es': 'es.camelcamelcamel.com',
  'amazon.it': 'it.camelcamelcamel.com',
  'amazon.co.jp': 'jp.camelcamelcamel.com'
};

// The item's camelcamelcamel page, or null if its key isn't an ASIN or its
// storefront isn't one camelcamelcamel tracks. Items with no known URL are
// assumed to be on amazon.com.
function camelUrl(key, productUrl) {
  if (!/^[A-Z0-9]{10}$/.test(key)) return null;
  let host = 'amazon.com';
  try {
    if (productUrl) host = new URL(productUrl).hostname.replace(/^(www|smile)\./, '');
  } catch (e) { /* keep the default */ }
  const camel = CAMEL_HOSTS[host];
  return camel ? `https://${camel}/product/${key}` : null;
}

const OPEN_IN_NEW_ICON_PATH = 'M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z'; // "open-in-new" from Material Design Icons (@mdi/svg 7.4.47, Apache-2.0)
// More Material Design Icons (@mdi/svg 7.4.47, Apache-2.0) for the right-click menus.
const CHECK_ICON_PATH = 'M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z'; // "check"
const PLUS_ICON_PATH = 'M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z'; // "plus"
const PENCIL_ICON_PATH = 'M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z'; // "pencil"
const TAG_ICON_PATH = 'M21.41,11.58L12.41,2.58C12.05,2.22 11.55,2 11,2H4C2.9,2 2,2.9 2,4V11C2,11.55 2.22,12.05 2.59,12.42L11.59,21.42C11.95,21.78 12.45,22 13,22C13.55,22 14.05,21.78 14.41,21.41L21.41,14.41C21.78,14.05 22,13.55 22,13C22,12.45 21.77,11.94 21.41,11.58M13,20L4,11V4H11V3.99L20,12.99L13,20M6.5,5A1.5,1.5 0 0,1 8,6.5A1.5,1.5 0 0,1 6.5,8A1.5,1.5 0 0,1 5,6.5A1.5,1.5 0 0,1 6.5,5Z'; // "tag-outline"
const CART_PLUS_ICON_PATH = 'M11,9H13V6H16V4H13V1H11V4H8V6H11M7,18A2,2 0 0,0 5,20A2,2 0 0,0 7,22A2,2 0 0,0 9,20A2,2 0 0,0 7,18M17,18A2,2 0 0,0 15,20A2,2 0 0,0 17,22A2,2 0 0,0 19,20A2,2 0 0,0 17,18M7.17,14.75L7.2,14.63L8.1,13H15.55C16.3,13 16.96,12.59 17.3,11.97L21.16,4.96L19.42,4H19.41L18.31,6L15.55,11H8.53L8.4,10.73L6.16,6L5.21,4L4.27,2H1V4H3L6.6,11.59L5.24,14.04C5.09,14.32 5,14.65 5,15A2,2 0 0,0 7,17H19V15H7.42C7.29,15 7.17,14.89 7.17,14.75Z'; // "cart-plus"
const CHART_ICON_PATH = 'M16,11.78L20.24,4.45L21.97,5.45L16.74,14.5L10.23,10.75L5.46,19H22V21H2V3H4V17.54L9.66,7.75L16.17,11.5Z'; // "chart-line"

// "Open product page" for the right-click menus, or null without a URL.
// Background tab, like item titles, so the popup stays open.
function openProductEntry(url) {
  if (!url) return null;
  return { label: 'Open product page', icon: OPEN_IN_NEW_ICON_PATH, onClick: () => chrome.tabs.create({ url, active: false }) };
}

// "Price history on camelcamelcamel" for the right-click menus, or null
// when camelcamelcamel doesn't cover the item (see camelUrl).
function camelEntry(key, productUrl) {
  const url = camelUrl(key, productUrl);
  if (!url) return null;
  return { label: 'Price history on camelcamelcamel', icon: CHART_ICON_PATH, onClick: () => chrome.tabs.create({ url, active: false }) };
}

// Right-click menu for a row on the Price targets tab.
function openTargetMenu(rid, x, y) {
  if (applyInProgress) return;
  const rule = priceRules.get(rid);
  const item = targetItem(rid);
  const entries = [{ heading: 'Price target', closable: true }];
  const label = getLabel(rule.labelId);
  entries.push({ label: 'Edit price target…', icon: PENCIL_ICON_PATH, swatch: label && label.color, onClick: () => openPriceRuleDialog(rule.key, rid) });
  entries.push({ label: 'Add another price target…', icon: PLUS_ICON_PATH, onClick: () => openPriceRuleDialog(rule.key) });
  entries.push('sep');
  const product = openProductEntry(item.url);
  if (product) entries.push(product);
  const history = camelEntry(rule.key, item.url);
  if (history) entries.push(history);
  if (product || history) entries.push('sep');
  entries.push({ label: 'Delete price target', icon: TRASH_ICON_PATH, danger: true, onClick: () => removePriceRule(rid) });
  openContextMenu(entries, x, y);
}

// Edits target `rid`, or adds a new target for item `key` when rid is omitted.
function openPriceRuleDialog(key, rid = null) {
  const rule = rid ? priceRules.get(rid) : null;
  // Falls back to the details a target remembers for items no longer on the page.
  const onPage = order.includes(key);
  const remembered = rule || itemTargetIds(key).map((r) => priceRules.get(r))[0];
  const item = (onPage && itemsByKey.get(key)) || remembered || itemsByKey.get(key);
  const known = item && typeof item.price === 'number';

  const intro = document.createElement('p');
  intro.textContent = `Label “${(item && item.title) || key}” automatically while its price is in this range. ` +
    (onPage ? `Current price: ${known ? item.priceText : 'not shown on the page'}.`
      : `Last price seen: ${known ? item.priceText : 'none'} (not on this page right now).`);

  const range = document.createElement('div');
  range.className = 'price-rule-range';
  const makeBound = (placeholder, value) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.01';
    input.placeholder = placeholder;
    if (value !== null && value !== undefined) input.value = String(value);
    return input;
  };
  const minInput = makeBound('Any', rule ? rule.min : null);
  const maxInput = makeBound(known ? String(item.price) : 'Any', rule ? rule.max : null);
  range.append('From', minInput, 'to', maxInput);

  const selectLabel = document.createElement('label');
  selectLabel.className = 'price-rule-label';
  selectLabel.textContent = 'Add label';
  const select = document.createElement('select');
  // Labels already used by price targets first, then a separator, then the rest.
  const targetLabelIds = priceTargetLabelIds();
  const targetLabels = labels.filter((l) => targetLabelIds.has(l.id));
  const otherLabels = labels.filter((l) => !targetLabelIds.has(l.id));
  const addSeparator = () => {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '──────────';
    select.appendChild(sep);
  };
  [targetLabels, otherLabels].forEach((group, i) => {
    if (i && targetLabels.length && otherLabels.length) addSeparator();
    group.forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name;
      select.appendChild(opt);
    });
  });
  const newOpt = document.createElement('option');
  newOpt.value = NEW_LABEL_OPTION;
  newOpt.textContent = '＋ New label…';
  select.appendChild(newOpt);
  // For a new target, default to a price-target label the item doesn't
  // already have a target for.
  const taken = new Set(itemTargetIds(key).map((r) => priceRules.get(r).labelId));
  const firstLabel = targetLabels.find((l) => !taken.has(l.id)) || targetLabels[0] || otherLabels[0];
  select.value = rule ? rule.labelId : (firstLabel ? firstLabel.id : NEW_LABEL_OPTION);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'price-rule-new';
  nameInput.maxLength = LABEL_NAME_MAX;
  nameInput.placeholder = 'e.g. Good price, Buy now';
  const syncNameInput = () => { nameInput.style.display = select.value === NEW_LABEL_OPTION ? '' : 'none'; };
  select.addEventListener('change', () => { syncNameInput(); if (select.value === NEW_LABEL_OPTION) nameInput.focus(); });
  syncNameInput();

  const error = document.createElement('p');
  error.className = 'price-rule-error';
  error.style.display = 'none';

  const notifyRow = document.createElement('label');
  notifyRow.className = 'price-rule-notify';
  const notifyBox = document.createElement('input');
  notifyBox.type = 'checkbox';
  notifyBox.checked = !(rule && rule.muted);
  notifyRow.append(notifyBox, 'Notify me in this popup when the price is in range');

  const note = document.createElement('p');
  note.className = 'price-rule-note';
  note.textContent = 'Prices are only checked for items in your Saved for later list, while this popup is ' +
    'open on your cart. The label comes off again when the price leaves the range, unless the item already had it.';

  const showError = (text, field) => {
    error.textContent = text;
    error.style.display = '';
    if (field) field.focus();
    return false;
  };
  const submit = () => {
    const parse = (input) => (input.value.trim() === '' ? null : Number(input.value));
    const min = parse(minInput);
    const max = parse(maxInput);
    if (min === null && max === null) return showError('Enter a lowest price, a highest price, or both.', maxInput);
    if ([min, max].some((v) => v !== null && (!Number.isFinite(v) || v < 0))) return showError('Prices must be 0 or more.', minInput);
    if (min !== null && max !== null && min > max) return showError('The lowest price is above the highest.', minInput);
    const newLabelName = select.value === NEW_LABEL_OPTION ? nameInput.value.trim() : null;
    if (select.value === NEW_LABEL_OPTION && !newLabelName) return showError('Name the new label.', nameInput);
    setPriceRule(key, rid, { min, max, labelId: select.value, newLabelName, notify: notifyBox.checked });
    return true;
  };
  [minInput, maxInput, nameInput].forEach((input) => input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && submit()) closeDialog();
  }));

  const actions = [{ label: 'Cancel' }];
  if (rule) actions.unshift({ label: 'Remove', danger: true, onClick: () => { removePriceRule(rid); } });
  actions.push({ label: 'Save', primary: true, onClick: submit });
  openDialog(rule ? 'Edit price target' : 'New price target', [intro, range, selectLabel, select, nameInput, notifyRow, error, note], actions);
  (rule ? minInput : maxInput).focus();
}

// The "Price targets" tab: one row per target, its item on the page or not.
// The tab bar only shows while there's at least one; removing the last one
// drops back to the saved list.
function renderPriceTargets() {
  const hasTargets = priceRules.size > 0;
  ['tabBar', 'tabBarModal'].forEach((id) => { $(id).hidden = !hasTargets; });
  if (!hasTargets) activeTab = 'saved';
  document.body.classList.toggle('tab-targets', activeTab === 'targets');
  document.querySelectorAll('.savedTabBtn, .targetsTabBtn').forEach((btn) => {
    const selected = btn.classList.contains('targetsTabBtn') === (activeTab === 'targets');
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.targetsTabBtn').forEach((btn) => { btn.textContent = `Price targets (${priceRules.size})`; });

  // Same rows in the compact popup and the grid view.
  renderTargetSummary();
  renderTargetFilter();
  ['targetsList', 'targetsListModal'].forEach((id) => renderPriceTargetRows($(id)));
  renderPriceAlerts();
  matchTargetsFooterHeight();
}

// Gives the grid view's targets footer the saved tab's footer height (its
// Apply/Reset buttons make that one taller), so switching tabs doesn't
// change it. That footer is hidden on the targets tab, so it's measured
// with the tab class briefly off.
function matchTargetsFooterHeight() {
  if (!gridMode) return;
  const body = document.body;
  const onTargets = body.classList.contains('tab-targets');
  if (onTargets) body.classList.remove('tab-targets');
  const height = $('gridModalFooter').getBoundingClientRect().height;
  if (onTargets) body.classList.add('tab-targets');
  if (height) $('targetsFooterModal').style.minHeight = `${height}px`;
}

function renderPriceTargetRows(listEl) {
  listEl.innerHTML = '';
  // Filtering only hides rows: dragging still moves a target within the
  // full order, next to the visible row it was dropped on.
  const ids = targetIds().filter((rid) => matchesTargetFilter(rid));
  if (!ids.length && priceRules.size) {
    const li = document.createElement('li');
    li.className = 'filter-empty';
    li.textContent = 'No price targets match this filter.';
    listEl.appendChild(li);
  }
  ids.forEach((rid) => {
    const rule = priceRules.get(rid);
    const key = rule.key;
    const label = getLabel(rule.labelId);
    const onPage = order.includes(key);
    const item = targetItem(rid);
    const li = document.createElement('li');
    if (!onPage) li.classList.add('off-page');
    li.dataset.id = rid;
    li.dataset.key = key;
    li.draggable = true;
    attachTargetRowDrag(li, listEl);
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTargetMenu(rid, e.clientX, e.clientY);
    });

    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to rearrange';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'imgwrap';
    const img = document.createElement('img');
    img.alt = '';
    if (item.image) img.src = item.image; else img.style.visibility = 'hidden';
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    imgWrap.appendChild(img);

    const main = document.createElement('div');
    main.className = 'target-main';
    const meta = document.createElement('div');
    meta.className = 'target-meta';
    // The target's own label, then the item's general labels.
    const targetLabelIds = priceTargetLabelIds();
    const general = labels.filter((l) => itemLabelIds(key).has(l.id) && !targetLabelIds.has(l.id));
    [label, ...general].forEach((l) => {
      if (!l) return;
      const chip = document.createElement('span');
      chip.className = `label-chip label-c${l.color}`;
      chip.textContent = l.name;
      chip.title = l.name;
      meta.appendChild(chip);
    });
    const range = document.createElement('span');
    range.textContent = `at ${formatPriceRange(rule, item.priceText)}`;
    meta.appendChild(range);
    const price = document.createElement('span');
    price.className = 'price-tag';
    const known = typeof item.price === 'number';
    if (known && priceInRange(item.price, rule)) price.classList.add('hit');
    price.textContent = known ? (onPage ? item.priceText : `last seen ${item.priceText}`) : 'No price';
    meta.appendChild(price);
    const gap = priceTargetGap(item.price, item.priceText, rule);
    if (gap) {
      const gapEl = document.createElement('span');
      gapEl.className = gap.hit ? 'target-gap hit' : 'target-gap';
      gapEl.textContent = gap.text;
      meta.appendChild(gapEl);
    }
    if (!onPage) {
      const off = document.createElement('span');
      off.textContent = "Not on this page — price isn't being checked";
      meta.appendChild(off);
    }
    if (rule.muted) {
      const muted = document.createElement('span');
      muted.textContent = 'Notifications off';
      muted.title = 'Turn back on with Edit';
      meta.appendChild(muted);
    }
    main.append(makeTitleEl({ title: item.title || key, url: item.url }, key), meta);

    // Editing and deleting are in the row's right-click menu (openTargetMenu).
    li.append(handle, imgWrap, main);
    listEl.appendChild(li);
  });
}

// Switching tabs keeps the popup the size it was: the compact targets list
// is sized to take exactly the room the saved list's controls had, and
// scrolls within it. (The compact view sits behind the grid view too, so
// this applies there as well — its height is what sizes the popup window.)
function setActiveTab(tab) {
  if (tab === activeTab) return;
  // Content height, not the visible height: at Chrome's 600px popup cap the
  // two are different, and the visible height would be the same either way.
  const height = document.body.scrollHeight;
  // The targets summary takes #msg's slot; matching its height keeps the
  // filter row exactly where the label filter was.
  if (tab === 'targets') $('targetsHint').style.minHeight = `${$('msg').getBoundingClientRect().height}px`;
  activeTab = tab;
  // Remembered by the page (until it reloads), so the popup reopens here.
  if (activeTabId) sendToTab(activeTabId, { type: 'SFL_SET_LAST_TAB', tab }).catch(() => {});
  closeContextMenu();
  renderPriceTargets();
  if (tab === 'targets') {
    const list = $('targetsList');
    list.style.height = '';
    list.style.maxHeight = 'none';
    list.style.height = `${Math.max(60, list.offsetHeight + height - document.body.scrollHeight)}px`;
  }
  applyPendingScroll();
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
const NEW_LABEL_FILTER_OPTION = '__newlabel';

// Both tabs' filter dropdowns share one layout: the "all" entry and the
// tab's own fixed filters, then optgroups for general labels and for
// price-target labels, then a divider and the actions — "＋ New label…"
// (a general label on the saved tab, a price-target label on the targets
// tab) and "✎ Edit labels…". Actions aren't filters: picking one runs it
// and the dropdown snaps back (onFilterAction).
function appendLabelGroups(select, groups) {
  groups.forEach(({ title, options }) => {
    if (!options.length) return;
    const group = document.createElement('optgroup');
    group.label = title;
    options.forEach(([value, text]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      group.appendChild(opt);
    });
    select.appendChild(group);
  });
}

function appendFilterActions(select) {
  const sep = document.createElement('option');
  sep.disabled = true;
  sep.textContent = '──────────';
  select.appendChild(sep);
  [[NEW_LABEL_FILTER_OPTION, '＋ New label…'], [EDIT_LABELS_OPTION, '✎ Edit labels…']].forEach(([value, text]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  });
}

// Runs a filter dropdown's action entry, if that's what was picked, and
// puts the dropdown back on `current`. Returns whether it was an action.
function onFilterAction(select, current, forTargets) {
  if (select.value === EDIT_LABELS_OPTION) {
    select.value = current;
    openLabelEditor();
    return true;
  }
  if (select.value === NEW_LABEL_FILTER_OPTION) {
    select.value = current;
    if (forTargets) {
      promptLabelName('New price target label', '', (name) => createLabel(name, null, true), 'e.g. Good price, Buy now');
    } else {
      promptLabelName('New label', '', (name) => createLabel(name));
    }
    return true;
  }
  return false;
}

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
    if (labels.length) add('none', `No label (${order.filter((k) => itemLabelIds(k).size === 0).length})`);
    const targetIds = priceTargetLabelIds();
    const option = (l) => [l.id, `${l.name} (${labelCount(l.id)})`];
    appendLabelGroups(select, [
      { title: 'Labels', options: labels.filter((l) => !targetIds.has(l.id)).map(option) },
      { title: 'Price target labels', options: labels.filter((l) => targetIds.has(l.id)).map(option) }
    ]);
    appendFilterActions(select);
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
  rememberUnfilteredListHeight();
  labelFilter = value;
  showInBetween = false;
  // A hidden item staying selected would get dragged along unseen.
  selectedKeys.clear();
  renderList();
  saveFilters();
}

// ---- Context menu ----

function closeContextMenu() {
  $('ctxMenu').classList.remove('show');
}

// entries: [{ label, onClick, danger, icon, checked, swatch }] | { heading } | 'sep'
// Each entry has a leading column holding its icon (an SVG path, e.g.
// PENCIL_ICON_PATH) or, for toggles, a ✓ when checked is true. swatch is a
// label color index drawn before the text.
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
      btn.className = 'ctx-item';
      btn.title = entry.label;
      const leadPath = entry.icon || (entry.checked ? CHECK_ICON_PATH : null);
      btn.insertAdjacentHTML('beforeend', leadPath
        ? `<svg class="ctx-lead" viewBox="0 0 24 24" aria-hidden="true"><path d="${leadPath}"/></svg>`
        : '<span class="ctx-lead"></span>');
      if (entry.swatch != null) {
        const swatch = document.createElement('span');
        swatch.className = `label-swatch label-c${entry.swatch}`;
        btn.appendChild(swatch);
      }
      const text = document.createElement('span');
      text.className = 'ctx-text';
      text.textContent = entry.label;
      btn.appendChild(text);
      if (entry.checked !== undefined) {
        btn.setAttribute('role', 'menuitemcheckbox');
        btn.setAttribute('aria-checked', String(entry.checked));
      }
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
  if (applyInProgress || deletingKey || addingToCartKey) return;
  const current = itemLabelIds(key);
  const entries = [{ heading: 'Labels', closable: true }];
  // Labels a price target uses are applied by the target, not by hand.
  const targetLabelIds = priceTargetLabelIds();
  const menuLabels = labels.filter((l) => !targetLabelIds.has(l.id));
  menuLabels.forEach((l) => {
    entries.push({
      label: l.name,
      checked: current.has(l.id),
      swatch: l.color,
      keepOpen: true,
      onClick: () => {
        toggleItemLabel(key, l.id);
        openItemMenu(key, x, y);
      }
    });
  });
  if (menuLabels.length) entries.push('sep');
  entries.push({ label: 'New label…', icon: PLUS_ICON_PATH, onClick: () => promptLabelName('New label', '', (name) => createLabel(name, key)) });
  entries.push('sep', { heading: 'Price targets' });
  // One entry per existing target ("Edit “Buy now” target…"), then add another.
  itemTargetIds(key).forEach((rid) => {
    const rule = priceRules.get(rid);
    const label = getLabel(rule.labelId);
    entries.push({ label: `Edit “${label ? label.name : 'price'}” target…`, icon: PENCIL_ICON_PATH, swatch: label && label.color, onClick: () => openPriceRuleDialog(key, rid) });
  });
  entries.push({ label: itemTargetIds(key).length ? 'Add another price target…' : 'Label at a target price…', icon: TAG_ICON_PATH, onClick: () => openPriceRuleDialog(key) });
  entries.push('sep');
  const item = itemsByKey.get(key);
  const itemEntriesStart = entries.length;
  if (/^[A-Z0-9]{10}$/.test(key)) {
    entries.push({ label: 'Add to cart (keep in Saved for later)', icon: CART_PLUS_ICON_PATH, onClick: () => addSavedItemToCart(key) });
  }
  const product = openProductEntry(item && item.url);
  if (product) entries.push(product);
  const history = camelEntry(key, item && item.url);
  if (history) entries.push(history);
  if (entries.length > itemEntriesStart) entries.push('sep');
  entries.push({ label: 'Delete from Saved for later…', icon: TRASH_ICON_PATH, danger: true, onClick: () => confirmDeleteItem(key) });
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

// Adds a copy to the cart without Amazon's "Move to cart", which would
// take the item out of Saved for later (see addSavedItemToCart in
// content.js). Outside undo/redo; it's undone by removing it from the cart.
async function addSavedItemToCart(key) {
  if (!activeTabId || addingToCartKey || deletingKey || applyInProgress) return;
  addingToCartKey = key;
  setStatus('Adding to cart…');
  try {
    const res = await sendToTab(activeTabId, { type: 'SFL_ADD_TO_CART', key });
    if (res && res.ok) {
      setStatus('Added to cart — it stays in Saved for later. Refresh the page to see it in your cart.');
    } else {
      setStatus(res && res.error ? res.error : 'Could not add that item to the cart.', true);
    }
  } catch (err) {
    setStatus(`Could not reach the page: ${err.message}`, true);
  }
  addingToCartKey = null;
}

function onLabelFilterChange(select) {
  if (onFilterAction(select, labelFilter, false)) return;
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

function promptLabelName(title, initial, onSave, placeholder = 'e.g. Grocery, Recurring, Electronics') {
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = LABEL_NAME_MAX;
  input.placeholder = placeholder;
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
  // General labels and price-target labels, each under its own heading once
  // there are price-target labels — price-target labels first when opened
  // from the Price targets tab. Rows only reorder within a section.
  const targetIds = priceTargetLabelIds();
  const sections = [
    { name: 'general', title: 'Labels', items: labels.filter((l) => !targetIds.has(l.id)) },
    { name: 'targets', title: 'Price target labels', items: labels.filter((l) => targetIds.has(l.id)) }
  ];
  const showHeadings = sections[1].items.length > 0;
  if (activeTab === 'targets') sections.reverse();
  sections.forEach((section) => {
    if (!section.items.length) return;
    if (showHeadings) {
      const heading = document.createElement('h5');
      heading.className = 'label-editor-section';
      heading.textContent = section.title;
      list.appendChild(heading);
    }
    section.items.forEach((label) => appendLabelEditorRow(list, label, section.name));
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

function appendLabelEditorRow(list, label, section) {
  const row = document.createElement('div');
  row.className = 'label-editor-row';
  row.dataset.id = label.id;
  row.dataset.section = section;
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
    list.dataset.dragSection = row.dataset.section;
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('drag-source');
  });
  row.addEventListener('dragend', () => {
    row.draggable = false;
    row.classList.remove('drag-source');
    delete list.dataset.dragging;
    delete list.dataset.dragSection;
    clear();
  });
  row.addEventListener('dragover', (e) => {
    if (!list.dataset.dragging || list.dataset.dragSection !== row.dataset.section) return;
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
    if (!id || list.dataset.dragSection !== row.dataset.section) return;
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

// Returns to the tab the user was last on for this page (see lastPopupTab
// in content.js), once per popup opening.
let lastTabRestored = false;
async function restoreLastTab(tabId) {
  if (lastTabRestored) return;
  lastTabRestored = true;
  await restoreViewState(tabId);
  let res;
  try {
    res = await sendToTab(tabId, { type: 'SFL_GET_LAST_TAB' });
  } catch (err) {
    res = null;
  }
  if (res && res.tab === 'targets' && priceRules.size) setActiveTab('targets');
  applyPendingScroll();
}

// ---- View memory ----
// The popup's view — filters, selection, grid view, undo/redo history and
// scroll positions — is remembered by the page (until it reloads), like the
// last tab, and restored once per popup opening (restoreLastTab). Saved as
// it changes, since there's no reliable moment to save on close; nothing is
// saved until the restore has run, so start-up rendering can't overwrite it.
// A scroller that's hidden at restore (e.g. the grid while in the compact
// view) can't be scrolled, so its position waits in pendingScroll until
// setGridMode/setActiveTab shows it.
const SCROLLER_IDS = ['body', 'list', 'tileGrid', 'targetsList', 'targetsPanelModal'];
let viewRestored = false;
let savedScroll = {};
let pendingScroll = {};
let scrollSaveTimer = null;

function saveViewState(state) {
  if (!viewRestored || !activeTabId) return;
  sendToTab(activeTabId, { type: 'SFL_SET_VIEW_STATE', state }).catch(() => {});
}

function saveFilters() {
  saveViewState({
    filters: { label: labelFilter, target: targetFilter, inBetween: showInBetween },
    selection: { keys: [...selectedKeys], anchor: selectionAnchor }
  });
}

async function restoreViewState(tabId) {
  let res;
  try {
    res = await sendToTab(tabId, { type: 'SFL_GET_VIEW_STATE' });
  } catch (err) {
    res = null;
  }
  const state = (res && res.state) || {};
  const f = state.filters;
  if (f) {
    // Measured before filtering, so the filtered list keeps the full height.
    rememberUnfilteredListHeight();
    // A label deleted since falls back to all; renderTargetFilter checks the
    // target filter the same way.
    labelFilter = f.label === 'none' || getLabel(f.label) ? f.label : 'all';
    showInBetween = labelFilter !== 'all' && !!f.inBetween;
    targetFilter = f.target || 'all';
  }
  if (state.selection) {
    const live = new Set(order);
    selectedKeys = new Set(state.selection.keys.filter((k) => live.has(k)));
    selectionAnchor = live.has(state.selection.anchor) ? state.selection.anchor : null;
  }
  if (state.history) {
    // Snapshots are reconciled with the items now loaded when they're used
    // (restoreState), so steps from before items changed still apply.
    undoStack = state.history.undo;
    redoStack = state.history.redo;
  }
  renderList();
  renderSelection();
  updateHistoryButtons();
  if (typeof state.gridMode === 'boolean' && state.gridMode !== gridMode) setGridMode(state.gridMode);
  savedScroll = { ...(state.scroll || {}) };
  pendingScroll = { ...savedScroll };
  viewRestored = true;
}

function scrollerEl(id) {
  return id === 'body' ? document.body : $(id);
}

function applyPendingScroll() {
  Object.keys(pendingScroll).forEach((id) => {
    const el = scrollerEl(id);
    if (!el || !el.clientHeight) return;
    el.scrollTop = pendingScroll[id];
    delete pendingScroll[id];
  });
}

function setupScrollMemory() {
  SCROLLER_IDS.forEach((id) => {
    const el = scrollerEl(id);
    el.addEventListener('scroll', () => {
      if (!viewRestored) return;
      delete pendingScroll[id];
      savedScroll[id] = el.scrollTop;
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => saveViewState({ scroll: { ...savedScroll } }), 200);
    });
  });
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

// ---- Multi-select (platform-standard clicks) ----
// ⌘+click (macOS) / Ctrl+click (Windows, Linux) toggles one item; Shift+click
// selects the contiguous range from the anchor, replacing the selection;
// adding ⌘/Ctrl to Shift+click adds the range to the selection instead.
// A plain click highlights just that item; clicking empty space in the list
// or Escape clears it.

// Ctrl+click on macOS is a right-click, so only ⌘ toggles there.
function isToggleClick(e) {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

function setupSelectable(li, key) {
  if (selectedKeys.has(key)) li.classList.add('selected');
  li.addEventListener('click', (e) => {
    if (e.target.closest('input, button')) return;
    if (e.shiftKey) selectRange(li, key, isToggleClick(e));
    else if (isToggleClick(e)) toggleSelected(key);
    else selectOnly(key);
  });
}

function selectOnly(key) {
  selectedKeys.clear();
  selectedKeys.add(key);
  selectionAnchor = key;
  renderSelection();
}

function toggleSelected(key) {
  if (selectedKeys.has(key)) selectedKeys.delete(key);
  else selectedKeys.add(key);
  selectionAnchor = key;
  renderSelection();
}

// Selects every item shown between the anchor and `key` (inclusive), in the
// view `li` belongs to. Without an anchor still on screen, just `key`.
function selectRange(li, key, additive) {
  const keys = [...li.parentElement.querySelectorAll(':scope > li[data-key]')].map((el) => el.dataset.key);
  const to = keys.indexOf(key);
  let from = keys.indexOf(selectionAnchor);
  if (from === -1) {
    from = to;
    selectionAnchor = key;
  }
  if (!additive) selectedKeys.clear();
  keys.slice(Math.min(from, to), Math.max(from, to) + 1).forEach((k) => selectedKeys.add(k));
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
  saveViewState({ selection: { keys: [...selectedKeys], anchor: selectionAnchor } });
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

  // ...and into the Price targets tab's load banner, where neither shows.
  document.body.classList.toggle('msg-loading', !!isLoading);
  document.querySelectorAll('.targetsLoadingText').forEach((t) => { t.textContent = text; });
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
  // The Price targets tab shows its own version (.targetsLoadBanner).
  document.body.classList.toggle('items-incomplete', show);
}

function setLoadAllDisabled(disabled) {
  $('loadAllBtnInline').disabled = disabled;
  $('loadAllBtnModal').disabled = disabled;
  document.querySelectorAll('.loadAllBtnTargets').forEach((btn) => { btn.disabled = disabled; });
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
    if (applyPriceRules()) {
      commitLabelChange();
    } else if (added > 0) {
      renderList();
    }
    if (added > 0) updateResetButton();

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
  if (applyPriceRules()) saveLabels();
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
  restoreLastTab(tab.id);

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
  ['labelFilter', 'labelFilterModal', 'inBetweenBtn', 'inBetweenBtnModal']
    .forEach((id) => { $(id).disabled = disabled; });
  document.querySelectorAll('.targetsFilter').forEach((select) => { select.disabled = disabled; });
  if (disabled) { closeContextMenu(); dismissDialog(); }
  $('loadAllBtnInline').disabled = disabled;
  $('loadAllBtnModal').disabled = disabled;
  document.querySelectorAll('.loadAllBtnTargets').forEach((btn) => { btn.disabled = disabled; });
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
    $('theme').value = THEMES.includes(s.theme) ? s.theme : DEFAULTS.theme;
    applyTheme($('theme').value);
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
    theme: $('theme').value,
    updatedAt: Date.now()
  };
  applyTheme(s.theme);
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
  lastSyncStatus = status;
  renderSyncBadges();
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

// The header's sync note in both views: when sync last ran, or that it
// failed, while sync is on here. Clicking it opens the settings, where the
// full status and Sync now are.
let lastSyncStatus = null;
function renderSyncBadges() {
  const status = lastSyncStatus;
  const enabled = $('syncEnabled').checked;
  document.querySelectorAll('.syncBadge').forEach((el) => {
    el.classList.remove('sync-error');
    el.hidden = !enabled || !status || !(status.error || status.at);
    if (el.hidden) return;
    if (status.error) {
      el.textContent = '⚠ Sync failed';
      el.title = 'Sync failed — click for details';
      el.classList.add('sync-error');
    } else {
      const at = new Date(status.at);
      const today = at.toDateString() === new Date().toDateString();
      el.textContent = `Synced ${today
        ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : at.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
      el.title = `Last synced ${at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} — click for sync settings`;
    }
  });
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
  text.textContent = 'This removes your settings, labels and price targets from your Chrome account and turns sync off on all your computers. ' +
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
  const here = { labels, items, priceRules: Object.fromEntries(priceRules) };
  const synced = remote.labels;
  if (!synced || !synced.labels.length || !labels.length || sameLabelData(here, synced)) {
    setSyncEnabled(true);
    return;
  }
  const text = document.createElement('p');
  text.textContent = `Chrome sync already has labels and price targets from another computer ` +
    `(${synced.labels.length} labels, ${Object.keys(synced.priceRules || {}).length} targets), and they differ from ` +
    `this computer's (${labels.length} labels, ${priceRules.size} targets). Which should be kept on both?`;
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
        const here = { priceRules: Object.fromEntries(priceRules) };
        chrome.storage.local.set({ [LABELS_STORAGE_KEY]: withLocalRuleFields(synced, here) }, () => {
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
  document.querySelectorAll('.syncBadge').forEach((el) => el.addEventListener('click', () => toggleSettingsPanel(true)));
  $('deleteSyncBtn').addEventListener('click', confirmDeleteSynced);
  // Pick up what background.js pulls in from sync while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // background.js turns sync off when the synced data was deleted elsewhere.
    if (changes[SYNC_FLAG_KEY]) {
      const enabled = !!(changes[SYNC_FLAG_KEY].newValue && changes[SYNC_FLAG_KEY].newValue.enabled);
      $('syncEnabled').checked = enabled;
      $('syncNowBtn').disabled = !enabled;
      renderSyncBadges();
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
  setupScrollMemory();
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
  document.querySelectorAll('.loadAllBtnTargets').forEach((btn) => btn.addEventListener('click', loadAllItems));
  $('gridViewBtn').addEventListener('click', () => setGridMode(true));
  document.querySelectorAll('.savedTabBtn').forEach((btn) => btn.addEventListener('click', () => setActiveTab('saved')));
  document.querySelectorAll('.targetsTabBtn').forEach((btn) => btn.addEventListener('click', () => setActiveTab('targets')));
  document.querySelectorAll('.targetsFilter').forEach((select) => select.addEventListener('change', () => {
    if (onFilterAction(select, targetFilter, true)) return;
    targetFilter = select.value;
    renderPriceTargets();
    saveFilters();
  }));
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
  const mod = IS_MAC ? '⌘' : 'Ctrl+';
  ['undoBtn', 'undoBtnModal'].forEach((id) => { $(id).title = `Undo (${mod}Z)`; });
  ['redoBtn', 'redoBtnModal'].forEach((id) => { $(id).title = mod === '⌘' ? 'Redo (⇧⌘Z)' : 'Redo (Ctrl+Y)'; });
  $('resetBtn').addEventListener('click', resetOrder);
  $('applyBtnModal').addEventListener('click', applyOrder);
  $('resetBtnModal').addEventListener('click', resetOrder);
  $('settingsBtn').addEventListener('click', () => toggleSettingsPanel());
  $('settingsBtnModal').addEventListener('click', () => toggleSettingsPanel());
  $('settingsBackdrop').addEventListener('click', () => toggleSettingsPanel(false));
  $('closeSettingsBtn').addEventListener('click', () => toggleSettingsPanel(false));
  $('labelFilter').addEventListener('change', (e) => onLabelFilterChange(e.target));
  $('labelFilterModal').addEventListener('change', (e) => onLabelFilterChange(e.target));
  const toggleInBetween = () => { showInBetween = !showInBetween; renderList(); saveFilters(); };
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
  // Clicking empty space in the list (not on an item) clears the selection.
  ['list', 'tileGrid'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === e.currentTarget) clearSelection(); });
  });
  $('delay').addEventListener('change', saveSettings);
  $('reloadAfterApply').addEventListener('change', saveSettings);
  $('defaultView').addEventListener('change', saveSettings);
  $('theme').addEventListener('change', saveSettings);
  $('titleLinksEnabled').addEventListener('change', saveSettings);
});

window.addEventListener('unload', () => {
  stopWatching();
  if (statusPollHandle) clearInterval(statusPollHandle);
});
