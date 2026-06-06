const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const CDP_PORT = parseInt(process.env.NORI_BROWSER_CDP_PORT || '19222');
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));

let mainWindow;
let browserView;
let ptyProcess;
let sidebarWidth = 400;
const TOOLBAR_HEIGHT = 48;

app.whenReady().then(() => {
  createWindow();
  const readyTimeout = setTimeout(() => startTerminal(), 10000);
  ipcMain.once('terminal-ready', () => {
    clearTimeout(readyTimeout);
    startTerminal();
  });
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

  browserView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.setBrowserView(browserView);
  browserView.webContents.loadURL('https://www.google.com');

  mainWindow.once('ready-to-show', updateBrowserViewBounds);
  mainWindow.on('resize', updateBrowserViewBounds);
  mainWindow.on('maximize', updateBrowserViewBounds);
  mainWindow.on('unmaximize', updateBrowserViewBounds);

  mainWindow.webContents.once('did-finish-load', () => {
    updateBrowserViewBounds();
    mainWindow.webContents.send('cdp-port', CDP_PORT);
  });

  browserView.webContents.on('did-navigate', (_, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('url-changed', url);
    }
  });
  browserView.webContents.on('did-navigate-in-page', (_, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('url-changed', url);
    }
  });
  browserView.webContents.on('page-title-updated', (_, title) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`${title} — Nori Browser`);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (ptyProcess) ptyProcess.kill();
  });
}

function updateBrowserViewBounds() {
  if (!browserView || !mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  browserView.setBounds({
    x: sidebarWidth + 4,
    y: TOOLBAR_HEIGHT,
    width: Math.max(0, width - sidebarWidth - 4),
    height: Math.max(0, height - TOOLBAR_HEIGHT),
  });
}

function createSessionDir() {
  const home = process.env.HOME || require('os').homedir();
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dir = path.join(home, 'nori-browser', timestamp);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startTerminal() {
  const { command, args } = resolveShell();
  const sessionDir = createSessionDir();
  ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: sessionDir,
    env: {
      ...process.env,
      NORI_BROWSER_CDP_PORT: String(CDP_PORT),
      PLAYWRIGHT_CDP_URL: `http://localhost:${CDP_PORT}`,
    },
  });

  ptyProcess.onData((data) => {
    if (data.includes('\x1b[6n')) {
      const count = data.split('\x1b[6n').length - 1;
      ptyProcess.write('\x1b[1;1R'.repeat(count));
      data = data.replaceAll('\x1b[6n', '');
    }
    if (data && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exit', exitCode);
    }
  });
}

const BROWSER_CONTEXT = [
  'You have access to a Playwright-controlled Chromium browser visible to the user on the right side of the screen.',
  'Connect using the PLAYWRIGHT_CDP_URL environment variable:',
  '',
  "const { chromium } = require('playwright');",
  "const browser = await chromium.connectOverCDP(process.env.PLAYWRIGHT_CDP_URL);",
  "const pages = browser.contexts().flatMap(c => c.pages());",
  "const page = pages.find(p => !p.url().startsWith('file://'));",
  '',
  'You can navigate, click, type, take screenshots, intercept network requests, and extract content.',
  'The user sees the browser live, so visual changes are immediately visible to them.',
].join('\n');

function resolveShell() {
  const envShell = process.env.NORI_BROWSER_SHELL;
  if (envShell) return { command: envShell, args: [] };

  const { execSync } = require('child_process');
  try {
    const noriPath = execSync('which nori', { encoding: 'utf-8' }).trim();
    if (noriPath) return { command: noriPath, args: ['-c', `developer_instructions=${BROWSER_CONTEXT}`] };
  } catch {}

  try {
    const claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (claudePath) return { command: claudePath, args: ['--append-system-prompt', BROWSER_CONTEXT] };
  } catch {}

  return { command: process.env.SHELL || '/bin/bash', args: [] };
}

ipcMain.on('terminal-input', (_, data) => {
  if (ptyProcess) ptyProcess.write(data);
});

ipcMain.on('terminal-resize', (_, { cols, rows }) => {
  if (ptyProcess) {
    try { ptyProcess.resize(cols, rows); } catch {}
  }
});

ipcMain.on('navigate', (_, url) => {
  if (!browserView) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  browserView.webContents.loadURL(url);
});

ipcMain.on('go-back', () => {
  if (browserView && browserView.webContents.canGoBack()) {
    browserView.webContents.goBack();
  }
});

ipcMain.on('go-forward', () => {
  if (browserView && browserView.webContents.canGoForward()) {
    browserView.webContents.goForward();
  }
});

ipcMain.on('reload', () => {
  if (browserView) browserView.webContents.reload();
});

ipcMain.on('sidebar-resize', (_, width) => {
  sidebarWidth = width;
  updateBrowserViewBounds();
});

app.on('window-all-closed', () => {
  if (ptyProcess) ptyProcess.kill();
  app.quit();
});
