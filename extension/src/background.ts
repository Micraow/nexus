// Opens the standalone export workbench when the toolbar action is clicked.
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') })
})
