# Reorder Saved for Later - Amazon

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
  which used to leave stale "Reordering N/N…" text stuck on screen
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
  the first and last match; it's display-only and resets whenever the
  filter changes. The label editor ("Edit labels…") is transactional:
  `labelEditBefore` holds the state from when it opened, edits preview
  live but skip `saveLabels` and `recordChange`, Done saves them as a
  single undo step (`finishLabelEdit`), and any other dismissal (✕,
  backdrop, Escape — all routed through `dismissDialog`) restores the
  snapshot (`discardLabelEdit`). Closing the popup mid-edit also loses
  them, since nothing was saved.
  Right-click menus (`openItemMenu` for saved items, `openTargetMenu` for
  Price targets rows; built by `openContextMenu`, whose entries can carry an
  SVG `icon`) also offer "Open product page" (`openProductEntry`) and
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
    "On the page" = in `order`, so not-yet-lazy-loaded items count as
    off-page — hence the footer's own Load all banner. Rows are in the
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
  (ignored while typing in a field or with a dialog open). Popup memory
  only, and cleared after a successful Apply since the page's real order
  has moved on. `restoreState` reconciles against the items currently
  loaded: unknown items keep their place at the end, vanished ones drop.
- Multi-select (`popup.js`, "Multi-select" section) — Shift+click toggles
  items into a selection; dragging any selected item moves the whole
  selection as one block. Display-only, never persisted, and pruned when
  the label filter hides selected items.
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
  are ignored. Turning sync on with differing labels on both sides asks
  which to keep. Sync errors (quota) land in `sfl_sync_status` and show
  under the toggle, along with the last sync time. "Sync now" sends
  `SFL_SYNC_NOW` and waits for the reconcile's result. "Delete synced
  data…" turns sync off here, then `deleteSynced` writes an
  `sfl_sync_deleted` marker *before* removing the rest. Any computer whose
  sync was enabled (`enabledAt` in the flag) before that marker turns its
  own sync off in `reconcile` instead of uploading its copy again.
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
  when done. Also holds the in-memory `pendingOrder` — the
  not-yet-applied manual reorder — deliberately kept here instead of
  `chrome.storage.local`: this script is destroyed and re-injected fresh on
  every page reload/navigation/tab close, so `pendingOrder` resets to
  `null` automatically exactly when the page session resets, instead of
  silently reapplying a stale order later. It's cleared as soon as
  `SFL_APPLY_ORDER` is received (the applied order becomes the new natural
  order). Communicates with `popup.js` over `chrome.runtime.onMessage`
  using message types prefixed `SFL_*` (`SFL_PING`, `SFL_GET_ITEMS`,
  `SFL_GET_LOAD_STATUS`, `SFL_GET_STATUS`, `SFL_APPLY_ORDER`,
  `SFL_SET_PENDING_ORDER`, `SFL_GET_PENDING_ORDER`, `SFL_DELETE_ITEM`,
  `SFL_SET_LAST_TAB`, `SFL_GET_LAST_TAB`). The last two hold which popup
  tab (Saved for later / Price targets) the user was on, in content-script
  memory like `pendingOrder`, so reopening the popup returns there until
  the page reloads (`restoreLastTab`, once per popup opening).
  `SFL_DELETE_ITEM` (from the item right-click menu, `openItemMenu` in
  `popup.js`) clicks Amazon's "Delete" control on a saved row
  (`isDeleteElement` — matches whole control text, not substrings, since
  short phrases like "sil" appear in product titles) and waits for the
  row to vanish. It's permanent on Amazon, so it's confirmed first and
  sits outside undo/redo; the popup just rescans and `mergeItems` drops
  the key.
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
