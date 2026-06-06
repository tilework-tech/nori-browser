const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const CDP_PORT = 19223;
const CONTROL_PORT = 19224;
const APP_PATH = path.join(__dirname, '..');

let testServer;
let testServerPort;

function connectControl() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(CONTROL_PORT, '127.0.0.1', () => resolve(socket));
    socket.on('error', reject);
  });
}

function sendAndWait(socket, input, marker, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error(`Timed out waiting for "${marker}" in terminal output. Got: ${buf.slice(-500)}`));
    }, timeout);
    function onData(data) {
      buf += data.toString();
      if (buf.includes(marker)) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve(buf);
      }
    }
    socket.on('data', onData);
    if (input) socket.write(input);
  });
}

test.describe('Nori Browser', () => {
  let electronApp;
  let window;

  test.beforeAll(async () => {
    testServer = http.createServer((req, res) => {
      if (req.url === '/page-a') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Page A</title></head><body><h1>Hello from Page A</h1><input id="search" type="text" /><button id="submit">Submit</button></body></html>');
      } else if (req.url === '/page-b') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Page B</title></head><body><h1>Hello from Page B</h1></body></html>');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Test Home</title></head><body><h1>Test Server</h1></body></html>');
      }
    });
    await new Promise((resolve) => {
      testServer.listen(0, '127.0.0.1', resolve);
    });
    testServerPort = testServer.address().port;

    electronApp = await electron.launch({
      args: [path.join(APP_PATH, 'main.js')],
      env: {
        ...process.env,
        NORI_BROWSER_SHELL: '/bin/bash',
        NORI_BROWSER_CDP_PORT: String(CDP_PORT),
        NORI_BROWSER_CONTROL_PORT: String(CONTROL_PORT),
      },
    });

    await electronApp.firstWindow();
    for (let i = 0; i < 30; i++) {
      const windows = electronApp.windows();
      const renderer = windows.find((w) => w.url().includes('index.html'));
      if (renderer) {
        window = renderer;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Wait for control port to be listening
    for (let i = 0; i < 20; i++) {
      try {
        const sock = await connectControl();
        sock.destroy();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
      electronApp = null;
    }
    if (testServer) await new Promise((resolve) => testServer.close(resolve));
  });

  test('window opens with sidebar, terminal, toolbar, and URL bar', async () => {
    await window.waitForSelector('#sidebar', { timeout: 10000 });

    expect(await window.$('#sidebar')).toBeTruthy();
    expect(await window.$('#terminal-container')).toBeTruthy();
    expect(await window.$('#toolbar')).toBeTruthy();
    expect(await window.$('#url-bar')).toBeTruthy();
    expect(await window.$('#divider')).toBeTruthy();
  });

  test('terminal accepts input and shows output via control socket', async () => {
    const socket = await connectControl();
    try {
      const output = await sendAndWait(socket, 'echo CTRL_TEST_42\n', 'CTRL_TEST_42');
      expect(output).toContain('CTRL_TEST_42');
    } finally {
      socket.destroy();
    }
  });

  test('URL bar navigates browser to local URL', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-a`);
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await urlBar.inputValue();
    }, { timeout: 10000 }).toContain(`127.0.0.1:${testServerPort}/page-a`);
  });

  test('playwright can connect via CDP and navigate', async () => {
    let cdpBrowser;
    try {
      cdpBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
      const contexts = cdpBrowser.contexts();
      expect(contexts.length).toBeGreaterThan(0);

      const allPages = contexts.flatMap((c) => c.pages());
      const browserPage = allPages.find((p) => !p.url().startsWith('file://'));
      expect(browserPage).toBeTruthy();

      await browserPage.goto(`http://127.0.0.1:${testServerPort}/page-b`);
      const title = await browserPage.title();
      expect(title).toBe('Page B');
    } finally {
      if (cdpBrowser) await cdpBrowser.close();
    }
  });

  test('terminal has correct environment variables', async () => {
    const socket = await connectControl();
    try {
      await sendAndWait(socket, 'echo ENVCHK_CDP=$NORI_BROWSER_CDP_PORT\n', `ENVCHK_CDP=${CDP_PORT}`);
      await sendAndWait(socket, 'echo ENVCHK_PW=$PLAYWRIGHT_CDP_URL\n', `ENVCHK_PW=http://localhost:${CDP_PORT}`);
      await sendAndWait(socket, 'echo ENVCHK_NP=$NODE_PATH\n', 'node_modules');
      await sendAndWait(socket, 'ls $NORI_BROWSER_DIR/playwright-bridge.js && echo BRIDGE_FOUND\n', 'BRIDGE_FOUND');
    } finally {
      socket.destroy();
    }
  });

  test('agent can use playwright-bridge.js from terminal to navigate browser', async () => {
    const socket = await connectControl();
    try {
      const navUrl = `http://127.0.0.1:${testServerPort}/page-a`;
      const output = await sendAndWait(socket, `node $NORI_BROWSER_DIR/playwright-bridge.js navigate '${navUrl}'\n`, 'NAVIGATE_OK', 15000);
      expect(output).toContain('NAVIGATE_OK');
      expect(output).toContain('Page A');

      const urlBar = await window.$('#url-bar');
      await expect.poll(async () => {
        return await urlBar.inputValue();
      }, { timeout: 5000 }).toContain(`127.0.0.1:${testServerPort}/page-a`);
    } finally {
      socket.destroy();
    }
  });

  test('agent can use playwright-bridge.js from terminal to get page status', async () => {
    const socket = await connectControl();
    try {
      const output = await sendAndWait(socket, 'node $NORI_BROWSER_DIR/playwright-bridge.js status\n', 'STATUS_OK', 15000);
      expect(output).toContain('STATUS_OK');
      expect(output).toContain('URL:');
    } finally {
      socket.destroy();
    }
  });

  test('agent can use playwright-bridge.js to evaluate JavaScript on page', async () => {
    const socket = await connectControl();
    try {
      const output = await sendAndWait(socket, `node $NORI_BROWSER_DIR/playwright-bridge.js eval 'document.title'\n`, 'EVAL_OK', 15000);
      expect(output).toContain('EVAL_OK');
      expect(output).toContain('Result:');
    } finally {
      socket.destroy();
    }
  });

  test('agent can use playwright-bridge.js to get page content', async () => {
    const socket = await connectControl();
    try {
      const output = await sendAndWait(socket, 'node $NORI_BROWSER_DIR/playwright-bridge.js content\n', 'CONTENT_OK', 15000);
      expect(output).toContain('CONTENT_OK');
    } finally {
      socket.destroy();
    }
  });

  test('session directory with system prompt is created on startup', async () => {
    const socket = await connectControl();
    try {
      const dirOutput = await sendAndWait(socket, 'echo SESSION_DIR=$NORI_SESSION_DIR\n', 'SESSION_DIR=/', 5000);
      const match = dirOutput.match(/SESSION_DIR=(\/[^\s\r\n]+)/);
      expect(match).toBeTruthy();
      const sessionDir = match[1];

      const existsOutput = await sendAndWait(socket, `test -f "$NORI_SESSION_DIR/system-prompt.txt" && echo PROMPT_EXISTS\n`, 'PROMPT_EXISTS', 5000);
      expect(existsOutput).toContain('PROMPT_EXISTS');
    } finally {
      socket.destroy();
    }
  });

  test('system prompt contains correct CDP port and bridge path', async () => {
    const socket = await connectControl();
    try {
      const output = await sendAndWait(socket, 'cat "$NORI_SESSION_DIR/system-prompt.txt"\n', String(CDP_PORT), 5000);
      expect(output).toContain(String(CDP_PORT));
      expect(output).toContain('playwright-bridge.js');
    } finally {
      socket.destroy();
    }
  });

  test('resizing window updates the rendered browser page dimensions', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-a`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => {
      return await urlBar.inputValue();
    }, { timeout: 10000 }).toContain('page-a');

    let cdpBrowser;
    try {
      cdpBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
      const allPages = cdpBrowser.contexts().flatMap((c) => c.pages());
      const browserPage = allPages.find((p) => !p.url().startsWith('file://'));
      expect(browserPage).toBeTruthy();

      const initialSize = await browserPage.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      const bw = await electronApp.browserWindow(window);
      await bw.evaluate((win) => win.setSize(800, 600));

      await expect.poll(async () => {
        return await browserPage.evaluate(() => window.innerWidth);
      }, { timeout: 5000 }).toBeLessThan(initialSize.width);

      const newSize = await browserPage.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      expect(newSize.width).toBeGreaterThan(0);
      expect(newSize.height).toBeLessThan(initialSize.height);
      expect(newSize.height).toBeGreaterThan(0);
    } finally {
      if (cdpBrowser) await cdpBrowser.close();
      const bw = await electronApp.browserWindow(window);
      await bw.evaluate((win) => win.setSize(1400, 900));
    }
  });

  test('session directory is cleaned up on exit', async () => {
    const socket = await connectControl();
    let sessionDir;
    try {
      const dirOutput = await sendAndWait(socket, 'echo SESSION_DIR=$NORI_SESSION_DIR\n', 'SESSION_DIR=/', 5000);
      const match = dirOutput.match(/SESSION_DIR=(\/[^\s\r\n]+)/);
      expect(match).toBeTruthy();
      sessionDir = match[1];
    } finally {
      socket.destroy();
    }

    await electronApp.close();
    electronApp = null;

    expect(fs.existsSync(sessionDir)).toBe(false);
  });
});
