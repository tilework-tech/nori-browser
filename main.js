const { app, BrowserWindow, WebContentsView, ipcMain, Menu } = require('electron');
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

app.whenReady().then(() => {
  createWindow();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
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
    if (input.control && input.key.toLowerCase() === 'j' && input.type === 'keyDown') {
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

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (ptyProcess) ptyProcess.kill();
  });
}

function createTab(url) {
  const id = String(nextTabId++);
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.contentView.addChildView(view);
  view.setVisible(false);

  const tab = { id, view, title: 'New Tab', url: url || 'about:blank' };
  tabs.push(tab);

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

  view.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.key.toLowerCase() === 'j' && input.type === 'keyDown') {
      event.preventDefault();
      handleToggleSidebar();
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
  const clamped = Math.max(0, Math.min(tabs.length - 1, newIndex));
  const [tab] = tabs.splice(idx, 1);
  tabs.splice(clamped, 0, tab);
  sendTabsChanged();
}

function moveTabRight() {
  const idx = tabs.findIndex(t => t.id === activeTabId);
  if (idx === -1 || idx >= tabs.length - 1) return;
  reorderTab(activeTabId, idx + 1);
}

function moveTabLeft() {
  const idx = tabs.findIndex(t => t.id === activeTabId);
  if (idx <= 0) return;
  reorderTab(activeTabId, idx - 1);
}

function getActiveView() {
  const tab = tabs.find(t => t.id === activeTabId);
  return tab ? tab.view : null;
}

function sendTabsChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tabs-changed', {
    tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url })),
    activeTabId,
  });
}

function setTabBounds(view) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
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

You can also use Playwright directly by connecting over CDP:

  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://localhost:${CDP_PORT}');

Script the browser directly. Do not use MCP tools or Playwright tool calls.
Do not create git worktrees or run git init.
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

ipcMain.on('navigate', (_, url) => {
  const view = getActiveView();
  if (!view) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  view.webContents.loadURL(url);
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

ipcMain.handle('get-tabs', () => {
  return {
    tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url })),
    activeTabId,
  };
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
