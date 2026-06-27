const { app, BrowserWindow, WebContentsView, ipcMain, Menu, clipboard, dialog, session, shell } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const Database = require('better-sqlite3');

const CDP_PORT = parseInt(process.env.NORI_BROWSER_CDP_PORT || '19222');
const CONTROL_PORT = parseInt(process.env.NORI_BROWSER_CONTROL_PORT || '0');
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));

function getChromeUserDataDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    case 'linux':
      return path.join(os.homedir(), '.config', 'google-chrome');
    default:
      return null;
  }
}

function isChromeRunning(userDataDir) {
  const lockPath = path.join(userDataDir, 'SingletonLock');
  try {
    const target = fs.readlinkSync(lockPath);
    const pid = parseInt(target.split('-').pop(), 10);
    if (!isNaN(pid)) {
      process.kill(pid, 0);
      return true;
    }
  } catch {}
  return false;
}

function resolveProfileDir() {
  const envDir = process.env.NORI_BROWSER_PROFILE_DIR;
  if (envDir !== undefined) {
    if (!envDir) return null;
    fs.mkdirSync(envDir, { recursive: true });
    return envDir;
  }
  const chromeDir = getChromeUserDataDir();
  if (!chromeDir || !fs.existsSync(chromeDir)) return null;
  if (isChromeRunning(chromeDir)) {
    process.stderr.write('nori-browser: Chrome is running, using default profile instead\n');
    return null;
  }
  return chromeDir;
}

const profileDir = resolveProfileDir();
let cachedHistoryPath = null;
if (profileDir) {
  const histSrc = path.join(profileDir, 'Default', 'History');
  if (fs.existsSync(histSrc)) {
    cachedHistoryPath = path.join(os.tmpdir(), `nori-history-${process.pid}.db`);
    try {
      fs.copyFileSync(histSrc, cachedHistoryPath);
      const walSrc = histSrc + '-wal';
      if (fs.existsSync(walSrc)) fs.copyFileSync(walSrc, cachedHistoryPath + '-wal');
    } catch {}
  }
  app.setPath('userData', profileDir);
}

let mainWindow;
let ptyProcess;
let launchDir = null;
let controlServer;
let controlSockets = new Set();
let sidebarWidth = 400;
let savedSidebarWidth = 400;
let sidebarVisible = true;
const TOOLBAR_HEIGHT = 48;
const TAB_BAR_HEIGHT = 36;
let omnibarOpen = false;
let omnibarPopup = null;

let tabs = [];
let activeTabId = null;
let nextTabId = 1;
const MAX_CLOSED_TABS = 25;
let closedTabStack = [];

const ZOOM_FACTORS = [0.25, 0.333, 0.5, 0.667, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];
let downloads = new Map();
let nextDownloadId = 1;
let lastFindText = '';

app.whenReady().then(async () => {
  await resolveLaunchDir();
  createWindow();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: !process.env.NORI_BROWSER_HEADLESS,
    title: 'Nori Browser',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', updateAllTabBounds);
  mainWindow.on('resize', updateAllTabBounds);
  mainWindow.on('maximize', () => {
    updateAllTabBounds();
    setTimeout(updateAllTabBounds, 100);
  });
  mainWindow.on('unmaximize', () => {
    updateAllTabBounds();
    setTimeout(updateAllTabBounds, 100);
  });
  mainWindow.on('enter-full-screen', updateAllTabBounds);
  mainWindow.on('leave-full-screen', updateAllTabBounds);

  mainWindow.webContents.once('did-finish-load', () => {
    createTab('about:blank');
    mainWindow.webContents.send('cdp-port', CDP_PORT);
  });

  function interceptToggleShortcut(event, input) {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'j' && input.type === 'keyDown') {
      event.preventDefault();
      handleToggleSidebar();
    }
  }
  mainWindow.webContents.on('before-input-event', interceptToggleShortcut);

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab('about:blank') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => { if (activeTabId !== null) closeTab(activeTabId); } },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => reopenClosedTab() },
        { type: 'separator' },
        { label: 'Print', accelerator: 'CmdOrCtrl+P', click: () => { const v = getActiveView(); if (v) v.webContents.print(); } },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoomIn() },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoomOut() },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => resetZoom() },
        { type: 'separator' },
        { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('show-find-bar'); } },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: 'F11', click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
        { type: 'separator' },
        { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => { const v = getActiveView(); if (v) v.webContents.toggleDevTools(); } },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => switchToNextTab() },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => switchToPrevTab() },
        { label: 'Move Tab Right', accelerator: 'Ctrl+Shift+PageDown', click: () => moveTabRight() },
        { label: 'Move Tab Left', accelerator: 'Ctrl+Shift+PageUp', click: () => moveTabLeft() },
        { type: 'separator' },
        ...Array.from({ length: 8 }, (_, i) => ({
          label: `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => { if (i < tabs.length) switchTab(tabs[i].id); },
        })),
        { label: 'Last Tab', accelerator: 'CmdOrCtrl+9', click: () => { if (tabs.length > 0) switchTab(tabs[tabs.length - 1].id); } },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  // Downloads
  session.defaultSession.on('will-download', (event, item) => {
    const id = String(nextDownloadId++);
    downloads.set(id, item);

    item.on('updated', (_, state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', {
          id,
          filename: item.getFilename(),
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          percentComplete: item.getPercentComplete(),
          bytesPerSecond: item.getCurrentBytesPerSecond(),
          state,
          isPaused: item.isPaused(),
        });
      }
    });

    item.once('done', (_, state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-done', {
          id,
          filename: item.getFilename(),
          path: item.getSavePath(),
          state,
        });
      }
    });
  });

  // Permissions — deny by default, allow safe ones
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') {
      callback(true);
      return;
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') {
      return true;
    }
    return false;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (ptyProcess) ptyProcess.kill();
  });
}

function createTab(url, insertIndex) {
  const id = String(nextTabId++);
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.contentView.addChildView(view);
  view.setVisible(false);

  const tab = { id, view, title: 'New Tab', url: url || 'about:blank', pinned: false, favicon: '', isLoading: false, isHtmlFullScreen: false };
  if (insertIndex !== undefined && insertIndex >= 0 && insertIndex <= tabs.length) {
    tabs.splice(insertIndex, 0, tab);
  } else {
    tabs.push(tab);
  }

  view.webContents.on('did-navigate', (_, navUrl) => {
    tab.url = navUrl;
    if (activeTabId === id && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('url-changed', navUrl);
    }
    sendTabsChanged();
  });

  view.webContents.on('did-navigate-in-page', (_, navUrl) => {
    tab.url = navUrl;
    if (activeTabId === id && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('url-changed', navUrl);
    }
    sendTabsChanged();
  });

  view.webContents.on('page-title-updated', (_, title) => {
    tab.title = title;
    if (activeTabId === id && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`${title} — Nori Browser`);
    }
    sendTabsChanged();
  });

  view.webContents.on('page-favicon-updated', (_, favicons) => {
    tab.favicon = favicons[0] || '';
    sendTabsChanged();
  });

  view.webContents.on('did-start-loading', () => {
    tab.isLoading = true;
    sendTabsChanged();
  });

  view.webContents.on('did-stop-loading', () => {
    tab.isLoading = false;
    sendTabsChanged();
  });

  view.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      tab.favicon = '';
      sendTabsChanged();
    }
  });

  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const cmdOrCtrl = input.control || input.meta;
    if (cmdOrCtrl && input.key.toLowerCase() === 'j') {
      event.preventDefault();
      handleToggleSidebar();
    }
    if (cmdOrCtrl && input.shift && input.key.toLowerCase() === 'i') {
      event.preventDefault();
      view.webContents.toggleDevTools();
    }
    if (input.key === 'F12') {
      event.preventDefault();
      view.webContents.toggleDevTools();
    }
    if (cmdOrCtrl && input.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('show-find-bar');
      }
    }
    if (cmdOrCtrl && (input.key === '=' || input.key === '+')) {
      event.preventDefault();
      zoomIn();
    }
    if (cmdOrCtrl && input.key === '-') {
      event.preventDefault();
      zoomOut();
    }
    if (cmdOrCtrl && input.key === '0') {
      event.preventDefault();
      resetZoom();
    }
    if (input.key === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
    if (cmdOrCtrl && input.key.toLowerCase() === 'p') {
      event.preventDefault();
      view.webContents.print();
    }
  });

  view.webContents.on('context-menu', (event, params) => {
    const menuTemplate = [];

    if (params.linkURL) {
      menuTemplate.push(
        { label: 'Open Link in New Tab', click: () => createTab(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }

    if (params.mediaType === 'image') {
      menuTemplate.push(
        {
          label: 'Save Image As...', click: async () => {
            const result = await dialog.showSaveDialog(mainWindow, {
              defaultPath: params.suggestedFilename || 'image.png',
            });
            if (!result.canceled && result.filePath) {
              session.defaultSession.once('will-download', (_, item) => {
                item.setSavePath(result.filePath);
              });
              session.defaultSession.downloadURL(params.srcURL);
            }
          }
        },
        { label: 'Copy Image', click: () => view.webContents.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' }
      );
    }

    if (params.selectionText.trim()) {
      menuTemplate.push(
        { role: 'copy' },
        {
          label: `Search Google for "${params.selectionText.trim().substring(0, 30)}"`,
          click: () => createTab(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`)
        },
        { type: 'separator' }
      );
    }

    if (params.isEditable) {
      menuTemplate.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
        { type: 'separator' }
      );
    }

    menuTemplate.push(
      { label: 'Back', enabled: view.webContents.canGoBack(), click: () => view.webContents.goBack() },
      { label: 'Forward', enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() },
      { label: 'Reload', click: () => view.webContents.reload() },
      { type: 'separator' },
      { label: 'Inspect Element', click: () => view.webContents.inspectElement(params.x, params.y) }
    );

    const menu = Menu.buildFromTemplate(menuTemplate);
    menu.popup();
  });

  view.webContents.on('found-in-page', (event, result) => {
    if (result.finalUpdate && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('find-results', {
        current: result.activeMatchOrdinal,
        total: result.matches,
      });
    }
  });

  view.webContents.on('update-target-url', (event, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status-bar-url', url);
    }
  });

  view.webContents.on('enter-html-full-screen', () => {
    tab.isHtmlFullScreen = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fullscreen-changed', true);
      const [width, height] = mainWindow.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height });
    }
  });

  view.webContents.on('leave-html-full-screen', () => {
    tab.isHtmlFullScreen = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fullscreen-changed', false);
      setTabBounds(view);
    }
  });

  view.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      title: 'Leave site?',
      message: 'Changes you made may not be saved.',
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      event.preventDefault();
    }
  });

  view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    createTab(openUrl);
    return { action: 'deny' };
  });

  setTabBounds(view);
  switchTab(id);
  view.webContents.loadURL(url || 'about:blank');

  return id;
}

function closeTab(tabId) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;

  const tab = tabs[idx];
  closedTabStack.push({ url: tab.url, title: tab.title, index: idx });
  if (closedTabStack.length > MAX_CLOSED_TABS) closedTabStack.shift();

  mainWindow.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    mainWindow.close();
    return;
  }

  if (activeTabId === tabId) {
    const newIdx = Math.min(idx, tabs.length - 1);
    switchTab(tabs[newIdx].id);
  } else {
    sendTabsChanged();
  }
}

function switchTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  if (activeTabId !== null) {
    const oldTab = tabs.find(t => t.id === activeTabId);
    if (oldTab) oldTab.view.setVisible(false);
  }

  activeTabId = tabId;
  tab.view.setVisible(true);
  setTabBounds(tab.view);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('url-changed', tab.url);
    mainWindow.setTitle(`${tab.title} — Nori Browser`);
  }

  sendTabsChanged();
}

function switchToNextTab() {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex(t => t.id === activeTabId);
  const nextIdx = (idx + 1) % tabs.length;
  switchTab(tabs[nextIdx].id);
}

function switchToPrevTab() {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex(t => t.id === activeTabId);
  const prevIdx = (idx - 1 + tabs.length) % tabs.length;
  switchTab(tabs[prevIdx].id);
}

function reorderTab(tabId, newIndex) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  const tab = tabs[idx];
  const pinnedCount = getPinnedCount();
  let clamped;
  if (tab.pinned) {
    clamped = Math.max(0, Math.min(pinnedCount - 1, newIndex));
  } else {
    clamped = Math.max(pinnedCount, Math.min(tabs.length - 1, newIndex));
  }
  const [removed] = tabs.splice(idx, 1);
  tabs.splice(clamped, 0, removed);
  sendTabsChanged();
}

function moveTabRight() {
  const idx = tabs.findIndex(t => t.id === activeTabId);
  if (idx === -1 || idx >= tabs.length - 1) return;
  const tab = tabs[idx];
  if (tab.pinned && idx >= getPinnedCount() - 1) return;
  reorderTab(activeTabId, idx + 1);
}

function moveTabLeft() {
  const idx = tabs.findIndex(t => t.id === activeTabId);
  if (idx <= 0) return;
  const tab = tabs[idx];
  if (!tab.pinned && idx <= getPinnedCount()) return;
  reorderTab(activeTabId, idx - 1);
}

function getPinnedCount() {
  return tabs.filter(t => t.pinned).length;
}

function pinTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || tab.pinned) return;
  tab.pinned = true;
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  const pinnedCount = getPinnedCount();
  tabs.splice(pinnedCount, 0, tab);
  sendTabsChanged();
}

function unpinTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || !tab.pinned) return;
  tab.pinned = false;
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  const pinnedCount = getPinnedCount();
  tabs.splice(pinnedCount, 0, tab);
  sendTabsChanged();
}

function reopenClosedTab() {
  if (closedTabStack.length === 0) return;
  const entry = closedTabStack.pop();
  const pinnedCount = getPinnedCount();
  const insertAt = Math.max(pinnedCount, Math.min(entry.index, tabs.length));
  createTab(entry.url, insertAt);
}

function duplicateTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  const insertAt = tab.pinned ? getPinnedCount() : tabs.indexOf(tab) + 1;
  createTab(tab.url, insertAt);
}

function closeOtherTabs(tabId) {
  if (!tabs.some(t => t.id === tabId)) return;
  const toClose = tabs.filter(t => t.id !== tabId && !t.pinned).map(t => t.id);
  for (const id of toClose) closeTab(id);
}

function closeTabsToRight(tabId) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  const toClose = tabs.slice(idx + 1).filter(t => !t.pinned).map(t => t.id);
  for (const id of toClose) closeTab(id);
}

function getActiveView() {
  const tab = tabs.find(t => t.id === activeTabId);
  return tab ? tab.view : null;
}

function sendTabsChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tabs-changed', {
    tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, pinned: t.pinned, favicon: t.favicon, isLoading: t.isLoading })),
    activeTabId,
  });
}

function setTabBounds(view) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tab = tabs.find(t => t.view === view);
  if (tab && tab.isHtmlFullScreen) {
    const [width, height] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
    return;
  }
  const [width, height] = mainWindow.getContentSize();
  const dividerWidth = sidebarVisible ? 4 : 0;
  view.setBounds({
    x: sidebarWidth + dividerWidth,
    y: TOOLBAR_HEIGHT + TAB_BAR_HEIGHT,
    width: Math.max(0, width - sidebarWidth - dividerWidth),
    height: Math.max(0, height - TOOLBAR_HEIGHT - TAB_BAR_HEIGHT),
  });
}

function updateAllTabBounds() {
  for (const tab of tabs) {
    setTabBounds(tab.view);
  }
}

function zoomIn() {
  const view = getActiveView();
  if (!view) return;
  const current = view.webContents.getZoomFactor();
  const next = ZOOM_FACTORS.find(f => f > current + 0.001);
  if (next) {
    view.webContents.setZoomFactor(next);
    sendZoomChanged(next);
  }
}

function zoomOut() {
  const view = getActiveView();
  if (!view) return;
  const current = view.webContents.getZoomFactor();
  const prev = [...ZOOM_FACTORS].reverse().find(f => f < current - 0.001);
  if (prev) {
    view.webContents.setZoomFactor(prev);
    sendZoomChanged(prev);
  }
}

function resetZoom() {
  const view = getActiveView();
  if (!view) return;
  view.webContents.setZoomFactor(1.0);
  sendZoomChanged(1.0);
}

function sendZoomChanged(factor) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('zoom-changed', Math.round(factor * 100));
  }
}

function handleToggleSidebar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (sidebarVisible) {
    savedSidebarWidth = sidebarWidth;
    sidebarWidth = 0;
    sidebarVisible = false;
  } else {
    sidebarWidth = savedSidebarWidth;
    sidebarVisible = true;
  }
  updateAllTabBounds();
  mainWindow.webContents.send('sidebar-toggled', sidebarVisible);
}

function buildBrowserPrompt() {
  const bridgePath = path.join(__dirname, 'playwright-bridge.js');
  return `You are connected to a browser via Chrome DevTools Protocol.

CDP Port: ${CDP_PORT}
CDP URL: http://localhost:${CDP_PORT}

To interact with the browser, use the playwright-bridge CLI:

  node ${bridgePath} <command> [args]

Commands:
  status              - Get current page URL, title, and page count
  navigate <url>      - Navigate to a URL
  snapshot            - Get accessibility tree snapshot
  click <selector>    - Click an element
  fill <selector> <v> - Fill an input field
  eval <expression>   - Evaluate JavaScript on the page
  content             - Get page text content
  screenshot [path]   - Take a screenshot
  list-tabs           - List all open tabs
  new-tab [url]       - Open a new tab
  close-tab [index]   - Close a tab by index
  switch-tab <index>  - Switch to a tab by index

Additional tab operations are available via the renderer page's window.api:
  window.api.duplicateTab(tabId)      - Duplicate a tab
  window.api.closeOtherTabs(tabId)    - Close all tabs except the specified one
  window.api.closeTabsToRight(tabId)  - Close all tabs to the right of the specified one
  window.api.reopenClosedTab()        - Reopen the most recently closed tab
  window.api.reorderTab(tabId, index) - Move a tab to a new position
  window.api.pinTab(tabId)            - Pin a tab (moves to left, shows favicon only)
  window.api.unpinTab(tabId)          - Unpin a tab

You can also use Playwright directly by connecting over CDP:

  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://localhost:${CDP_PORT}');

Script the browser directly. Do not use MCP tools or Playwright tool calls.
Do not create git worktrees or run git init.

Network etiquette — be a good steward of the internet:
- Add a random delay of 1-3 seconds between sequential requests to the same external service (e.g., 1000 + Math.random() * 2000 ms). Never use fixed intervals.
- Use exponential backoff with jitter on retries: sleep = random(0, min(30000, 1000 * 2**attempt)). Cap at 30 seconds.
- Always honor 429 Too Many Requests responses and Retry-After headers.
- Limit concurrent requests to the same external service to 1-2 at a time.
- Check robots.txt before scraping or crawling a new domain.
These rules do not apply to localhost or private network addresses.
`;
}

// Isolate the nori session from the user's personal ~/.nori config so the browser
// agent runs in a clean environment (mirrors the old claude `--setting-sources ''`).
// Crucially this disables auto_worktree, which would otherwise pull the agent into a
// separate git worktree instead of the folder the terminal was launched in.
function ensureNoriHome() {
  const home = path.join(os.homedir(), '.nori-browser');
  fs.mkdirSync(home, { recursive: true });
  const config = path.join(home, 'config.toml');
  if (!fs.existsSync(config)) {
    fs.writeFileSync(config, '[tui]\nauto_worktree = "off"\n');
  }
  return home;
}

// Where the last chosen folder is remembered so the startup picker can default
// to it next time. Lives alongside the isolated nori-browser config home.
function lastFolderStatePath() {
  return process.env.NORI_BROWSER_STATE_FILE || path.join(os.homedir(), '.nori-browser', 'last-folder');
}

function readLastFolder() {
  try {
    const dir = fs.readFileSync(lastFolderStatePath(), 'utf-8').trim();
    if (dir && fs.statSync(dir).isDirectory()) return dir;
  } catch {}
  return null;
}

function rememberLastFolder(dir) {
  // Best-effort: a failed write to remember the folder must never block startup.
  try {
    const file = lastFolderStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, dir);
  } catch {}
}

// Ask the user which folder to run the nori terminal in, before the browser
// window opens. Falls back to the launch directory when there is no UI to prompt
// in (headless/automation) or when the user dismisses the picker.
async function resolveLaunchDir() {
  const envDir = process.env.NORI_BROWSER_LAUNCH_DIR;
  if (envDir) {
    launchDir = envDir;
    rememberLastFolder(envDir);
    return;
  }
  if (process.env.NORI_BROWSER_HEADLESS) {
    launchDir = process.cwd();
    return;
  }
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a folder for the Nori terminal',
    buttonLabel: 'Open',
    defaultPath: readLastFolder() || process.cwd(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || filePaths.length === 0) {
    launchDir = process.cwd();
    return;
  }
  launchDir = filePaths[0];
  rememberLastFolder(launchDir);
}

function startTerminal() {
  if (ptyProcess) return;
  const cwd = launchDir || process.cwd();
  const { command, args } = resolveShell(buildBrowserPrompt(), cwd);
  ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: {
      ...process.env,
      NORI_BROWSER_CDP_PORT: String(CDP_PORT),
      PLAYWRIGHT_CDP_URL: `http://localhost:${CDP_PORT}`,
      NODE_PATH: [path.join(__dirname, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      NORI_BROWSER_DIR: __dirname,
      NORI_HOME: ensureNoriHome(),
    },
  });

  ptyProcess.onData((data) => {
    if (data.includes('\x1b[6n')) {
      ptyProcess.write('\x1b[1;1R');
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', data);
    }
    for (const socket of controlSockets) {
      socket.write(data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exit', exitCode);
    }
  });

  startControlServer();
}

function startControlServer() {
  if (CONTROL_PORT === 0 && !process.env.NORI_BROWSER_CONTROL_PORT) return;
  controlServer = net.createServer((socket) => {
    controlSockets.add(socket);
    socket.on('data', (data) => {
      if (ptyProcess) ptyProcess.write(data.toString());
    });
    socket.on('close', () => controlSockets.delete(socket));
    socket.on('error', () => controlSockets.delete(socket));
  });
  controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
    const port = controlServer.address().port;
    process.env.NORI_BROWSER_CONTROL_PORT = String(port);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('control-port', port);
    }
  });
}

function resolveNoriBinary() {
  if (process.env.NORI_BROWSER_NORI_BIN) return process.env.NORI_BROWSER_NORI_BIN;

  const localNori = path.join(__dirname, 'node_modules', '.bin', 'nori');
  if (fs.existsSync(localNori)) return localNori;

  const { execSync } = require('child_process');
  try {
    const noriPath = execSync('which nori', { encoding: 'utf-8' }).trim();
    if (noriPath) return noriPath;
  } catch {}

  return null;
}

function resolveShell(prompt, cwd) {
  const envShell = process.env.NORI_BROWSER_SHELL;
  if (envShell) return { command: envShell, args: [] };

  const noriPath = resolveNoriBinary();
  if (noriPath) {
    return {
      command: noriPath,
      args: [
        '-a', 'claude-code',
        '-C', cwd,
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-welcome',
        '--skip-trust-directory',
        '-c', 'shell_environment_policy.inherit=all',
        prompt,
      ],
    };
  }

  return { command: process.env.SHELL || '/bin/bash', args: [] };
}

ipcMain.on('terminal-ready', () => {
  startTerminal();
});

ipcMain.on('terminal-input', (_, data) => {
  if (ptyProcess) ptyProcess.write(data);
});

ipcMain.on('terminal-resize', (_, { cols, rows }) => {
  if (ptyProcess) {
    try { ptyProcess.resize(cols, rows); } catch {}
  }
});

function resolveInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^(https?|ftp):\/\//i.test(trimmed)) return trimmed;
  if (/\s/.test(trimmed)) return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/.*)?$/.test(trimmed)) return `http://${trimmed}`;
  if (trimmed.includes('.')) return `https://${trimmed}`;
  if (/^[a-zA-Z0-9-]+(:\d+)(\/.*)?$/.test(trimmed)) return `http://${trimmed}`;
  if (trimmed.endsWith('/')) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

ipcMain.on('navigate', (_, url) => {
  const view = getActiveView();
  if (!view) return;
  const resolved = resolveInput(url);
  if (!resolved) return;
  view.webContents.loadURL(resolved);
});

ipcMain.on('go-back', () => {
  const view = getActiveView();
  if (view && view.webContents.canGoBack()) {
    view.webContents.goBack();
  }
});

ipcMain.on('go-forward', () => {
  const view = getActiveView();
  if (view && view.webContents.canGoForward()) {
    view.webContents.goForward();
  }
});

ipcMain.on('reload', () => {
  const view = getActiveView();
  if (view) view.webContents.reload();
});

ipcMain.on('toggle-sidebar', handleToggleSidebar);

ipcMain.on('sidebar-resize', (_, width) => {
  sidebarWidth = width;
  savedSidebarWidth = width;
  updateAllTabBounds();
});

ipcMain.on('create-tab', (_, url) => {
  createTab(url || 'about:blank');
});

ipcMain.on('close-tab', (_, tabId) => {
  closeTab(tabId);
});

ipcMain.on('switch-tab', (_, tabId) => {
  switchTab(tabId);
});

ipcMain.on('reorder-tab', (_, tabId, newIndex) => {
  reorderTab(tabId, newIndex);
});

ipcMain.on('reopen-closed-tab', () => {
  reopenClosedTab();
});

ipcMain.on('duplicate-tab', (_, tabId) => {
  duplicateTab(tabId);
});

ipcMain.on('close-other-tabs', (_, tabId) => {
  closeOtherTabs(tabId);
});

ipcMain.on('close-tabs-to-right', (_, tabId) => {
  closeTabsToRight(tabId);
});

ipcMain.on('pin-tab', (_, tabId) => {
  pinTab(tabId);
});

ipcMain.on('unpin-tab', (_, tabId) => {
  unpinTab(tabId);
});

ipcMain.on('tab-context-menu', (event, tabId) => {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  const menu = Menu.buildFromTemplate([
    { label: 'New Tab', click: () => createTab('about:blank') },
    { label: 'Reload', click: () => { const t = tabs.find(t => t.id === tabId); if (t) t.view.webContents.reload(); } },
    { label: 'Duplicate', click: () => duplicateTab(tabId) },
    { type: 'separator' },
    { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: tab.pinned ? () => unpinTab(tabId) : () => pinTab(tabId) },
    { type: 'separator' },
    { label: 'Close Tab', click: () => closeTab(tabId) },
    { label: 'Close Other Tabs', click: () => closeOtherTabs(tabId) },
    { label: 'Close Tabs to the Right', click: () => closeTabsToRight(tabId) },
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

ipcMain.handle('get-tabs', () => {
  return {
    tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, pinned: t.pinned, favicon: t.favicon, isLoading: t.isLoading })),
    activeTabId,
  };
});

function stripDomainPrefix(url) {
  const domainStart = url.indexOf('://') + 3;
  let domain = domainStart > 2 ? url.slice(domainStart) : url;
  for (const prefix of ['www.', 'm.', 'mobile.']) {
    if (domain.startsWith(prefix)) return domain.slice(prefix.length);
  }
  return domain;
}

function searchBookmarks(node, query, results) {
  if (!node) return;
  if (node.type === 'url' && node.url) {
    if ((node.name || '').toLowerCase().includes(query) || node.url.toLowerCase().includes(query)) {
      const domain = stripDomainPrefix(node.url.toLowerCase());
      const titleLower = (node.name || '').toLowerCase();
      const prefixBoost = domain.startsWith(query) || titleLower.startsWith(query) ? 10 : 0;
      const score = prefixBoost + 20;
      results.push({ url: node.url, title: node.name || '', source: 'bookmark', score });
    }
  }
  if (node.children) {
    for (const child of node.children) {
      searchBookmarks(child, query, results);
    }
  }
}

ipcMain.on('omnibar-visibility', (_, visible) => {
  omnibarOpen = visible;
  if (!visible && omnibarPopup && !omnibarPopup.isDestroyed()) {
    omnibarPopup.hide();
  }
});

ipcMain.on('omnibar-show-popup', (_, results, selectedIndex) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!results || results.length === 0) {
    if (omnibarPopup && !omnibarPopup.isDestroyed()) omnibarPopup.hide();
    return;
  }

  const mainBounds = mainWindow.getBounds();
  const contentBounds = mainWindow.getContentBounds();
  const titleBarHeight = contentBounds.y - mainBounds.y;
  const dividerWidth = sidebarVisible ? 4 : 0;
  const popupX = mainBounds.x + sidebarWidth + dividerWidth + 40;
  const popupY = mainBounds.y + titleBarHeight + TOOLBAR_HEIGHT;
  const popupWidth = contentBounds.width - sidebarWidth - dividerWidth - 80;
  const itemHeight = 36;
  const popupHeight = Math.min(results.length, 8) * itemHeight + 8;

  if (!omnibarPopup || omnibarPopup.isDestroyed()) {
    omnibarPopup = new BrowserWindow({
      parent: mainWindow,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      show: false,
      focusable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
  }

  omnibarPopup.setBounds({ x: popupX, y: popupY, width: popupWidth, height: popupHeight });

  const html = `<!DOCTYPE html><html><head><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: transparent; overflow: hidden; }
    #dropdown { background: #2d2d2d; border: 1px solid #555; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); overflow: hidden; }
    .item { display: flex; align-items: center; gap: 8px; padding: 8px 14px; cursor: pointer; font-size: 13px; height: ${itemHeight}px; }
    .item:hover, .item.selected { background: #094771; }
    .star { color: #e8a100; flex-shrink: 0; font-size: 14px; }
    .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d4d4d4; }
    .url { flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #888; font-size: 12px; max-width: 50%; }
  </style></head><body><div id="dropdown">${results.map((r, i) => `
    <div class="item${i === selectedIndex ? ' selected' : ''}" data-url="${r.url.replace(/"/g, '&quot;')}">
      ${r.source === 'bookmark' ? '<span class="star">★</span>' : ''}
      <span class="title">${(r.title || r.url).replace(/</g, '&lt;')}</span>
      <span class="url">${r.url.replace(/</g, '&lt;')}</span>
    </div>`).join('')}</div>
  <script>document.addEventListener('mousedown', e => {
    const item = e.target.closest('.item');
    if (item) {
      e.preventDefault();
      window.location.hash = item.dataset.url;
    }
  });</script></body></html>`;

  omnibarPopup.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  omnibarPopup.webContents.on('did-navigate-in-page', (_, url) => {
    const hash = decodeURIComponent(url.split('#')[1] || '');
    if (hash) {
      const view = getActiveView();
      if (view) {
        const resolved = resolveInput(hash);
        if (resolved) view.webContents.loadURL(resolved);
      }
      omnibarPopup.hide();
      mainWindow.webContents.send('omnibar-selected');
    }
  });
  omnibarPopup.showInactive();
});

ipcMain.handle('omnibar-query', (_, query) => {
  if (!query || query.length < 1) return [];
  const lowerQuery = query.toLowerCase();
  const userData = app.getPath('userData');
  const defaultProfile = path.join(userData, 'Default');
  const results = [];
  const seenUrls = new Set();

  const bookmarksPath = path.join(defaultProfile, 'Bookmarks');
  try {
    const bookmarksData = JSON.parse(fs.readFileSync(bookmarksPath, 'utf-8'));
    const roots = bookmarksData.roots || {};
    for (const key of Object.keys(roots)) {
      searchBookmarks(roots[key], lowerQuery, results);
    }
  } catch {}

  for (const r of results) seenUrls.add(r.url);

  const historyPath = cachedHistoryPath || path.join(defaultProfile, 'History');
  try {
    const db = new Database(historyPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT url, title, visit_count, typed_count, last_visit_time
      FROM urls
      WHERE url LIKE '%' || ? || '%' OR title LIKE '%' || ? || '%'
      ORDER BY typed_count DESC, visit_count DESC, last_visit_time DESC
      LIMIT 200
    `).all(lowerQuery, lowerQuery);
    db.close();

    const now = Date.now() * 1000 + 11644473600000000;
    for (const row of rows) {
      if (!seenUrls.has(row.url)) {
        const urlLower = row.url.toLowerCase();
        const titleLower = (row.title || '').toLowerCase();
        const domain = stripDomainPrefix(urlLower);
        const prefixBoost = domain.startsWith(lowerQuery) || titleLower.startsWith(lowerQuery) ? 10 : 0;
        const ageHours = Math.max(1, (now - row.last_visit_time) / 3600000000);
        const recencyScore = Math.max(0, 10 - Math.log2(ageHours / 24));
        const score = prefixBoost + (row.typed_count * 4) + (row.visit_count * 0.5) + recencyScore;
        results.push({ url: row.url, title: row.title, source: 'history', score });
        seenUrls.add(row.url);
      }
    }
  } catch {}

  results.sort((a, b) => (b.score || 0) - (a.score || 0));
  return results.slice(0, 8);
});

// Find in page
ipcMain.on('find-in-page', (_, text) => {
  const view = getActiveView();
  if (view && text) {
    lastFindText = text;
    view.webContents.findInPage(text);
  }
});

ipcMain.on('find-next', (_, forward) => {
  const view = getActiveView();
  if (view && lastFindText) {
    view.webContents.findInPage(lastFindText, { findNext: true, forward });
  }
});

ipcMain.on('find-close', () => {
  const view = getActiveView();
  if (view) {
    view.webContents.stopFindInPage('clearSelection');
  }
  lastFindText = '';
});

ipcMain.on('download-cancel', (_, id) => {
  const item = downloads.get(id);
  if (item) item.cancel();
});

ipcMain.on('download-open', (_, id) => {
  const item = downloads.get(id);
  if (item && item.getSavePath()) shell.openPath(item.getSavePath());
});

ipcMain.on('download-show', (_, id) => {
  const item = downloads.get(id);
  if (item && item.getSavePath()) shell.showItemInFolder(item.getSavePath());
});

app.on('window-all-closed', () => {
  if (ptyProcess) ptyProcess.kill();
  if (controlServer) controlServer.close();
  for (const socket of controlSockets) socket.destroy();
  if (cachedHistoryPath) {
    try { fs.unlinkSync(cachedHistoryPath); } catch {}
    try { fs.unlinkSync(cachedHistoryPath + '-wal'); } catch {}
  }
  app.quit();
});
