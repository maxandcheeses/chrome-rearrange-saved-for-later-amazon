# Rearrange Saved for Later - Amazon

Chrome (Manifest V3) extension that lets you drag-and-drop (or type a new
position number) to reorder items in Amazon's "Saved for later" cart
section, then applies that order for real on amazon.com by driving the
page's own "Move to cart" / "Save for later" controls to bump items into
place.

No data is ever collected or sent to the developer or any third party —
all state lives in the popup's memory, the content script's in-page
memory, and `chrome.storage.local` (extension settings, plus user-defined
item labels). The one exception is opt-in: with sync turned on, settings
and labels are also copied to `chrome.storage.sync`, i.e. the user's own
Chrome sync account. Keep any privacy wording consistent with that.

## Architecture

- `manifest.json` — MV3 manifest. Content script is injected on all Amazon
  storefront domains listed under `content_scripts.matches`. Popup is
  `popup.html`.
- `background.js` — service worker with two jobs: running the optional
  sync (see "Sync" below), and greying out the toolbar icon off Amazon
  cart pages: the action is disabled by
  default, disabled again per tab whenever it starts loading (per-tab state
  otherwise survives navigation), and enabled per tab when the content
  script confirms a cart page — either by answering an `SFL_PING` sent on
  load `complete`, or by sending `SFL_PAGE_SUPPORTED` itself (it retries
  for ~15s, since the saved section can render late). Must be listed in
  the zip step of `.github/workflows/build.yml` along with the other
  runtime files.
- `theme.js` — loaded in popup.html's `<head>` so the Theme setting (auto /
  light / dark) is applied before first paint: it sets `data-theme` to
  "light" or "dark" on `<html>`, caching the choice in `localStorage` since
  `chrome.storage` is async, and follows the system while on Auto. All
  popup colors are CSS custom properties on `:root`, redefined under
  `:root[data-theme="dark"]` (plus dark `.label-cN` variants) — use the
  tokens, not hex values, for new colors. Must be listed in the zip step
  of `.github/workflows/build.yml`.
- `popup.html` / `popup.js` — the toolbar popup UI. Renders the saved-item
  list, handles drag-and-drop and numeric-position reordering, polls the
  content script for live item snapshots and apply-progress, and stores
  user settings (bump delay, reload-after-apply) via `chrome.storage.local`.
  Manual reordering (drag or typed position) is mirrored to the content
  script as a "pending order" so it survives the popup being closed before
  Apply is hit — Chrome discards all popup JS state on close, there's no
  other way to keep it. `naturalOrder` tracks the order items actually
  appear in on the page (independent of manual reordering) so the "Reset"
  button can revert to it. `mergeItems` only filters/appends onto the
  existing `order`/`naturalOrder` arrays rather than rebuilding them from
  the fresh scan — intentional for incremental lazy-load scans, so
  existing arrangement isn't churned as more items load — but that means
  after a successful Apply, both must be explicitly reset to `[]` before
  the next scan (done in `pollStatus`'s `s.done` branch), otherwise
  `naturalOrder` stays stuck at the pre-apply arrangement and the
  pre-apply estimate (`refreshApplyEstimate`) spuriously shows a nonzero
  ETA even though the page is already in the applied order. There's also a
  race between `pollStatus`'s 800ms poll interval and the page reload
  content.js triggers right after finishing (when reload-after-apply is
  on): if the reload severs the connection before the poll ever sees
  `s.done`, the `SFL_GET_STATUS` call just throws with no further update,
  which used to leave stale "Rearranging N/N…" text stuck on screen
  forever. The catch block now treats a disconnect that happens while
  `applyInProgress` is true as an implicit success (content.js only
  reloads after completing), clears the UI back to normal, and retries
  loading items after a short delay to let the reloaded page's content
  script re-inject.
- Labels (`popup.js`, "Labels" section) — user-defined tags ("Grocery",
  "Electronics"…) applied via right-click on an item, with a filter
  dropdown in both views. An item can have several labels. Labels never
  affect ordering: drag/typed-position reordering while filtered still
  moves items within the full `order`, badges keep showing real positions,
  and Apply always applies the full list. Stored in `chrome.storage.local`
  under `sfl_labels` as `{ labels: [{id, name, color, target?}],
  items: {key: [ids]}, priceRules: {id: rule}, updatedAt }` — keyed by
  item key (the ASIN), so labels follow items across sessions.
  Deliberately chrome.storage rather than content-script memory like
  `pendingOrder`: labels are user-curated data meant to persist, not a
  transient pending action. "Show interposing items" (the toggle next to
  the filter) additionally shows, dimmed, the non-matching items between
  the first and last match; it's display-only, resets whenever the
  filter changes, and is hidden (and switched off) while there are no such
  items (`hasInterposingItems`). While filtered, `#list` keeps the height it last had
  unfiltered (`holdListHeight`), so the popup doesn't shrink to fit a few
  matches. The label editor ("Edit labels…") is transactional:
  `labelEditBefore` holds the state from when it opened, edits preview
  live but skip `saveLabels` and `recordChange`, Done saves them as a
  single undo step (`finishLabelEdit`), and any other dismissal (✕,
  backdrop, Escape — all routed through `dismissDialog`) restores the
  snapshot (`discardLabelEdit`). Closing the popup mid-edit also loses
  them, since nothing was saved.
  Right-click menus (`openItemMenu` for saved items, `openTargetMenu` for
  Price targets rows; built by `openContextMenu`, whose entries carry a leading
  SVG `icon` or a `checked` ✓, plus an optional label-color `swatch`) also offer "Open product page" (`openProductEntry`) and
  "Price history on camelcamelcamel" (`camelEntry`/`camelUrl`, mapped per
  storefront in `CAMEL_HOSTS`, hidden for non-ASIN keys or uncovered
  stores), both opened in a background tab so the popup stays open.
- Price targets (`popup.js`, "Price targets" section) — rules that add a
  label while an item's price is in a range.
  - Data: `priceRules` maps target id (`newTargetId`) to `{ key, labelId,
    min, max, applied, added, muted, dismissedPrice, rank }` plus the item's
    remembered `title`/`url`/`image`/`price`/`priceText`; either bound may
    be null. An item can have several targets (`itemTargetIds`).
    `loadLabels` converts the earlier one-per-item format (keyed by item
    key, no `key` field). Rules live in `sfl_labels`, so they're saved,
    synced and undone with labels: part of `snapshotState`, and every user
    edit is an undo step, but automatic (re)labeling isn't.
  - Prices: `content.js` scrapes each saved row (`extractPrice`/
    `parsePrice`: locale-aware separators, skips struck-through
    `.a-text-price`) into the item's `price`/`priceText`. `applyPriceRules`
    runs after every scan (`fetchItems` and the watcher) — so only while the
    popup is open on the cart; no background checking. `applied` = fired for
    the current in-range stretch (a label removed by hand stays off until
    the price leaves and re-enters); `added` = the target put the label on,
    so it only removes labels it added, and not while another applied
    target of the item holds the same label (`labelHeldByOtherTarget`).
    `rememberRuleItem` copies item details onto the rule when they change
    (links shortened to `/dp/<ASIN>` by `shortProductUrl`) so off-page
    targets can still be shown — the only price data stored.
  - Price-target labels (`priceTargetLabelIds`: labels created with
    `target: true` — from the targets tab's dropdown "＋ New label…" or the
    dialog's "New label…" — plus any a rule uses) are kept apart from
    general ones: their own optgroup in both filter dropdowns, their own
    section of the label editor (first when opened from the targets tab;
    rows reorder within a section only), first in the target dialog, and
    left out of the item right-click menu. Deleting a label retargets or
    drops rules pointing to it.
  - Saved list: each target is a pill with its target price among the label
    chips (`makePriceTags`; label and current price on hover), and its label
    isn't repeated as a chip. Notifications (`renderPriceAlerts`, both
    views) are in-popup cards per in-range target, not `chrome.notifications`:
    "Dismiss" stores `dismissedPrice` (cleared on any price change), "Don't
    show again" sets `muted` (the dialog's "Notify me" clears it).
  - Price targets tab (`renderPriceTargets`, called from `renderList`): one
    row per target, shown only while a rule exists (`#tabBar` and its grid
    copy `#tabBarModal`); `body.tab-targets` hides the saved-list UI.
    Clicking a row (outside its title link) opens `openPriceRuleDialog`
    for it.
    "On the page" = in `order`, so not-yet-lazy-loaded items count as
    off-page — hence the footer's own Load all banner, shown only while
    some target's item is off-page (`body.targets-off-page`). Rows are in the
    user's order (drag; `moveTarget`), kept as `rank` on each rule so it
    syncs; rules without one sort last. Its filter (`targetFilter`: status,
    `label:<id>` for a target's own label, `item:<id>` for a general label
    on its item) is display-only like `labelFilter`. Both tabs' dropdowns
    share one layout (`appendLabelGroups` / `appendFilterActions` /
    `onFilterAction`: fixed filters, Labels and Price target labels groups,
    then "＋ New label…" and "✎ Edit labels…").
  - Layout parity: the targets dropdown (`.targetsFilter`) lives inside the
    saved tab's own `.labelBar`s (fixed 24px tall), `#targetsHint` (a
    summary given `#msg`'s height on switch) sits in `#msg`'s slot, and the
    compact targets list is sized on switch so the popup keeps its height
    (`setActiveTab`, measuring content height since the popup caps at
    600px). In the grid view, `#targetsListModal` mirrors `#tileGrid` —
    cards in the same zoomable grid, or its table view (`setTableView`
    toggles both) — and the footer (`#targetsFooterModal`, with the Load all
    banner and help text) takes `#gridModalFooter`'s height
    (`matchTargetsFooterHeight`). The compact footer (`#targetsFooter`) is
    sticky so it's always visible.
  - Sync: rules are chunked under `sfl_labels_rules_<n>` (counted by
    `ruleChunks` on the meta item). To fit more in sync's 100 KB, they go up
    without `image` (`SYNC_SKIPPED_RULE_FIELDS`); whoever takes the synced
    copy (background `reconcile`, or "Synced" when turning sync on) merges
    its own images back in (`withLocalRuleFields`), so they aren't lost and
    re-uploaded in a loop between computers.
- Undo/redo (`popup.js`, "Undo / redo" section) — snapshots of the
  arrangement and labels taken before each change (`recordChange`), bound
  to the toolbar buttons and ⌘Z / Ctrl+Z, ⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y
  (ignored while typing in a field or with a dialog open). Kept by the
  page until it reloads (view memory, below), and cleared after a successful Apply since the page's real order
  has moved on. `restoreState` reconciles against the items currently
  loaded: unknown items keep their place at the end, vanished ones drop.
- Multi-select (`popup.js`, "Multi-select" section) — platform-standard
  clicks: ⌘+click (Mac) / Ctrl+click (Windows, Linux) toggles an item,
  Shift+click selects the range from the anchor (⌘/Ctrl+Shift adds it to
  the selection), plain click highlights just that item, and a click on
  empty list space or Escape clears it; dragging any selected item moves the whole
  selection as one block. Display-only, kept until the page reloads (view
  memory, below), and pruned when the label filter hides selected items.
- Custom tooltips (`setupTooltips`) replace Chrome's slow native ones for
  every element with a `title`; code keeps setting `.title` as usual.
- Sync (`storage.js`, plus `background.js` and the "Sync" section of
  `popup.js`) — opt-in, per computer (`sfl_sync` in local storage).
  Everything keeps reading and writing `chrome.storage.local`; the
  background worker mirrors `sfl_settings` and `sfl_labels` to and from
  `chrome.storage.sync`, copying whichever side has the newer `updatedAt`
  (stamped by `saveSettings`/`saveLabels`), debounced to respect sync's
  write limits. Labels are split into ≤7 KB chunks in sync (8 KB per-item
  quota); each chunk carries its save's `updatedAt` so half-arrived saves
  are ignored. Timestamps are each computer's own clock (`Date.now()`), so
  a computer whose clock runs fast wins ties it shouldn't. `reconcile`
  re-reads the local copy just before writing the synced one in and skips
  any key saved meanwhile, so a sync can't overwrite an edit made during
  it. In the popup, synced labels arriving mid-edit set
  `labelsChangedElsewhere`: discarding the editor then loads them rather
  than saving the old snapshot over them (Done still wins, as the newest
  save), and any synced labels arriving clear undo/redo, whose snapshots
  would put the old labels back.
  The checkbox is *automatic* sync (`enabled` in the flag);
  "Sync now" works with it off too, sending `SFL_SYNC_NOW` with
  `manual: true` so `reconcile` runs regardless, and waits for the result.
  The first time a computer syncs (turning automatic sync on, or a Sync
  now while not `joined`), differing labels on both sides ask which to
  keep (`settleSyncConflict`); after that `joined` is set and newer wins.
  Sync errors (quota) land in `sfl_sync_status` and show under the toggle,
  along with the last sync time ("Not synced yet" before any) — also
  shown, while automatic sync is on, as a `.syncBadge` in both views'
  headers (`renderSyncBadges`, fed by `renderSyncStatus`; click opens
  settings). "Delete synced data…" turns sync off here (and clears
  `joined`), then `deleteSynced` writes an `sfl_sync_deleted` marker
  *before* removing the rest. Any computer whose automatic sync was
  enabled (`enabledAt` in the flag) before that marker turns it off in
  `reconcile` instead of uploading its copy again; a manual sync uploads
  anyway and moves `enabledAt` past the marker.
  `storage.js` is loaded by both popup.html and
  `importScripts` in the worker, so it must not redeclare popup.js
  globals, and it must be in the build zip.
- `content.js` — injected into the Amazon cart page. Scans the DOM for
  saved-for-later rows (`scanItems`), optionally auto-scrolls to force lazy
  loading of the full list (`autoScrollToLoadAll`), computes a bump plan to
  reach a target order (`computeBumpPlan`), and executes it by clicking
  Amazon's real "Move to cart" / "Save for later" buttons per item
  (`bumpItem`, `applyOrder`). Both `applyOrder` (live countdown while
  running, `status.estimatedRemainingMs`) and the `SFL_ESTIMATE_ORDER`
  handler (pre-apply preview, doesn't touch the page) share
  `computeBumpSequence` and estimate cost as bump-plan length × (configured
  delay + a fixed `ESTIMATED_OVERHEAD_PER_ITEM_MS` allowance for the
  per-item DOM-wait steps) — it's a guess, not measured, since those waits
  aren't on a fixed timer. In `popup.js`, `formatEta` renders it: as soon
  as the order changes (drag/typed position), `scheduleApplyEstimate`
  debounces a `SFL_ESTIMATE_ORDER` call and shows "~Ns to apply" under the
  Apply button; once Apply is clicked, `pollStatus` takes over and shows
  the live "~Ns remaining" countdown instead, clearing back to nothing
  when done. While it runs, `setCancelVisible` also sets `body.applying`,
  which shows a "don't leave or reload the Amazon page" warning
  (`#applyWarning`, `#modalApplyWarning` in the Extended view footer). Also holds the in-memory `pendingOrder` — the
  not-yet-applied manual reorder — deliberately kept here instead of
  `chrome.storage.local`: this script is destroyed and re-injected fresh on
  every page reload/navigation/tab close, so `pendingOrder` resets to
  `null` automatically exactly when the page session resets, instead of
  silently reapplying a stale order later. It's cleared as soon as
  `SFL_APPLY_ORDER` is received (the applied order becomes the new natural
  order). Communicates with `popup.js` over `chrome.runtime.onMessage`
  using message types prefixed `SFL_*` (`SFL_PING`, `SFL_GET_ITEMS`,
  `SFL_GET_LOAD_STATUS`, `SFL_GET_STATUS`, `SFL_APPLY_ORDER`,
  `SFL_SET_PENDING_ORDER`, `SFL_GET_PENDING_ORDER`, `SFL_DELETE_ITEM`, `SFL_ADD_TO_CART`,
  `SFL_SET_LAST_TAB`, `SFL_GET_LAST_TAB`, `SFL_SET_VIEW_STATE`,
  `SFL_GET_VIEW_STATE`).
  `SFL_SET_LAST_TAB`/`SFL_GET_LAST_TAB` hold which popup
  tab (Saved for later / Price targets) the user was on, in content-script
  memory like `pendingOrder`, so reopening the popup returns there until
  the page reloads (`restoreLastTab`, once per popup opening).
  `SFL_SET_VIEW_STATE` / `SFL_GET_VIEW_STATE` do the same for the rest of
  the popup's view ("View memory" in `popup.js`): label/target filters and
  "Show interposing items", the selection, undo/redo history, and scroll
  positions — not which view is open: the popup always opens in the
  Default view setting, and the expand / collapse buttons (`.viewSwitchBtn`) only switch until it closes (each scroller in `SCROLLER_IDS`). The
  popup saves each part as it changes (`saveViewState`; a popup can't
  save on close, and scrolling is debounced) and `restoreViewState` puts
  them back before the last tab, once per opening. Nothing is saved until
  that restore has run, so start-up rendering can't overwrite it. Labels
  deleted or items gone since are dropped on restore. A scroller hidden at
  restore (the grid in compact view, a tab not shown) keeps its position
  in `pendingScroll` until `setGridMode`/`setActiveTab` shows it. A position
  also stays pending until it's actually reached (the list may still be
  short while items arrive), retried after each `renderList` for
  `SCROLL_RESTORE_WINDOW_MS`; a scroll event that lands at the bottom
  while a position is pending is a short-list clamp, not saved. Only the
  showing view's scrollers (`COMPACT_SCROLLERS` / `GRID_SCROLLERS`) save,
  since the other's only move from layout (hiding the grid resets it; the
  compact content reflows behind the grid), and `restoreViewScroll` puts
  the shown view's positions back on every `setGridMode` and `setActiveTab`
  (a hidden list never saves: hiding resets its scroll). Settings
  that should outlast a reload (tile size, table view, default view,
  theme) stay in `sfl_settings` instead.
  `SFL_DELETE_ITEM` (from the item right-click menu, `openItemMenu` in
  `popup.js`) clicks Amazon's "Delete" control on a saved row
  (`isDeleteElement` — matches whole control text, not substrings, since
  short phrases like "sil" appear in product titles) and waits for the
  row to vanish. It's permanent on Amazon, so it's confirmed first and
  sits outside undo/redo; the popup just rescans and `mergeItems` drops
  the key. `deleteRunning` keeps a delete and a reorder (or two deletes)
  from driving the page at once, and `SFL_APPLY_ORDER` replies
  `{ started: false, error }` instead of starting a second reorder.
  `SFL_ADD_TO_CART` (item menu, "Add to cart (keep in Saved for later)",
  `addSavedItemToCart` in both files) puts an item in the cart *without*
  "Move to cart", which would take it out of Saved for later: it fetches
  `/dp/<ASIN>`, submits that page's `form#addToCart` to its Add to Cart
  button's `formaction` (the form's own `action` 404s), minus `isBuyNow`
  and plus `submit.add-to-cart`, with the user's own session, then re-fetches
  the cart to confirm (`#sc-active-cart [data-asin]` or `getAllCartRows`
  on the fetched document). The live page isn't updated until reload.
  ASIN keys only; refused if the item is already in the cart. Caveat: an
  Apply that bumps such an item after a reload moves the cart line back
  to Saved for later, since a bump's "Save for later" acts on it.
- `content.css` — minimal styling injected alongside the content script.
- `icons/` — extension icons at 16/32/48/128px, generated from a single
  source image via `sips`. Regenerate all four sizes together if the icon
  changes; don't hand-edit individual sizes.

## Notes for future changes

- `store/listing.md` holds the Chrome Web Store listing copy and Privacy
  practices answers. The dashboard can't be updated by API or browser
  automation, so it's pasted in by hand at release time. Update it with
  any user-facing feature or data-handling change; the summary line is
  `manifest.json`'s `description` (≤132 chars).

- Amazon's DOM structure for the cart page is not versioned or documented
  anywhere — `content.js`'s selectors are inherently fragile scraping logic
  tied to Amazon's current markup. If reordering stops working, that's the
  first place to check against the live page.
- The extension reorders by simulating real user actions (moving items to
  cart and back to saved-for-later) because Amazon has no API for
  reordering saved items directly — there is no shortcut around this.
- Items marked "Currently unavailable" or "This item is no longer
  available from the seller you selected" have no working "Move to cart"
  control, which `getCandidateItemRows` (`content.js`) requires to detect a
  row at all — see `isMoveToCartElement`. These items are therefore
  invisible to the extension entirely: never scanned, never shown in the
  popup, never bumped, and left wherever they sit in Amazon's real list
  when applying an order around them. Documented for users in `README.md`.
- Popup CSS intentionally matches Amazon's own visual language (yellow
  primary CTA `#ffd814`, navy `#0f1111`/`#232f3e`, pill-shaped buttons,
  `#e77600` orange accents) — keep new UI consistent with that palette.
