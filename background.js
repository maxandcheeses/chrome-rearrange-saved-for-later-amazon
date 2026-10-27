// Greys out the toolbar icon everywhere except Amazon cart pages. The
// action is disabled by default and enabled per tab only once that tab's
// content script confirms a cart page (looksLikeCartPage in content.js) —
// the same check the popup itself relies on, so the icon is only clickable
// where the popup can actually do something.

chrome.runtime.onInstalled.addListener(() => chrome.action.disable());
chrome.runtime.onStartup.addListener(() => chrome.action.disable());

function enableIfCartPage(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'SFL_PING' }, (res) => {
    // No content script there (non-Amazon page, or not injected yet).
    if (chrome.runtime.lastError) return;
    if (res && res.isCartPage) chrome.action.enable(tabId);
  });
}

// Per-tab enabled state survives navigation, so reset it whenever a tab
// starts loading something new, then re-check once it's done. The re-check
// also covers same-document navigations, where the content script isn't
// re-injected and so can't report in on its own.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') chrome.action.disable(tabId);
  else if (changeInfo.status === 'complete') enableIfCartPage(tabId);
});

// The content script reports in itself too, since Amazon can render the
// "Saved for later" section well after the page has finished loading.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'SFL_PAGE_SUPPORTED' && sender.tab) chrome.action.enable(sender.tab.id);
});
