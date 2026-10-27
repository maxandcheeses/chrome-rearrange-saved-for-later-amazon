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
  const listEl = $('list');
  listEl.innerHTML = '';
  order.forEach((key, idx) => {
    const item = itemsByKey.get(key);
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.key = key;

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

    li.append(badge, handle, img, title);
    listEl.appendChild(li);
  });
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
    const item = itemsByKey.get(key);
    const li = document.createElement('li');
    li.className = 'tile';
    li.draggable = true;
    li.dataset.key = key;

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

    li.append(badge, handle, imgWrap, title);
    gridEl.appendChild(li);
  });
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

function setGridMode(on) {
  gridMode = on;
  document.body.classList.toggle('grid-mode', on);
}

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
  order.splice(fromIdx, 1);
  order.splice(newPos - 1, 0, key);
  renderList();
  updateApplyButton();
  persistOrder();
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
  order = naturalOrder.slice();
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
    item.addEventListener('dragstart', () => {
      dragSourceKey = item.dataset.key;
      dropTargetKey = null;
      cancelled = false;
      item.classList.add('drag-source');
      document.addEventListener('keydown', onKeyDown);
      rafHandle = requestAnimationFrame(autoScrollTick);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('drag-source');
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
      if (cancelled || !dragSourceKey || dragSourceKey === dropTargetKey) return;
      const fromIdx = order.indexOf(dragSourceKey);
      let toIdx = order.indexOf(dropTargetKey);
      if (fromIdx === -1 || toIdx === -1) return;
      order.splice(fromIdx, 1);
      toIdx = order.indexOf(dropTargetKey);
      order.splice(dropPosition === 'after' ? toIdx + 1 : toIdx, 0, dragSourceKey);
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
      setMsg(`${order.length} saved item(s). Drag or type a position number to reorder, then Apply.`);
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

  setMsg(`${order.length} saved item(s). Drag or type a position number to reorder, then Apply.`);
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
    tableView
  };
  chrome.storage.local.set({ [STORAGE_KEY]: s });
  defaultView = s.defaultView;
  $('closeGridBtn').title = defaultView === 'grid' ? 'Close popup' : 'Close grid view';
  setGridMode(s.defaultView === 'grid');
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

document.addEventListener('DOMContentLoaded', () => {
  loadSettings((s) => {
    if (s.defaultView === 'grid') setGridMode(true);
  });
  loadItems(true);
  setFooterMsg('💡 Try Grid view for reordering long lists faster.');
  setupImagePreview();

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
  $('resetBtn').addEventListener('click', resetOrder);
  $('applyBtnModal').addEventListener('click', applyOrder);
  $('resetBtnModal').addEventListener('click', resetOrder);
  $('settingsBtn').addEventListener('click', () => toggleSettingsPanel());
  $('settingsBtnModal').addEventListener('click', () => toggleSettingsPanel());
  $('settingsBackdrop').addEventListener('click', () => toggleSettingsPanel(false));
  $('closeSettingsBtn').addEventListener('click', () => toggleSettingsPanel(false));
  $('delay').addEventListener('change', saveSettings);
  $('reloadAfterApply').addEventListener('change', saveSettings);
  $('defaultView').addEventListener('change', saveSettings);
  $('titleLinksEnabled').addEventListener('change', saveSettings);
});

window.addEventListener('unload', () => {
  stopWatching();
  if (statusPollHandle) clearInterval(statusPollHandle);
});
