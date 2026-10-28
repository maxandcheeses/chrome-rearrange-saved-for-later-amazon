(() => {
  'use strict';

  const STORAGE_KEY = 'sfl_settings';
  const DEFAULT_SETTINGS = {
    bumpDelayMs: 500,
    reloadAfterApply: true
  };

  // Where a freshly re-saved item lands in the Saved for later list.
  // This has been observed to be the top on Amazon's cart page.
  const NEW_SAVE_GOES_TO = 'top';

  // Rough per-item time allowance for the two DOM-wait steps inside
  // bumpItem (moving to cart, then finding + clicking "save for later"
  // again) — those aren't on a fixed timer, so this is an approximation
  // based on typical Amazon response speed, not a measured value. Used for
  // both the live "Apply order" countdown and the pre-apply ETA estimate.
  const ESTIMATED_OVERHEAD_PER_ITEM_MS = 1500;

  let settings = { ...DEFAULT_SETTINGS };
  let itemsByKey = new Map();
  let cartItemsByKey = new Map(); // key -> { rowEl, titleText }

  // Holds a not-yet-applied manual reorder so it survives the popup being
  // closed and reopened. Deliberately kept in this content script's memory
  // rather than chrome.storage: this script is torn down and re-injected
  // fresh on every page reload/navigation/tab close, so the pending order
  // is automatically discarded exactly when the user's session on the page
  // effectively resets — which is the behavior we want.
  let pendingOrder = null;

  // The popup tab ('saved' | 'targets') the user was last on, so reopening
  // the popup returns there. In memory for the same reason as pendingOrder:
  // it should last exactly as long as this page does.
  let lastPopupTab = 'saved';

  // The rest of the popup's view (filters, scroll positions, selection,
  // undo/redo history — see "View memory" in popup.js), kept the
  // same way so reopening the popup picks up where it left off until a
  // reload. Each SFL_SET_VIEW_STATE replaces the top-level fields it sends.
  let popupViewState = {};

  // Set by SFL_CANCEL_APPLY while an apply is running; checked between bumps
  // so an in-flight bump always finishes cleanly rather than being torn off
  // mid-DOM-manipulation (which could strand an item in the cart).
  let cancelRequested = false;

  // Broad selector for anything that could be a clickable action control —
  // Amazon mixes <a>, <button>, and <input type="submit"> across pages/locales.
  const ACTION_SELECTOR = 'a, button, input[type="submit"], input[type="button"], [role="button"]';

  const status = { running: false, current: 0, total: 0, message: '', error: null, done: false, cancelled: false };

  // --- Localization ----------------------------------------------------
  // Amazon's visible labels are translated per-country domain. Internal
  // name/id/data-action attributes are usually still English regardless of
  // locale, so we check those first and fall back to a best-effort
  // multilingual phrase list for visible text. Users can add more phrases
  // via the extension popup if a locale isn't covered.

  const MOVE_TO_CART_PHRASES = [
    'move to cart', 'in den einkaufswagen', 'déplacer vers le panier', 'deplacer vers le panier',
    'mover a la cesta', 'mover al carrito', 'sposta nel carrello', 'mover para o carrinho',
    'verplaats naar winkelwagen', 'カートに戻す', 'カートに入れる', 'przenieś do koszyka',
    'przenies do koszyka', 'sepete taşı', 'sepete tasi', 'flytta till kundvagn',
    'przenieść do koszyka', '移至购物车', '移到購物車', 'نقل إلى السلة', 'nakup teraz'
  ];

  const SAVE_FOR_LATER_PHRASES = [
    'save for later', 'für später speichern', 'fur spater speichern', 'enregistrer pour plus tard',
    'guardar para más tarde', 'guardar para mas tarde', 'salva per dopo', 'salvar para depois',
    'bewaren voor later', '後で買う', 'あとで買う', 'zapisz na później', 'zapisz na pozniej',
    'daha sonra almak için kaydet', 'spara till senare', '稍后再买', '之後再買', 'الحفظ لوقت لاحق'
  ];

  // Matched against a control's whole visible text (not a substring), since
  // short words like "sil" or "delete" also turn up inside product titles.
  const DELETE_PHRASES = [
    'delete', 'löschen', 'loschen', 'supprimer', 'eliminar', 'elimina', 'rimuovi', 'excluir',
    'verwijderen', '削除', 'usuń', 'usun', 'sil', 'ta bort', '删除', '刪除', 'حذف'
  ];

  const SAVED_FOR_LATER_HEADING_PHRASES = [
    'saved for later', 'für später gespeichert', 'fur spater gespeichert',
    'enregistré pour plus tard', 'enregistre pour plus tard', 'guardado para más tarde',
    'guardado para mas tarde', 'salvati per dopo', 'salvo para depois',
    'bewaard voor later', '後で買う商品', 'あとで買う商品', 'zapisane na później',
    'zapisane na pozniej', 'daha sonra almak için kaydedilenler', 'sparade till senare',
    '稍后再买', '之後再買', 'محفوظ لوقت لاحق'
  ];

  function attrsText(el) {
    return [
      el.getAttribute && el.getAttribute('name'),
      el.getAttribute && el.getAttribute('id'),
      el.getAttribute && el.getAttribute('data-action'),
      el.getAttribute && el.getAttribute('formaction'),
      el.getAttribute && el.getAttribute('aria-label'),
      el.className && String(el.className)
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function elementLabelText(el) {
    return ((el.textContent || el.value || '') + ' ' + attrsText(el)).toLowerCase();
  }

  function isMoveToCartElement(el) {
    const text = elementLabelText(el);
    if (/move.?to.?cart|movetocart/.test(text)) return true;
    return MOVE_TO_CART_PHRASES.some((p) => text.includes(p.toLowerCase()));
  }

  function isSaveForLaterElement(el) {
    const text = elementLabelText(el);
    if (/save.?for.?later|saveforlater/.test(text)) return true;
    return SAVE_FOR_LATER_PHRASES.some((p) => text.includes(p.toLowerCase()));
  }

  function isDeleteElement(el) {
    if (el.matches('a[href*="/dp/"], a[href*="/gp/product/"]') || isMoveToCartElement(el)) return false;
    if (/submit\.delete|(^|[\s._-])delete($|[\s._-])/.test(attrsText(el))) return true;
    const text = (el.textContent || el.value || '').trim().toLowerCase();
    return DELETE_PHRASES.includes(text);
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (res) => {
        settings = { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEY] || {}) };
        resolve(settings);
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      settings = { ...DEFAULT_SETTINGS, ...changes[STORAGE_KEY].newValue };
    }
  });

  // --- Locating the Saved for later section -----------------------------

  function findSavedForLaterHeading() {
    const candidates = Array.from(document.querySelectorAll('h2, h3, span, div'));
    return candidates.find((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      if (!t || t.length > 60) return false;
      return SAVED_FOR_LATER_HEADING_PHRASES.some((p) => t.includes(p.toLowerCase()));
    });
  }

  // A "row" is an element that contains both a product link (/dp/ or /gp/product/)
  // and an action link matching "Move to cart" in some locale. We deliberately
  // search the whole document rather than scoping to a "Saved for later"
  // container: Amazon's cart page nests saved items in varying wrappers
  // (and lazy-appends new batches in ways that can land outside a container
  // detected from the heading), while "Move to cart" wording is specific
  // enough to saved items that scanning globally doesn't pick up unrelated
  // sections (which use "Add to cart" instead).
  function getCandidateItemRows(root) {
    const actionLinks = Array.from(root.querySelectorAll(ACTION_SELECTOR)).filter(
      isMoveToCartElement
    );
    const rows = [];
    const seen = new Set();
    for (const link of actionLinks) {
      const row = findRowAncestor(link);
      if (row && !seen.has(row)) {
        seen.add(row);
        rows.push(row);
      }
    }
    return rows;
  }

  function getAllSavedRows() {
    return getCandidateItemRows(document.body);
  }

  // Mirror image of getAllSavedRows: cart-line rows are identified by having
  // a "Save for later" action link (rather than "Move to cart"), which is
  // specific enough to actual cart items that it doesn't pick up unrelated
  // page sections.
  function getAllCartRows(root = document.body) {
    const actionLinks = Array.from(root.querySelectorAll(ACTION_SELECTOR)).filter(
      isSaveForLaterElement
    );
    const rows = [];
    const seen = new Set();
    for (const link of actionLinks) {
      const row = findRowAncestor(link);
      if (row && !seen.has(row)) {
        seen.add(row);
        rows.push(row);
      }
    }
    return rows;
  }

  function findRowAncestor(el) {
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      const link = node.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      if (link) return node;
      node = node.parentElement;
    }
    return el.closest('li, div');
  }

  function extractAsin(row) {
    const link = row.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
    if (!link) return null;
    const match = link.href.match(/\/dp\/([A-Z0-9]{10})/) || link.href.match(/\/gp\/product\/([A-Z0-9]{10})/);
    return match ? match[1] : null;
  }

  function extractTitle(row) {
    const link = row.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
    return link ? (link.textContent || '').trim().slice(0, 120) : '(unknown item)';
  }

  function extractUrl(row) {
    const link = row.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
    return link ? link.href : null;
  }

  // Amazon lazy-loads product thumbnails (real URL often sits in data-src /
  // data-a-hires / srcset rather than src) and a row can contain other small
  // icons (star ratings, Prime badge) before the actual product image, so we
  // can't just grab the first <img>. Prefer the image inside the product
  // link itself, then pick the best real-looking image URL from it.
  function bestImageUrl(img) {
    if (!img) return null;
    const candidates = [
      img.getAttribute('data-a-hires'),
      img.getAttribute('data-old-hires'),
      img.getAttribute('data-src'),
      img.currentSrc,
      img.src
    ];
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcset) {
      const first = srcset.split(',')[0].trim().split(' ')[0];
      if (first) candidates.push(first);
    }
    return candidates.find((u) => u && /^(https?:)?\/\//.test(u) && !/^data:/.test(u)) || null;
  }

  // On Amazon's cart page, the row we detect from the action button (e.g.
  // "sc-item-content-group") is often narrower than the full item row —
  // the thumbnail can live in a sibling container one or two levels up
  // (e.g. "sc-list-item"). Climb until we hit that wider boundary, or give
  // up after a few levels to avoid crossing into a different item's row.
  function findImageBoundary(row) {
    let node = row;
    for (let i = 0; i < 6 && node; i++) {
      if (node.classList && Array.from(node.classList).some((c) => /list-item|cart-item|product-row/i.test(c))) {
        return node;
      }
      node = node.parentElement;
    }
    return row;
  }

  function extractImage(row) {
    // Amazon's actual thumbnail class, when present, is the most reliable
    // signal — try it in the row first, then in a wider boundary.
    const named = row.querySelector('img.sc-product-image, img[class*="product-image"], img[class*="item-image"]');
    let url = bestImageUrl(named);
    if (url) return url;

    const link = row.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
    const linkImg = link ? link.querySelector('img') : null;
    url = bestImageUrl(linkImg);
    if (url) return url;

    const boundary = findImageBoundary(row);
    if (boundary !== row) {
      const namedWide = boundary.querySelector('img.sc-product-image, img[class*="product-image"], img[class*="item-image"]');
      url = bestImageUrl(namedWide);
      if (url) return url;
    }

    const imgs = Array.from(row.querySelectorAll('img'));

    // Fall back to the largest image in the row (by declared width/height),
    // skipping obvious icon-sized ones.
    const sized = imgs
      .map((img) => ({ img, area: (Number(img.getAttribute('width')) || img.width || 0) * (Number(img.getAttribute('height')) || img.height || 0) }))
      .filter((x) => x.area > 0)
      .sort((a, b) => b.area - a.area);

    for (const { img } of sized) {
      url = bestImageUrl(img);
      if (url) return url;
    }

    for (const img of imgs) {
      url = bestImageUrl(img);
      if (url) return url;
    }

    return null;
  }

  // Turns Amazon's displayed price ("$1,234.56", "1.234,56 €", "￥1,234")
  // into a number. With both separators present the last one is the
  // decimal point; with only one, it's a decimal point only when followed
  // by exactly two digits (so "1,234" is a thousand, "12,34" is twelve).
  function parsePrice(text) {
    const m = (text || '').match(/\d[\d.,\s ]*/);
    if (!m) return null;
    let s = m[0].replace(/[\s ]/g, '').replace(/[.,]$/, '');
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    let decimal = null;
    if (lastDot !== -1 && lastComma !== -1) decimal = lastDot > lastComma ? '.' : ',';
    else if (lastDot !== -1 || lastComma !== -1) {
      const sep = lastDot !== -1 ? '.' : ',';
      if (/^\d{2}$/.test(s.slice(s.lastIndexOf(sep) + 1)) && s.split(sep).length === 2) decimal = sep;
    }
    if (decimal) {
      const [whole, frac] = [s.slice(0, s.lastIndexOf(decimal)), s.slice(s.lastIndexOf(decimal) + 1)];
      s = `${whole.replace(/[.,]/g, '')}.${frac}`;
    } else {
      s = s.replace(/[.,]/g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // The item's current price as { amount, text }, or null if the row shows
  // none (e.g. out of stock). Skips struck-through list prices
  // (.a-text-price), and looks in the wider row like extractImage does.
  function extractPrice(row) {
    const selectors = [
      '.sc-product-price',
      '.a-price:not(.a-text-price) .a-offscreen',
      '.sc-price'
    ];
    for (const scope of [row, findImageBoundary(row)]) {
      for (const sel of selectors) {
        for (const el of scope.querySelectorAll(sel)) {
          const text = (el.textContent || '').trim();
          const amount = parsePrice(text);
          if (amount !== null) return { amount, text };
        }
      }
    }
    return null;
  }

  function findActionLink(row, matcherFn) {
    const candidates = Array.from(row.querySelectorAll(ACTION_SELECTOR));
    return candidates.find(matcherFn);
  }

  // --- Scanning current items --------------------------------------------

  function scanItems() {
    const rows = getAllSavedRows();
    const items = [];
    itemsByKey.clear();
    rows.forEach((row, idx) => {
      const asin = extractAsin(row);
      const key = asin || `idx-${idx}-${extractTitle(row)}`;
      itemsByKey.set(key, { rowEl: row, titleText: extractTitle(row) });
      const price = extractPrice(row);
      items.push({
        key, title: extractTitle(row), image: extractImage(row), url: extractUrl(row),
        price: price ? price.amount : null, priceText: price ? price.text : null
      });
    });
    return items;
  }

  function scanCartItems() {
    const rows = getAllCartRows();
    const items = [];
    cartItemsByKey.clear();
    rows.forEach((row, idx) => {
      const asin = extractAsin(row);
      const key = asin || `cart-idx-${idx}-${extractTitle(row)}`;
      cartItemsByKey.set(key, { rowEl: row, titleText: extractTitle(row) });
      items.push({ key, title: extractTitle(row), image: extractImage(row), url: extractUrl(row) });
    });
    return items;
  }

  // Moves one item from the cart back into "Saved for later" by clicking its
  // "Save for later" control, then waits for it to actually show up in the
  // saved-for-later rows before resolving.
  async function saveCartItemForLater(key) {
    const asin = /^[A-Z0-9]{10}$/.test(key) ? key : null;
    const entry = cartItemsByKey.get(key);
    if (!entry) throw new Error(`Item ${key} no longer in cart`);

    const saveLink = findActionLink(entry.rowEl, isSaveForLaterElement);
    if (!saveLink) throw new Error(`Could not find "Save for later" for ${entry.titleText}`);
    robustClick(saveLink);

    const reappeared = await waitForCondition(() => {
      const rows = getAllSavedRows();
      return rows.some((r) => (asin ? extractAsin(r) === asin : extractTitle(r) === entry.titleText)) || null;
    });

    if (!reappeared) {
      throw new Error(`Clicked "Save for later" for "${entry.titleText}" but it never showed up in Saved for later.`);
    }
  }

  // Removes one item from "Saved for later" entirely by clicking its
  // "Delete" control, then waits for its row to disappear.
  async function deleteSavedItem(key) {
    const asin = /^[A-Z0-9]{10}$/.test(key) ? key : null;
    scanItems(); // refresh row elements, which Amazon may have re-rendered
    const entry = itemsByKey.get(key);
    if (!entry) throw new Error(`Item ${key} no longer on page`);

    const deleteLink = findActionLink(entry.rowEl, isDeleteElement);
    if (!deleteLink) throw new Error(`Could not find "Delete" for ${entry.titleText}`);
    robustClick(deleteLink);

    const gone = await waitForCondition(() => {
      const rows = getAllSavedRows();
      return !rows.some((r) => (asin ? extractAsin(r) === asin : extractTitle(r) === entry.titleText));
    });

    if (!gone) {
      throw new Error(`Clicked "Delete" for "${entry.titleText}" but it's still in Saved for later.`);
    }
  }

  // Adds a copy of a saved item to the cart while leaving it where it is in
  // Saved for later. Amazon's own "Move to cart" takes it out of the list,
  // so instead this submits the item's product-page "Add to Cart" form in
  // the background (same origin, so the user's session comes along), then
  // re-fetches the cart to check it landed. The page itself isn't updated
  // until it's reloaded.
  async function addSavedItemToCart(key) {
    if (!/^[A-Z0-9]{10}$/.test(key)) throw new Error('This item has no product ID, so it can only be moved to the cart.');
    scanCartItems();
    if (cartItemsByKey.has(key)) throw new Error('That item is already in your cart.');

    const productHtml = await fetchText(`${location.origin}/dp/${key}`);
    const productDoc = new DOMParser().parseFromString(productHtml, 'text/html');
    const form = productDoc.querySelector('form#addToCart');
    const button = form && form.querySelector('[name="submit.add-to-cart"]');
    if (!button) {
      throw new Error("Amazon shows no \"Add to Cart\" button for this item right now (it may need an option picked on its product page, or be unavailable).");
    }

    const body = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value === 'string') body.append(name, value);
    }
    // Only the clicked submit button is sent with a form, and this is an
    // add to cart, not "Buy now".
    body.delete('isBuyNow');
    body.append(button.name, button.value || '');
    // The button's formaction (/cart/add-to-cart/…) overrides the form's own
    // action, which 404s for an add to cart.
    const action = button.getAttribute('formaction') || form.getAttribute('action') || '';
    const res = await fetch(new URL(action, `${location.origin}/dp/${key}`), {
      method: 'POST', body, credentials: 'include'
    });
    if (!res.ok) throw new Error(`Amazon refused the request (HTTP ${res.status}).`);

    const cartDoc = new DOMParser().parseFromString(await fetchText(`${location.origin}/gp/cart/view.html`), 'text/html');
    const inCart = cartDoc.querySelector(`#sc-active-cart [data-asin="${key}"]`) ||
      getAllCartRows(cartDoc.body).some((r) => extractAsin(r) === key);
    if (!inCart) throw new Error("Amazon didn't add the item to your cart. Try its product page instead.");
  }

  async function fetchText(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Couldn't load ${new URL(url).pathname} (HTTP ${res.status}).`);
    return res.text();
  }

  function looksLikeCartPage() {
    return /\/(gp\/cart\/view\.html|cart)/i.test(location.pathname) || !!findSavedForLaterHeading();
  }

  // --- Forcing the lazy-loaded list to fully load ---------------------------
  //
  // Amazon only renders a batch of saved-for-later items up front and loads
  // the rest as you scroll (infinite scroll). We scroll the page repeatedly,
  // watching the row count, until it stops growing for a few consecutive
  // checks (or we hit a safety cap), so the popup gets the whole list.

  // mayBeIncomplete starts true and stays true until either a full
  // scroll-load has actually run, or the passive check below infers
  // completeness from the user's own manual scrolling.
  const loadStatus = { loading: false, foundCount: 0, mayBeIncomplete: true, everFullyLoaded: false };

  // Passive completeness detection: we don't control the user's scrolling,
  // so instead of scrolling ourselves, each time the popup polls us (every
  // ~1.2s while it's open) we check whether the page is scrolled to the
  // bottom and the item count has held steady across a couple of checks.
  // If so, Amazon isn't going to lazy-load anything more right now, so the
  // list can be treated as complete.
  let passiveLastCount = -1;
  let passiveStableStreak = 0;

  function isNearPageBottom(thresholdPx = 150) {
    return (window.innerHeight + window.scrollY) >= (document.documentElement.scrollHeight - thresholdPx);
  }

  function passiveCompletionCheck() {
    if (loadStatus.everFullyLoaded) return;
    const count = getAllSavedRows().length;
    if (count === passiveLastCount) {
      passiveStableStreak++;
    } else {
      passiveStableStreak = 0;
      passiveLastCount = count;
    }
    if (count > 0 && isNearPageBottom() && passiveStableStreak >= 2) {
      loadStatus.mayBeIncomplete = false;
      loadStatus.everFullyLoaded = true;
    }
  }

  // Scrolling straight to the current bottom via scrollTo() is a no-op once
  // already there — the browser doesn't fire a 'scroll' event when the
  // position doesn't change, so Amazon's lazy loader never triggers. Instead
  // we nudge forward in viewport-sized steps (passing through intermediate
  // positions, which also helps any IntersectionObserver-based loader) and
  // explicitly dispatch scroll/wheel events as a fallback for listeners that
  // otherwise wouldn't see a programmatic scroll.
  function nudgeScroll() {
    const before = window.scrollY;
    const target = Math.min(before + window.innerHeight * 0.9, document.documentElement.scrollHeight);
    window.scrollTo(0, target);
    window.dispatchEvent(new Event('scroll', { bubbles: true }));
    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    try {
      window.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: window.innerHeight * 0.9 }));
    } catch (e) {
      // WheelEvent construction can fail in some contexts; scroll events above still fire.
    }
  }

  async function autoScrollToLoadAll() {
    loadStatus.loading = true;
    loadStatus.mayBeIncomplete = false;
    const startY = window.scrollY;

    const maxIterations = 80;
    const stableRoundsNeeded = 3;
    const scrollWaitMs = 700;

    const countNow = () => getAllSavedRows().length;

    let lastCount = countNow();
    loadStatus.foundCount = lastCount;
    let stableRounds = 0;
    let iterations = 0;
    let hitCap = true;

    while (iterations < maxIterations) {
      nudgeScroll();
      await sleep(scrollWaitMs);

      const currentCount = countNow();
      loadStatus.foundCount = currentCount;

      if (currentCount === lastCount) {
        stableRounds++;
        if (stableRounds >= stableRoundsNeeded) {
          hitCap = false;
          break;
        }
      } else {
        stableRounds = 0;
        lastCount = currentCount;
      }
      iterations++;
    }

    window.scrollTo(0, startY);
    loadStatus.loading = false;
    loadStatus.mayBeIncomplete = hitCap;
    loadStatus.everFullyLoaded = true;
    return { count: lastCount, mayBeIncomplete: hitCap };
  }

  // --- Minimal-moves reorder algorithm ------------------------------------
  //
  // The only real operation available is "bump an item" (move to cart, then
  // save for later again), which always re-inserts it at one fixed end of
  // the list (per NEW_SAVE_GOES_TO). Items that are
  // never bumped keep their original relative order.
  //
  // Given current order `cur` and desired order `target` (same set of
  // keys), we want the SMALLEST set of items to bump. Because bumped items
  // always land together at one end, `target` must decompose into:
  //   - a stationary run of untouched items, in their original relative
  //     order, occupying the end opposite the bump destination
  //   - the bumped items occupying the other end, in the order they were
  //     processed
  //
  // We find the longest such stationary run (checked from the "far" end of
  // target inward) and bump everything else.
  function computeBumpPlan(cur, target, direction) {
    const n = target.length;

    if (direction === 'top') {
      // Longest SUFFIX of target that matches, as a subsequence-order,
      // the relative order of those same items in `cur`.
      let bestL = 0;
      for (let L = n; L >= 0; L--) {
        const suffix = target.slice(n - L);
        const suffixSet = new Set(suffix);
        const curFiltered = cur.filter((k) => suffixSet.has(k));
        if (arraysEqual(curFiltered, suffix)) {
          bestL = L;
          break;
        }
      }
      const toBump = target.slice(0, n - bestL); // T[0..k-1], T[0] must end up topmost
      const processOrder = toBump.slice().reverse(); // last processed -> topmost
      return processOrder;
    } else {
      // Longest PREFIX of target that matches the relative order of those
      // items in `cur`.
      let bestL = 0;
      for (let L = n; L >= 0; L--) {
        const prefix = target.slice(0, L);
        const prefixSet = new Set(prefix);
        const curFiltered = cur.filter((k) => prefixSet.has(k));
        if (arraysEqual(curFiltered, prefix)) {
          bestL = L;
          break;
        }
      }
      const toBump = target.slice(bestL); // T[L..n-1], processed in this order
      return toBump.slice();
    }
  }

  function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // --- Applying the order for real ------------------------------------------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForCondition(fn, timeoutMs = 8000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const val = fn();
      if (val) return val;
      await sleep(intervalMs);
    }
    return null;
  }

  // Dispatch a full, bubbling pointer/mouse event sequence rather than just
  // calling .click(), in case the site's handler is bound to mousedown/
  // pointerdown or expects trusted-looking event properties.
  function robustClick(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      try {
        const EventCtor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new EventCtor(type, opts));
      } catch (e) {
        // Fall through — some event types may not be constructible in all contexts.
      }
    });
    // Belt and suspenders: also invoke the native click(), which triggers
    // default actions (e.g. following an <a href>) that dispatchEvent alone
    // does not.
    if (typeof el.click === 'function') el.click();
  }

  // Bump one item: click "Move to cart" on its saved-for-later row, then find
  // it in the cart list and click "Save for later" on it again.
  async function bumpItem(key) {
    const asin = /^[A-Z0-9]{10}$/.test(key) ? key : null;
    const entry = itemsByKey.get(key);
    if (!entry) throw new Error(`Item ${key} no longer on page`);

    const moveToCartLink = findActionLink(entry.rowEl, isMoveToCartElement);
    if (!moveToCartLink) throw new Error(`Could not find "Move to cart" for ${entry.titleText}`);
    robustClick(moveToCartLink);

    const savedLink = await waitForCondition(() => {
      const controls = Array.from(document.querySelectorAll(ACTION_SELECTOR));
      const match = controls.find((el) => {
        if (!isSaveForLaterElement(el)) return false;
        const row = findRowAncestor(el);
        if (!row) return false;
        const rowAsin = extractAsin(row);
        return asin ? rowAsin === asin : extractTitle(row) === entry.titleText;
      });
      return match || null;
    });

    if (!savedLink) {
      throw new Error(`Moved "${entry.titleText}" to cart, but couldn't find its "Save for later" control there — it's stranded in your cart. Check the page's control markup.`);
    }

    robustClick(savedLink);

    const reappeared = await waitForCondition(() => {
      const rows = getAllSavedRows();
      return rows.some((r) => (asin ? extractAsin(r) === asin : extractTitle(r) === entry.titleText)) || null;
    });

    if (!reappeared) {
      throw new Error(`Clicked "Save for later" for "${entry.titleText}" but it never reappeared in the saved list — it may still be stranded in your cart.`);
    }
  }

  // Shared by applyOrder (to actually run) and the SFL_ESTIMATE_ORDER
  // handler (to preview cost without touching the page): given a desired
  // order, works out which items actually need to be bumped and in what
  // sequence.
  function computeBumpSequence(targetKeys) {
    const currentItems = scanItems();
    const currentOrder = currentItems.map((i) => i.key);
    const target = targetKeys.filter((k) => currentOrder.includes(k));
    // Preserve any current items the popup didn't know about (page changed
    // since the popup loaded). Keep them untouched at the end, since the
    // untouched run sits opposite the bump destination.
    const targetSet = new Set(target);
    const leftovers = currentOrder.filter((k) => !targetSet.has(k));
    const fullTarget = NEW_SAVE_GOES_TO === 'top'
      ? target.concat(leftovers)
      : leftovers.concat(target);

    return { sequence: computeBumpPlan(currentOrder, fullTarget, NEW_SAVE_GOES_TO), totalCount: fullTarget.length };
  }

  async function applyOrder(targetKeys) {
    if (status.running) throw new Error('Already applying an order');
    status.running = true;
    status.done = false;
    status.error = null;
    status.cancelled = false;
    cancelRequested = false;

    const { sequence, totalCount } = computeBumpSequence(targetKeys);
    status.total = sequence.length;
    status.current = 0;
    status.estimatedMsPerItem = settings.bumpDelayMs + ESTIMATED_OVERHEAD_PER_ITEM_MS;
    status.estimatedRemainingMs = sequence.length * status.estimatedMsPerItem;

    for (const key of sequence) {
      if (cancelRequested) break;

      // Re-scan before each bump since prior bumps change the DOM/keys map.
      scanItems();
      const entry = itemsByKey.get(key);
      status.message = `Reordering ${status.current + 1}/${sequence.length}: ${entry ? entry.titleText : key}`;
      try {
        await bumpItem(key);
      } catch (err) {
        status.running = false;
        status.error = err.message;
        status.message = `Error: ${err.message}`;
        return;
      }
      status.current++;
      status.estimatedRemainingMs = (sequence.length - status.current) * status.estimatedMsPerItem;
      await sleep(settings.bumpDelayMs);
    }

    status.running = false;
    status.done = true;

    if (cancelRequested) {
      status.cancelled = true;
      status.message = `Cancelled after reordering ${status.current}/${sequence.length} item(s).`;
      return;
    }

    status.message = sequence.length
      ? `Done! Reordered ${sequence.length} item(s) (out of ${totalCount} total).`
      : 'Already in the desired order — nothing to move.';

    if (settings.reloadAfterApply) {
      status.message += ' Refreshing page…';
      await sleep(800);
      location.reload();
    }
  }

  // --- Messaging API for the popup -----------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'SFL_PING') {
      sendResponse({
        isCartPage: looksLikeCartPage(),
        hasSavedItems: !!findSavedForLaterHeading(),
        pageLoading: document.readyState !== 'complete'
      });
      return;
    }

    if (msg.type === 'SFL_GET_ITEMS') {
      const skipScroll = !!msg.skipScroll;
      (async () => {
        if (skipScroll) {
          passiveCompletionCheck();
        }
        const result = skipScroll
          ? { mayBeIncomplete: loadStatus.mayBeIncomplete }
          : await autoScrollToLoadAll();
        sendResponse({ items: scanItems(), mayBeIncomplete: result.mayBeIncomplete });
      })();
      return true; // keep the message channel open for the async response
    }

    if (msg.type === 'SFL_GET_CART_ITEMS') {
      sendResponse({ items: scanCartItems() });
      return;
    }

    if (msg.type === 'SFL_SAVE_FOR_LATER') {
      (async () => {
        try {
          await saveCartItemForLater(msg.key);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    if (msg.type === 'SFL_DELETE_ITEM') {
      if (status.running) {
        sendResponse({ ok: false, error: 'A reorder is in progress.' });
        return;
      }
      (async () => {
        try {
          await deleteSavedItem(msg.key);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    if (msg.type === 'SFL_ADD_TO_CART') {
      if (status.running) {
        sendResponse({ ok: false, error: 'A reorder is in progress.' });
        return;
      }
      (async () => {
        try {
          await addSavedItemToCart(msg.key);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    if (msg.type === 'SFL_GET_LOAD_STATUS') {
      sendResponse({ loadStatus });
      return;
    }

    if (msg.type === 'SFL_GET_STATUS') {
      sendResponse({ status });
      return;
    }

    if (msg.type === 'SFL_ESTIMATE_ORDER') {
      // Preview-only: does not touch the page, just previews how many bumps
      // the given order would take and a rough time estimate for them.
      if (status.running) {
        sendResponse({ count: null, estimatedMs: null });
        return;
      }
      const { sequence } = computeBumpSequence(msg.order || []);
      const estimatedMsPerItem = settings.bumpDelayMs + ESTIMATED_OVERHEAD_PER_ITEM_MS;
      sendResponse({ count: sequence.length, estimatedMs: sequence.length * estimatedMsPerItem });
      return;
    }

    if (msg.type === 'SFL_APPLY_ORDER') {
      pendingOrder = null;
      applyOrder(msg.order || []);
      sendResponse({ started: true });
      return;
    }

    if (msg.type === 'SFL_CANCEL_APPLY') {
      if (status.running) cancelRequested = true;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'SFL_SET_PENDING_ORDER') {
      pendingOrder = msg.order && msg.order.length ? msg.order : null;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'SFL_GET_PENDING_ORDER') {
      sendResponse({ order: pendingOrder });
      return;
    }

    if (msg.type === 'SFL_SET_LAST_TAB') {
      lastPopupTab = msg.tab === 'targets' ? 'targets' : 'saved';
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'SFL_GET_LAST_TAB') {
      sendResponse({ tab: lastPopupTab });
      return;
    }

    if (msg.type === 'SFL_SET_VIEW_STATE') {
      popupViewState = { ...popupViewState, ...msg.state };
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'SFL_GET_VIEW_STATE') {
      sendResponse({ state: popupViewState });
      return;
    }
  });

  // Lets the background worker enable the toolbar icon for this tab. The
  // "Saved for later" section can render well after document_idle, so keep
  // re-checking for a while before giving up (the icon stays greyed out).
  const PAGE_SUPPORT_RETRY_MS = 1000;
  const PAGE_SUPPORT_MAX_TRIES = 15;

  function reportPageSupport(tries = 0) {
    if (looksLikeCartPage()) {
      chrome.runtime.sendMessage({ type: 'SFL_PAGE_SUPPORTED' }).catch(() => {});
      return;
    }
    if (tries + 1 < PAGE_SUPPORT_MAX_TRIES) {
      setTimeout(() => reportPageSupport(tries + 1), PAGE_SUPPORT_RETRY_MS);
    }
  }

  loadSettings();
  reportPageSupport();
})();
