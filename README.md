# Reorder Saved for Later - Amazon

A Chrome extension that lets you drag-and-drop (or type a position number)
to reorder the items in your Amazon "Saved for later" list, then applies
that order for real on amazon.com.

No data is ever collected, shared, or sent to the developer or anyone
else. Everything happens and is stored locally in your browser — unless
you turn on the optional sync, which stores your settings and labels in
your own Chrome account (see [Settings](#settings)).

![Popup screenshot](screenshots/store-screenshot-1.png)

| Idle | Reordering in progress |
| --- | --- |
| ![Popup idle state](screenshots/popup.png) | ![Popup mid-reorder, with Cancel button](screenshots/popup-reorder-in-progress.png) |

## Why

Amazon has no way to reorder saved-for-later items — new saves always land
at one end of the list, and there's no drag handle or API for rearranging
them. This extension works around that by driving Amazon's own "Move to
cart" / "Save for later" controls to bump items into the position you want.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable "Developer mode" (top right).
4. Click "Load unpacked" and select this project's folder.
5. Pin the extension for easy access.

## Usage

1. Go to your Amazon cart page and scroll down to "Saved for later".
2. Click the extension icon.
3. Drag items to reorder them, or type a number into an item's position
   badge to jump it to that spot — everything below it shifts down
   automatically.
4. Click **Load all items** if you have more saved items than Amazon has
   currently loaded on the page (shown by the "may be incomplete" banner).
5. Click **Apply order** to have the extension actually rearrange the items
   on Amazon by bumping them through Move to cart / Save for later.
6. If you close the popup before applying, your in-progress arrangement is
   preserved as long as you don't reload or navigate away from the page —
   reopening the popup restores it. Reloading/navigating/closing the tab
   resets it back to the page's real order, and the **Reset** button lets
   you do that manually too.
7. Use the undo/redo buttons (or ⌘Z / Ctrl+Z and ⇧⌘Z / Ctrl+Y) to step
   back and forth through your changes before applying.
8. Shift+click several items to select them, then drag any one of them to
   move the whole group together.

The toolbar icon is greyed out except on Amazon cart pages, where the
extension can actually do something.

## Labels

Right-click an item to tag it with labels like "Grocery" or "Electronics"
(click **＋ Label** to create one). An item can have several labels. Use the
filter dropdown to show only items with a given label — reordering while
filtered still moves items within your full list, and **Apply order**
always applies the whole list. Turn on "Show interposing items" to also
see, dimmed, the unlabeled items sitting between your filtered ones.
Pick **Edit labels…** in the dropdown to rename, recolor, reorder, or delete
labels — click **Done** to save your edits, or close the editor (✕, click
outside, or Escape) to discard them. Labels are saved locally in your browser and stick to items
across sessions.

## Settings

Click the ⚙ button to adjust:
- **Delay between actions** — how long to wait between each bump step.
  Increase this if Amazon's page feels slow to respond and items get
  missed or duplicated.
- **Refresh the page after applying the order** — reloads the page once
  reordering finishes, so you see the final result immediately.
- **Sync settings and labels across your computers** — off by default.
  When on, your settings and labels are kept in sync through your own
  Chrome account, on every computer where you're signed into Chrome with
  extension sync enabled and have this turned on. Nothing goes to the
  developer or anyone else. If both this computer and your Chrome account
  already have different labels when you turn it on, you'll be asked which
  to keep; after that, the most recent change wins. Chrome limits synced
  data to 100 KB, which is a few thousand labeled items; past that, labels
  keep working on each computer but stop syncing. Your in-progress
  arrangement is never synced.
  - **Sync now** syncs right away instead of waiting for the next change.
  - **Delete synced data…** removes your settings and labels from your
    Chrome account and turns sync off on all your computers. Each computer
    keeps its own copy, and you can turn sync back on later.

## Limitations

- **Unavailable items are skipped.** Items marked "Currently unavailable"
  or "This item is no longer available from the seller you selected"
  don't have a working "Move to cart" control, which is what the
  extension relies on to detect and move saved items. These items won't
  show up in the extension's list at all, can't be reordered, and will
  stay wherever they currently sit in your real saved-for-later list.
- Reordering works by actually moving items to your cart and back, so it
  takes a few seconds per item — the more items you reorder, the longer
  Apply takes.
- Amazon's page markup isn't versioned or guaranteed stable; if Amazon
  changes their cart page layout, item detection may need updating.

## Support

If this saved you some tedious clicking, you can
[buy me a coffee](https://www.buymeacoffee.com/maxwellluong).

## Project

[github.com/maxandcheeses/chrome-reorder-saved-for-later-amazon](https://github.com/maxandcheeses/chrome-reorder-saved-for-later-amazon)
