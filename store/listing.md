# Chrome Web Store listing

Copy for the Developer Dashboard
(chrome.google.com/webstore/devconsole → this item). The listing can't be
updated through the publish API or browser automation (Chrome blocks
extensions on Web Store pages), so paste it in by hand **when the release
that contains these features goes live**, not before — the listing should
never describe features users don't have yet.

Keep this file in sync with the shipped features, like README.md.

---

## Store listing tab

### Summary

Comes from `manifest.json` `description` (132-character limit), not the
dashboard:

> Drag and drop to reorder your Amazon Saved for Later list. Nothing is collected or shared; optional sync uses your Chrome account.

### Description

```text
Amazon gives you no way to rearrange your "Saved for later" list — new saves just pile up at one end. This extension fixes that.

Open it on your Amazon cart page, drag items into the order you want (or type a position number), and click Apply order. The extension rearranges your real Amazon list for you by using Amazon's own "Move to cart" and "Save for later" buttons — it isn't a separate copy.

FEATURES
• Drag and drop, or type a position number to jump an item straight to that spot
• Compact view, or an extended grid/table view for long lists
• Select several items with Shift+click and drag them together
• Undo and redo (⌘Z / Ctrl+Z) while you arrange
• Labels: right-click an item to tag it ("Grocery", "Gifts", "Electronics"…), pick a color for each label, and filter the list by label. Reordering while filtered still keeps your whole list in order.
• Price targets: set one or more target prices per item and get a label added automatically, plus a notification, when the price drops into range. A Price targets tab lists every target with how far each price is from it (checked while the popup is open on your cart)
• Right-click an item to open its product page, see its price history on camelcamelcamel, or delete it from Saved for later
• Load all items: scrolls Amazon's lazy-loaded list for you so nothing is missed
• Your in-progress arrangement survives closing the popup, until you reload or leave the page
• Optional sync: keep your settings, labels and price targets in sync across your computers through your own Chrome account. Off by default; you can sync on demand or delete the synced copy at any time.
• The toolbar icon only lights up on Amazon cart pages, where it can actually do something

PRIVACY
Nothing is ever collected, sold, or sent to the developer or anyone else. Everything runs and is stored locally in your browser. If you turn on sync, your settings, labels and price targets are also stored in your own Chrome account through Chrome's built-in sync — and nowhere else.

GOOD TO KNOW
• Applying an order works by moving items to your cart and back, so it takes a few seconds per item moved.
• Items Amazon marks as unavailable can't be moved, so they're skipped and stay where they are.
• Price targets only check prices while the popup is open on your cart, and only for items still in your Saved for later list — there's no background price tracking.
• Works on Amazon storefronts in many countries. If Amazon changes its cart page, item detection may need an update.

Free and open source: github.com/maxandcheeses/chrome-reorder-saved-for-later-amazon
```

### Screenshots

The current store screenshots (`screenshots/store-screenshot-*.png`)
predate labels, undo/redo, sync and price targets. Regenerate them
(screenshot-generator agent) and upload, ideally including one showing
labels on items with the filter in use, and one of the Price targets tab.

---

## Privacy practices tab

### Single purpose

```text
Lets the user reorder the items in their Amazon "Saved for later" cart list and apply that order to their real Amazon list.
```

### Permission justifications

**storage**

```text
Saves the user's extension settings (delay between actions, default view, etc.) and the labels (and price targets) they put on items, locally in their browser. If the user turns on the optional sync setting, the same settings, labels and price targets (without item thumbnails) are also stored with chrome.storage.sync in their own Chrome account so they appear on their other computers. Nothing is sent to the developer or any third party.
```

**Host permission (content script on Amazon storefront domains)**

```text
The content script runs only on Amazon cart pages to read the list of saved-for-later items shown to the user and, when the user clicks Apply, to click Amazon's own "Move to cart" / "Save for later" buttons to rearrange them. Page content is never stored or sent anywhere.
```

**Background service worker** (not a permission, but reviewers may ask)

```text
Greys out the toolbar icon on pages other than the Amazon cart, and, if the user turned on sync, copies their settings, labels and price targets between local storage and chrome.storage.sync.
```

### Remote code

No, I am not using remote code.

### Data usage

Leave every data category **unchecked**. Synced data goes only to the
user's own Chrome sync account via `chrome.storage.sync`; it is never
transmitted to the developer or a third party, which is what these
categories cover. Keep all three certifications checked (not sold, not
used for unrelated purposes, not used for creditworthiness).

If a reviewer disagrees about the sync data, the closest category is
"Website content" (item IDs and user-made labels), with the explanation
from the storage justification above.
