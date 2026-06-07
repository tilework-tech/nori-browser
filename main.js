const { app, BrowserWindow, WebContentsView, ipcMain, Menu, clipboard, dialog, session, shell } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

const CDP_PORT = parseInt(process.env.NORI_BROWSER_CDP_PORT || '19222');
const CONTROL_PORT = parseInt(process.env.NORI_BROWSER_CONTROL_PORT || '0');
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));

let mainWindow;
let ptyProcess;
let controlServer;
let controlSockets = new Set();
let sidebarWidth = 400;
let savedSidebarWidth = 400;
let sidebarVisible = true;
let sessionDir;
const TOOLBAR_HEIGHT = 48;
const TAB_BAR_HEIGHT = 36;

let tabs = [];
let activeTabId = null;
let nextTabId = 1;
const MAX_CLOSED_TABS = 25;
let closedTabStack = [];

const ZOOM_FACTORS = [0.25, 0.333, 0.5, 0.667, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];
let downloads = new Map();
let nextDownloadId = 1;
let lastFindText = '';

app.whenReady().then(() => {
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

function createSessionDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nori-browser-'));
  const bridgePath = path.join(__dirname, 'playwright-bridge.js');
  const prompt = `You are connected to a browser via Chrome DevTools Protocol.

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

  fs.writeFileSync(path.join(dir, 'system-prompt.txt'), prompt);
  return dir;
}

function cleanupSessionDir() {
  if (sessionDir) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    sessionDir = null;
  }
}

function startTerminal() {
  if (ptyProcess) return;
  sessionDir = createSessionDir();
  const { command, args } = resolveShell(sessionDir);
  ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME || process.cwd(),
    env: {
      ...process.env,
      NORI_BROWSER_CDP_PORT: String(CDP_PORT),
      PLAYWRIGHT_CDP_URL: `http://localhost:${CDP_PORT}`,
      NODE_PATH: [path.join(__dirname, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      NORI_BROWSER_DIR: __dirname,
      NORI_SESSION_DIR: sessionDir,
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

function resolveShell(sessionDir) {
  const envShell = process.env.NORI_BROWSER_SHELL;
  if (envShell) return { command: envShell, args: [] };

  const { execSync } = require('child_process');
  try {
    const claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (claudePath) {
      return {
        command: claudePath,
        args: [
          '--setting-sources', '',
          '--settings', JSON.stringify({ claudeMdExcludes: ['**'] }),
          '--append-system-prompt-file', path.join(sessionDir, 'system-prompt.txt'),
          '--dangerously-skip-permissions',
        ],
      };
    }
  } catch {}

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

app.on('before-quit', () => {
  cleanupSessionDir();
});

app.on('window-all-closed', () => {
  if (ptyProcess) ptyProcess.kill();
  if (controlServer) controlServer.close();
  for (const socket of controlSockets) socket.destroy();
  cleanupSessionDir();
  app.quit();
});
