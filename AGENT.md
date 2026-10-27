# Reorder Saved for Later - Amazon

Chrome (Manifest V3) extension that lets you drag-and-drop (or type a new
position number) to reorder items in Amazon's "Saved for later" cart
section, then applies that order for real on amazon.com by driving the
page's own "Move to cart" / "Save for later" controls to bump items into
place.

No data is collected, stored remotely, or transmitted anywhere — all state
lives in the popup's memory, the content script's in-page memory, and
`chrome.storage.local` (extension settings, plus user-defined item labels).

## Architecture

- `manifest.json` — MV3 manifest. Content script is injected on all Amazon
  storefront domains listed under `content_scripts.matches`. Popup is
  `popup.html`.
- `background.js` — minimal service worker whose only job is greying out
  the toolbar icon off Amazon cart pages: the action is disabled by
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
  under `sfl_labels` as `{ labels: [{id, name, color}], items: {key: [ids]} }`
  — keyed by item key (the ASIN), so labels follow items across sessions.
  Deliberately chrome.storage rather than content-script memory like
  `pendingOrder`: labels are user-curated data meant to persist, not a
  transient pending action. "Show interposing items" (the toggle next to
  the filter) additionally shows, dimmed, the non-matching items between
  the first and last match; it's display-only and resets whenever the
  filter changes.
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
  `SFL_SET_PENDING_ORDER`, `SFL_GET_PENDING_ORDER`).
- `content.css` — minimal styling injected alongside the content script.
- `icons/` — extension icons at 16/32/48/128px, generated from a single
  source image via `sips`. Regenerate all four sizes together if the icon
  changes; don't hand-edit individual sizes.

## Notes for future changes

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
