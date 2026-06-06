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

test.describe('Nori Browser Tabs', () => {
  let electronApp;
  let window;

  let testServer;
  let testServerPort;

  test.beforeAll(async () => {
    testServer = http.createServer((req, res) => {
      if (req.url === '/page-a') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Page A</title></head><body><h1>Hello from Page A</h1></body></html>');
      } else if (req.url === '/page-b') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Page B</title></head><body><h1>Hello from Page B</h1></body></html>');
      } else if (req.url === '/page-c') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Page C</title></head><body><h1>Hello from Page C</h1></body></html>');
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
        NORI_BROWSER_CDP_PORT: String(CDP_PORT + 10),
        NORI_BROWSER_CONTROL_PORT: String(CONTROL_PORT + 10),
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
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
      electronApp = null;
    }
    if (testServer) await new Promise((resolve) => testServer.close(resolve));
  });

  test('app starts with a tab bar showing one tab', async () => {
    await window.waitForSelector('#tab-bar', { timeout: 10000 });
    const tabs = await window.$$('#tab-bar .tab');
    expect(tabs.length).toBe(1);
    const activeTab = await window.$('#tab-bar .tab.active');
    expect(activeTab).toBeTruthy();
  });

  test('new tab button creates a second tab', async () => {
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2);
    const tabs = await window.$$('#tab-bar .tab');
    expect(tabs.length).toBe(2);
    const activeTab = await window.$('#tab-bar .tab.active');
    expect(activeTab).toBeTruthy();
  });

  test('clicking a tab switches to it', async () => {
    const urlBar = await window.$('#url-bar');

    // Navigate the active (second) tab to page-a
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-a`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-a');

    // Switch to the first tab via evaluate to avoid stale handles
    await window.evaluate(() => {
      document.querySelectorAll('#tab-bar .tab')[0].click();
    });

    // URL bar should NOT show page-a anymore (first tab has different URL)
    await expect.poll(async () => {
      const val = await urlBar.inputValue();
      return !val.includes('/page-a');
    }, { timeout: 5000 }).toBeTruthy();
  });

  test('navigation in one tab does not affect another', async () => {
    const urlBar = await window.$('#url-bar');

    // We're on the first tab. Navigate it to page-b.
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-b`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-b');

    // Switch to the second tab
    await window.evaluate(() => {
      document.querySelectorAll('#tab-bar .tab')[1].click();
    });

    // Second tab should still show page-a
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 5000 }).toContain('/page-a');
  });

  test('closing a tab removes it and activates another', async () => {
    // We should have 2 tabs, active is second. Close it.
    await window.evaluate(() => {
      document.querySelector('#tab-bar .tab.active .tab-close').click();
    });

    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 1);
    const tabs = await window.$$('#tab-bar .tab');
    expect(tabs.length).toBe(1);

    // Remaining tab should be active
    const activeTab = await window.$('#tab-bar .tab.active');
    expect(activeTab).toBeTruthy();
  });

  test('Ctrl+T creates a new tab via menu accelerator', async () => {
    const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);

    // Trigger the menu accelerator from the main process
    await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const fileMenu = menu.items.find(item => item.label === 'File');
      const newTabItem = fileMenu.submenu.items.find(item => item.label === 'New Tab');
      newTabItem.click();
    });

    await window.waitForFunction(
      (count) => document.querySelectorAll('#tab-bar .tab').length === count + 1,
      countBefore
    );
    const countAfter = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(countAfter).toBe(countBefore + 1);
  });

  test('Ctrl+W closes the current tab via menu accelerator', async () => {
    const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(countBefore).toBeGreaterThan(1);

    await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const fileMenu = menu.items.find(item => item.label === 'File');
      const closeTabItem = fileMenu.submenu.items.find(item => item.label === 'Close Tab');
      closeTabItem.click();
    });

    await window.waitForFunction(
      (count) => document.querySelectorAll('#tab-bar .tab').length === count - 1,
      countBefore
    );
    const countAfter = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(countAfter).toBe(countBefore - 1);
  });

  test('next-tab menu action switches to next tab', async () => {
    // Create a second tab first
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2);

    // Navigate the new (active, second) tab to page-c
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-c`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-c');

    // Trigger next-tab from the main process
    await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const tabMenu = menu.items.find(item => item.label === 'Tab');
      const nextTabItem = tabMenu.submenu.items.find(item => item.label === 'Next Tab');
      nextTabItem.click();
    });

    // URL bar should no longer show page-c
    await expect.poll(async () => {
      const val = await urlBar.inputValue();
      return !val.includes('/page-c');
    }, { timeout: 5000 }).toBeTruthy();
  });

  test('tab reorder via IPC changes tab order', async () => {
    // We should have 2 tabs. Set up known state: navigate first tab to page-a, second to page-c
    // Currently we have 2 tabs. Let's get their titles.
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2);

    const titlesBefore = await window.$$eval('#tab-bar .tab .tab-title', els => els.map(e => e.textContent));
    expect(titlesBefore.length).toBe(2);

    // Reorder: move first tab to position 1 (swap them)
    await window.evaluate(() => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      window.api.reorderTab(tabs[0].dataset.tabId, 1);
    });

    // Wait for the UI to update and verify titles are swapped
    await expect.poll(async () => {
      const titlesAfter = await window.$$eval('#tab-bar .tab .tab-title', els => els.map(e => e.textContent));
      return titlesAfter.length === 2 && titlesAfter[0] === titlesBefore[1] && titlesAfter[1] === titlesBefore[0];
    }, { timeout: 5000 }).toBeTruthy();
  });

  test('playwright-bridge list-tabs returns all tabs', async () => {
    const { execSync } = require('child_process');
    const bridgePath = path.join(APP_PATH, 'playwright-bridge.js');
    const output = execSync(
      `node ${bridgePath} list-tabs`,
      { env: { ...process.env, NORI_BROWSER_CDP_PORT: String(CDP_PORT + 10) }, encoding: 'utf-8', timeout: 15000 }
    );
    expect(output).toContain('LIST_TABS_OK');
    const tabLines = output.split('\n').filter(l => l.startsWith('Tab '));
    expect(tabLines.length).toBeGreaterThanOrEqual(2);
  });

  test('closing the last tab closes the window', async () => {
    // Close tabs until one left, then close that one
    while (true) {
      const count = await window.$$eval('#tab-bar .tab', els => els.length);
      if (count <= 1) break;
      await window.evaluate(() => {
        document.querySelector('#tab-bar .tab .tab-close').click();
      });
      await window.waitForFunction(
        (c) => document.querySelectorAll('#tab-bar .tab').length < c,
        count
      );
    }

    // Now close the last tab — this will close the window, so the click may throw
    try {
      await window.evaluate(() => {
        document.querySelector('#tab-bar .tab .tab-close').click();
      });
    } catch {}

    // The app should close
    await expect.poll(async () => {
      try {
        const windows = electronApp.windows();
        return windows.length === 0;
      } catch {
        return true;
      }
    }, { timeout: 10000 }).toBeTruthy();
  });
});
