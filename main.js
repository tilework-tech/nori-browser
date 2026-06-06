const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

const CDP_PORT = parseInt(process.env.NORI_BROWSER_CDP_PORT || '19222');
const CONTROL_PORT = parseInt(process.env.NORI_BROWSER_CONTROL_PORT || '0');
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));

let mainWindow;
let browserView;
let ptyProcess;
let controlServer;
let controlSockets = new Set();
let sidebarWidth = 400;
let sessionDir;
const TOOLBAR_HEIGHT = 48;

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

  browserView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.setBrowserView(browserView);
  browserView.webContents.loadURL('about:blank');

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
          '--bare',
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
