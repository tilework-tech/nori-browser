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
        NORI_BROWSER_HEADLESS: '1',
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

  test('window is hidden when NORI_BROWSER_HEADLESS is set', async () => {
    const isVisible = await electronApp.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0].isVisible();
    });
    expect(isVisible).toBe(false);
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

  test('system prompt contains network etiquette instructions', async () => {
    const socket = await connectControl();
    try {
      const output = await sendAndWait(socket, 'cat "$NORI_SESSION_DIR/system-prompt.txt"\n', 'random delay', 5000);
      expect(output).toContain('random delay');
      expect(output).toContain('exponential backoff');
      expect(output).toContain('robots.txt');
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

  test('maximizing window expands the rendered browser page', async () => {
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

      const bw = await electronApp.browserWindow(window);
      await bw.evaluate((win) => win.setSize(800, 600));
      await expect.poll(async () => {
        return await browserPage.evaluate(() => window.innerWidth);
      }, { timeout: 5000 }).toBeLessThan(500);

      const smallSize = await browserPage.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      await bw.evaluate((win) => {
        return new Promise(resolve => {
          win.once('show', () => setTimeout(resolve, 200));
          win.show();
        });
      });
      await bw.evaluate((win) => win.maximize());

      await expect.poll(async () => {
        return await browserPage.evaluate(() => window.innerWidth);
      }, { timeout: 5000 }).toBeGreaterThan(smallSize.width);

      const maxSize = await browserPage.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      expect(maxSize.height).toBeGreaterThan(smallSize.height);
    } finally {
      if (cdpBrowser) await cdpBrowser.close();
      const bw = await electronApp.browserWindow(window);
      await bw.evaluate((win) => {
        win.unmaximize();
        win.setSize(1400, 900);
        win.hide();
      });
    }
  });

  test('Ctrl+J hides sidebar and divider', async () => {
    const sidebarVisible = await window.$eval('#sidebar', el => el.offsetWidth > 0);
    const dividerVisible = await window.$eval('#divider', el => el.offsetWidth > 0);
    expect(sidebarVisible).toBe(true);
    expect(dividerVisible).toBe(true);

    await window.keyboard.press('Control+j');
    await window.waitForFunction(() => {
      const sidebar = document.querySelector('#sidebar');
      return sidebar.offsetWidth === 0;
    }, { timeout: 5000 });

    const sidebarHidden = await window.$eval('#sidebar', el => el.offsetWidth === 0);
    const dividerHidden = await window.$eval('#divider', el => el.offsetWidth === 0);
    expect(sidebarHidden).toBe(true);
    expect(dividerHidden).toBe(true);
  });

  test('Ctrl+J toggles sidebar back to visible', async () => {
    const sidebarHiddenBefore = await window.$eval('#sidebar', el => el.offsetWidth === 0);
    expect(sidebarHiddenBefore).toBe(true);

    await window.keyboard.press('Control+j');
    await window.waitForFunction(() => {
      const sidebar = document.querySelector('#sidebar');
      return sidebar.offsetWidth > 0;
    }, { timeout: 5000 });

    const sidebarVisible = await window.$eval('#sidebar', el => el.offsetWidth > 0);
    const dividerVisible = await window.$eval('#divider', el => el.offsetWidth > 0);
    expect(sidebarVisible).toBe(true);
    expect(dividerVisible).toBe(true);
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
        NORI_BROWSER_HEADLESS: '1',
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

  test('Ctrl+Shift+T reopens a closed tab with the correct URL', async () => {
    const urlBar = await window.$('#url-bar');

    // Navigate the active tab to a known URL
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-a`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-a');

    const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);

    // Close the active tab
    await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const fileMenu = menu.items.find(item => item.label === 'File');
      const closeItem = fileMenu.submenu.items.find(item => item.label === 'Close Tab');
      closeItem.click();
    });
    await window.waitForFunction(
      (c) => document.querySelectorAll('#tab-bar .tab').length === c - 1,
      countBefore
    );

    // Reopen via Reopen Closed Tab menu item
    await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const fileMenu = menu.items.find(item => item.label === 'File');
      const reopenItem = fileMenu.submenu.items.find(item => item.label === 'Reopen Closed Tab');
      reopenItem.click();
    });

    await window.waitForFunction(
      (c) => document.querySelectorAll('#tab-bar .tab').length === c,
      countBefore
    );

    // The reopened tab should be active and navigate to page-a
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-a');
  });

  test('Ctrl+Shift+T reopens tab at its original position', async () => {
    // Ensure we have at least 3 tabs
    while (await window.$$eval('#tab-bar .tab', els => els.length) < 3) {
      await window.click('#new-tab-btn');
    }
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length >= 3);

    const urlBar = await window.$('#url-bar');

    // Navigate each tab to a known URL for identification
    await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[0].click());
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-a`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-a');

    await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[1].click());
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-b`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-b');

    await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[2].click());
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-c`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-c');

    // Close the middle tab (index 1)
    await window.evaluate(() => {
      document.querySelectorAll('#tab-bar .tab')[1].querySelector('.tab-close').click();
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2);

    // Reopen the closed tab
    await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const fileMenu = menu.items.find(item => item.label === 'File');
      const reopenItem = fileMenu.submenu.items.find(item => item.label === 'Reopen Closed Tab');
      reopenItem.click();
    });

    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 3);

    // The reopened tab should be at index 1 and show page-b
    const activeIndex = await window.evaluate(() => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].classList.contains('active')) return i;
      }
      return -1;
    });
    expect(activeIndex).toBe(1);

    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-b');
  });

  test('middle-click on a tab closes it', async () => {
    // Ensure at least 2 tabs
    while (await window.$$eval('#tab-bar .tab', els => els.length) < 2) {
      await window.click('#new-tab-btn');
    }
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length >= 2);

    const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);

    // Middle-click on the first tab using evaluate to avoid stale element handles
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab');
      tab.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    });

    await window.waitForFunction(
      (c) => document.querySelectorAll('#tab-bar .tab').length === c - 1,
      countBefore
    );

    const countAfter = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(countAfter).toBe(countBefore - 1);
  });

  test('duplicate tab creates a new tab with the same URL', async () => {
    const urlBar = await window.$('#url-bar');

    // Navigate active tab to page-a
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-a`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-a');

    const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);

    // Duplicate the active tab via IPC
    await window.evaluate(() => {
      const activeTab = document.querySelector('#tab-bar .tab.active');
      window.api.duplicateTab(activeTab.dataset.tabId);
    });

    await window.waitForFunction(
      (c) => document.querySelectorAll('#tab-bar .tab').length === c + 1,
      countBefore
    );

    // The new (duplicated) tab should be active and show page-a
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-a');
  });

  test('close other tabs removes all except the target', async () => {
    const count = await window.$$eval('#tab-bar .tab', els => els.length);
    if (count < 2) {
      await window.click('#new-tab-btn');
      await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length >= 2);
    }

    expect(await window.$$eval('#tab-bar .tab', els => els.length)).toBeGreaterThan(1);

    // Close all tabs except the active one
    await window.evaluate(() => {
      const activeTab = document.querySelector('#tab-bar .tab.active');
      window.api.closeOtherTabs(activeTab.dataset.tabId);
    });

    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 1);

    const remaining = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(remaining).toBe(1);

    const activeTab = await window.$('#tab-bar .tab.active');
    expect(activeTab).toBeTruthy();
  });

  test('close tabs to the right removes tabs after the target', async () => {
    // Create 2 more tabs so we have 3
    await window.click('#new-tab-btn');
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 3);

    // Switch to the first tab (index 0)
    await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[0].click());

    // Close tabs to the right of the first tab
    await window.evaluate(() => {
      const firstTab = document.querySelectorAll('#tab-bar .tab')[0];
      window.api.closeTabsToRight(firstTab.dataset.tabId);
    });

    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 1);

    const remaining = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(remaining).toBe(1);
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

test.describe('Nori Browser Tab Pinning', () => {
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
        NORI_BROWSER_CDP_PORT: String(CDP_PORT + 20),
        NORI_BROWSER_CONTROL_PORT: String(CONTROL_PORT + 20),
        NORI_BROWSER_HEADLESS: '1',
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

    await window.waitForSelector('#tab-bar', { timeout: 10000 });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
      electronApp = null;
    }
    if (testServer) await new Promise((resolve) => testServer.close(resolve));
  });

  test('pinned tab renders without visible close button', async () => {
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab');
      window.api.pinTab(tab.dataset.tabId);
    });

    await window.waitForFunction(() => {
      return document.querySelector('#tab-bar .tab.pinned') !== null;
    }, { timeout: 5000 });

    const hasCloseButton = await window.evaluate(() => {
      const pinnedTab = document.querySelector('#tab-bar .tab.pinned');
      return pinnedTab.querySelector('.tab-close') !== null;
    });
    expect(hasCloseButton).toBe(false);

    // Unpin to reset
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab.pinned');
      window.api.unpinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') === null, { timeout: 5000 });
  });

  test('pinned tab renders narrower than unpinned tab', async () => {
    // Create a second tab so we have both pinned and unpinned
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2);

    // Pin the first tab
    await window.evaluate(() => {
      const tab = document.querySelectorAll('#tab-bar .tab')[0];
      window.api.pinTab(tab.dataset.tabId);
    });

    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    const widths = await window.evaluate(() => {
      const pinned = document.querySelector('#tab-bar .tab.pinned');
      const unpinned = document.querySelector('#tab-bar .tab:not(.pinned)');
      return { pinnedWidth: pinned.offsetWidth, unpinnedWidth: unpinned.offsetWidth };
    });

    expect(widths.pinnedWidth).toBeLessThan(widths.unpinnedWidth);

    // Unpin and close extra tab to reset
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab.pinned');
      window.api.unpinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') === null, { timeout: 5000 });
    await window.evaluate(() => {
      document.querySelectorAll('#tab-bar .tab')[1].querySelector('.tab-close').click();
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 1, { timeout: 5000 });
  });

  test('pinning a non-first tab moves it to the left', async () => {
    // Create 3 tabs total
    await window.click('#new-tab-btn');
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 3);

    // Navigate the 3rd tab to a known URL for identification
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-c`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-c');

    // Get the 3rd tab's ID
    const thirdTabId = await window.evaluate(() => {
      return document.querySelectorAll('#tab-bar .tab')[2].dataset.tabId;
    });

    // Pin the 3rd tab — it should move to position 0
    await window.evaluate((tabId) => {
      window.api.pinTab(tabId);
    }, thirdTabId);

    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    // The pinned tab should now be at index 0
    const pinnedIndex = await window.evaluate(() => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].classList.contains('pinned')) return i;
      }
      return -1;
    });
    expect(pinnedIndex).toBe(0);

    // Clean up: unpin and close extra tabs
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab.pinned');
      window.api.unpinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') === null, { timeout: 5000 });
    while (await window.$$eval('#tab-bar .tab', els => els.length) > 1) {
      const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);
      await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[1].querySelector('.tab-close').click());
      await window.waitForFunction((c) => document.querySelectorAll('#tab-bar .tab').length < c, countBefore, { timeout: 5000 });
    }
  });

  test('unpinning moves tab to first unpinned position', async () => {
    // Create 3 tabs
    await window.click('#new-tab-btn');
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 3);

    // Pin the first two tabs
    await window.evaluate(() => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      window.api.pinTab(tabs[0].dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 1, { timeout: 5000 });

    await window.evaluate(() => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      window.api.pinTab(tabs[1].dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 2, { timeout: 5000 });

    // Get the first pinned tab's ID
    const firstPinnedId = await window.evaluate(() => {
      return document.querySelectorAll('#tab-bar .tab.pinned')[0].dataset.tabId;
    });

    // Unpin the first pinned tab — it should move to index 1 (after the remaining pinned tab)
    await window.evaluate((tabId) => {
      window.api.unpinTab(tabId);
    }, firstPinnedId);

    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 1, { timeout: 5000 });

    // The unpinned tab should now be at the first unpinned position (index 1)
    const unpinnedTabPosition = await window.evaluate((tabId) => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].dataset.tabId === tabId) return i;
      }
      return -1;
    }, firstPinnedId);
    expect(unpinnedTabPosition).toBe(1);

    // Clean up
    await window.evaluate(() => {
      const pinned = document.querySelector('#tab-bar .tab.pinned');
      if (pinned) window.api.unpinTab(pinned.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 0, { timeout: 5000 });
    while (await window.$$eval('#tab-bar .tab', els => els.length) > 1) {
      const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);
      await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[1].querySelector('.tab-close').click());
      await window.waitForFunction((c) => document.querySelectorAll('#tab-bar .tab').length < c, countBefore, { timeout: 5000 });
    }
  });

  test('middle-click closes a pinned tab', async () => {
    // Create a second tab
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2);

    // Pin the first tab
    await window.evaluate(() => {
      const tab = document.querySelectorAll('#tab-bar .tab')[0];
      window.api.pinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    // Middle-click on the pinned tab
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab.pinned');
      tab.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    });

    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 1, { timeout: 5000 });

    const count = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(count).toBe(1);
  });

  test('Ctrl+W closes a pinned tab via menu accelerator', async () => {
    // Create a second tab, pin the first
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2);

    // Switch to first tab and pin it
    await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[0].click());
    await window.evaluate(() => {
      const tab = document.querySelectorAll('#tab-bar .tab')[0];
      window.api.pinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    // Close via menu accelerator (Ctrl+W)
    await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const fileMenu = menu.items.find(item => item.label === 'File');
      const closeTabItem = fileMenu.submenu.items.find(item => item.label === 'Close Tab');
      closeTabItem.click();
    });

    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 1, { timeout: 5000 });

    const count = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(count).toBe(1);
  });

  test('closeOtherTabs skips pinned tabs', async () => {
    // Create 3 tabs total
    await window.click('#new-tab-btn');
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 3);

    // Pin the first tab
    await window.evaluate(() => {
      const tab = document.querySelectorAll('#tab-bar .tab')[0];
      window.api.pinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    // Switch to the second tab (unpinned) and close other tabs
    await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[1].click());
    await window.evaluate(() => {
      const activeTab = document.querySelector('#tab-bar .tab.active');
      window.api.closeOtherTabs(activeTab.dataset.tabId);
    });

    // Should have 2 tabs remaining: the pinned one and the target
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2, { timeout: 5000 });

    const pinnedCount = await window.$$eval('#tab-bar .tab.pinned', els => els.length);
    expect(pinnedCount).toBe(1);

    const totalCount = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(totalCount).toBe(2);

    // Clean up
    await window.evaluate(() => {
      const pinned = document.querySelector('#tab-bar .tab.pinned');
      if (pinned) window.api.unpinTab(pinned.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 0, { timeout: 5000 });
    while (await window.$$eval('#tab-bar .tab', els => els.length) > 1) {
      const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);
      await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[1].querySelector('.tab-close').click());
      await window.waitForFunction((c) => document.querySelectorAll('#tab-bar .tab').length < c, countBefore, { timeout: 5000 });
    }
  });

  test('closeTabsToRight skips pinned tabs', async () => {
    // Create 3 tabs
    await window.click('#new-tab-btn');
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 3);

    // Navigate the 3rd tab to page-c for identification
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-c`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-c');

    // Pin the 3rd tab (it moves to position 0 in the pinned zone)
    await window.evaluate(() => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      window.api.pinTab(tabs[2].dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    // Now: [pinned-pageC, unpinned-1, unpinned-2]
    // Switch to the first unpinned tab (index 1) and close tabs to the right
    await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[1].click());
    await window.evaluate(() => {
      const tab = document.querySelectorAll('#tab-bar .tab')[1];
      window.api.closeTabsToRight(tab.dataset.tabId);
    });

    // The last unpinned tab should be closed, pinned tab survives
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2, { timeout: 5000 });

    const pinnedCount = await window.$$eval('#tab-bar .tab.pinned', els => els.length);
    expect(pinnedCount).toBe(1);

    // Clean up
    await window.evaluate(() => {
      const pinned = document.querySelector('#tab-bar .tab.pinned');
      if (pinned) window.api.unpinTab(pinned.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 0, { timeout: 5000 });
    while (await window.$$eval('#tab-bar .tab', els => els.length) > 1) {
      const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);
      await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[1].querySelector('.tab-close').click());
      await window.waitForFunction((c) => document.querySelectorAll('#tab-bar .tab').length < c, countBefore, { timeout: 5000 });
    }
  });

  test('reorder cannot move pinned tab past the unpinned boundary', async () => {
    // Create 2 tabs, pin the first
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2);

    await window.evaluate(() => {
      const tab = document.querySelectorAll('#tab-bar .tab')[0];
      window.api.pinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    const pinnedId = await window.evaluate(() => document.querySelector('#tab-bar .tab.pinned').dataset.tabId);

    // Try to reorder the pinned tab to position 1 (unpinned zone)
    await window.evaluate((tabId) => {
      window.api.reorderTab(tabId, 1);
    }, pinnedId);

    // Wait for any tabs-changed event to be processed
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2, { timeout: 5000 });

    // The pinned tab should still be at position 0
    const pinnedPosition = await window.evaluate((tabId) => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].dataset.tabId === tabId) return i;
      }
      return -1;
    }, pinnedId);
    expect(pinnedPosition).toBe(0);

    // Clean up
    await window.evaluate(() => {
      const pinned = document.querySelector('#tab-bar .tab.pinned');
      if (pinned) window.api.unpinTab(pinned.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 0, { timeout: 5000 });
    await window.evaluate(() => {
      document.querySelectorAll('#tab-bar .tab')[1].querySelector('.tab-close').click();
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 1, { timeout: 5000 });
  });

  test('reorder cannot move unpinned tab into pinned zone', async () => {
    // Create 2 tabs, pin the first
    await window.click('#new-tab-btn');
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2);

    await window.evaluate(() => {
      const tab = document.querySelectorAll('#tab-bar .tab')[0];
      window.api.pinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    const unpinnedId = await window.evaluate(() => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      for (let i = 0; i < tabs.length; i++) {
        if (!tabs[i].classList.contains('pinned')) return tabs[i].dataset.tabId;
      }
      return null;
    });

    // Try to move the unpinned tab to position 0 (pinned zone)
    await window.evaluate((tabId) => {
      window.api.reorderTab(tabId, 0);
    }, unpinnedId);

    // Wait for any tabs-changed event to be processed
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2, { timeout: 5000 });

    // The unpinned tab should still be at position 1
    const unpinnedPosition = await window.evaluate((tabId) => {
      const tabs = document.querySelectorAll('#tab-bar .tab');
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].dataset.tabId === tabId) return i;
      }
      return -1;
    }, unpinnedId);
    expect(unpinnedPosition).toBe(1);

    // Clean up
    await window.evaluate(() => {
      const pinned = document.querySelector('#tab-bar .tab.pinned');
      if (pinned) window.api.unpinTab(pinned.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 0, { timeout: 5000 });
    await window.evaluate(() => {
      document.querySelectorAll('#tab-bar .tab')[1].querySelector('.tab-close').click();
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 1, { timeout: 5000 });
  });

  test('getTabs reports pinned state correctly after pin and unpin', async () => {
    // Pin the tab and verify the API reports it as pinned
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab');
      window.api.pinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    const pinnedTabs = await window.evaluate(async () => {
      const data = await window.api.getTabs();
      return data.tabs.filter(t => t.pinned);
    });
    expect(pinnedTabs.length).toBe(1);

    // Unpin and verify the API no longer reports any pinned tabs
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab.pinned');
      window.api.unpinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') === null, { timeout: 5000 });

    const pinnedTabsAfter = await window.evaluate(async () => {
      const data = await window.api.getTabs();
      return data.tabs.filter(t => t.pinned);
    });
    expect(pinnedTabsAfter.length).toBe(0);
  });

  test('duplicate of a pinned tab is unpinned', async () => {
    // Pin the tab
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab');
      window.api.pinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    // Duplicate the pinned tab
    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab.pinned');
      window.api.duplicateTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab').length === 2, { timeout: 5000 });

    // The new tab should NOT be pinned
    const pinnedCount = await window.$$eval('#tab-bar .tab.pinned', els => els.length);
    expect(pinnedCount).toBe(1);

    const totalCount = await window.$$eval('#tab-bar .tab', els => els.length);
    expect(totalCount).toBe(2);

    // Clean up
    await window.evaluate(() => {
      const pinned = document.querySelector('#tab-bar .tab.pinned');
      if (pinned) window.api.unpinTab(pinned.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 0, { timeout: 5000 });
    while (await window.$$eval('#tab-bar .tab', els => els.length) > 1) {
      const countBefore = await window.$$eval('#tab-bar .tab', els => els.length);
      await window.evaluate(() => document.querySelectorAll('#tab-bar .tab')[1].querySelector('.tab-close').click());
      await window.waitForFunction((c) => document.querySelectorAll('#tab-bar .tab').length < c, countBefore, { timeout: 5000 });
    }
  });
});

test.describe('Nori Browser Tab Favicons & Loading', () => {
  let electronApp;
  let window;

  let testServer;
  let testServerPort;

  const TINY_ICON = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  test.beforeAll(async () => {
    testServer = http.createServer((req, res) => {
      if (req.url === '/favicon-test.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        res.end(TINY_ICON);
      } else if (req.url === '/favicon-test-b.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        res.end(TINY_ICON);
      } else if (req.url === '/page-with-favicon') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>Favicon Page</title><link rel="icon" href="/favicon-test.png"></head><body><h1>Has Favicon</h1></body></html>`);
      } else if (req.url === '/page-with-favicon-b') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>Favicon Page B</title><link rel="icon" href="/favicon-test-b.png"></head><body><h1>Has Favicon B</h1></body></html>`);
      } else if (req.url === '/slow-page') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><head><title>Slow Page</title></head><body><h1>Finally Loaded</h1></body></html>');
        }, 3000);
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
        NORI_BROWSER_CDP_PORT: String(CDP_PORT + 30),
        NORI_BROWSER_CONTROL_PORT: String(CONTROL_PORT + 30),
        NORI_BROWSER_HEADLESS: '1',
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

    await window.waitForSelector('#tab-bar', { timeout: 10000 });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
      electronApp = null;
    }
    if (testServer) await new Promise((resolve) => testServer.close(resolve));
  });

  test('tab displays favicon after navigating to a page with one', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-with-favicon`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-with-favicon');

    await expect.poll(async () => {
      return await window.evaluate(() => {
        const tab = document.querySelector('#tab-bar .tab.active');
        const img = tab && tab.querySelector('.tab-favicon');
        return img ? img.src : '';
      });
    }, { timeout: 10000 }).toContain('/favicon-test.png');
  });

  test('favicon updates when navigating to a different page', async () => {
    const urlBar = await window.$('#url-bar');

    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-with-favicon`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-with-favicon');
    await expect.poll(async () => {
      return await window.evaluate(() => {
        const tab = document.querySelector('#tab-bar .tab.active');
        const img = tab && tab.querySelector('.tab-favicon');
        return img ? img.src : '';
      });
    }, { timeout: 10000 }).toContain('/favicon-test.png');

    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-with-favicon-b`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-with-favicon-b');

    await expect.poll(async () => {
      return await window.evaluate(() => {
        const tab = document.querySelector('#tab-bar .tab.active');
        const img = tab && tab.querySelector('.tab-favicon');
        return img ? img.src : '';
      });
    }, { timeout: 10000 }).toContain('/favicon-test-b.png');
  });

  test('loading spinner appears during navigation and disappears after', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/slow-page`);
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.evaluate(() => {
        const tab = document.querySelector('#tab-bar .tab.active');
        return tab ? tab.querySelector('.tab-spinner') !== null : false;
      });
    }, { timeout: 5000 }).toBe(true);

    await expect.poll(async () => {
      return await window.evaluate(() => {
        const tab = document.querySelector('#tab-bar .tab.active');
        return tab ? tab.querySelector('.tab-spinner') === null : false;
      });
    }, { timeout: 10000 }).toBe(true);
  });

  test('getTabs API includes favicon URL for a page that has one', async () => {
    // The active tab should still be on page-with-favicon or slow-page from prior tests.
    // Navigate to a page with a known favicon to ensure clean state.
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-with-favicon`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-with-favicon');

    await expect.poll(async () => {
      const data = await window.evaluate(async () => await window.api.getTabs());
      const activeTab = data.tabs.find(t => t.id === data.activeTabId);
      return activeTab ? activeTab.favicon : '';
    }, { timeout: 10000 }).toContain('/favicon-test.png');
  });

  test('pinned tab shows favicon image', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}/page-with-favicon`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 }).toContain('/page-with-favicon');

    await expect.poll(async () => {
      return await window.evaluate(() => {
        const tab = document.querySelector('#tab-bar .tab.active');
        const img = tab && tab.querySelector('.tab-favicon');
        return img ? img.src : '';
      });
    }, { timeout: 10000 }).toContain('/favicon-test.png');

    await window.evaluate(() => {
      const tab = document.querySelector('#tab-bar .tab.active');
      window.api.pinTab(tab.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelector('#tab-bar .tab.pinned') !== null, { timeout: 5000 });

    await expect.poll(async () => {
      return await window.evaluate(() => {
        const pinnedTab = document.querySelector('#tab-bar .tab.pinned');
        const img = pinnedTab && pinnedTab.querySelector('.tab-favicon');
        return img !== null && img.offsetWidth > 0 && img.offsetHeight > 0;
      });
    }, { timeout: 5000 }).toBe(true);

    // Clean up: unpin
    await window.evaluate(() => {
      const pinned = document.querySelector('#tab-bar .tab.pinned');
      if (pinned) window.api.unpinTab(pinned.dataset.tabId);
    });
    await window.waitForFunction(() => document.querySelectorAll('#tab-bar .tab.pinned').length === 0, { timeout: 5000 });
  });
});

test.describe('Nori Browser Search', () => {
  let electronApp;
  let window;

  let testServer;
  let testServerPort;

  test.beforeAll(async () => {
    testServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Test</title></head><body><h1>Test</h1></body></html>');
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
        NORI_BROWSER_CDP_PORT: String(CDP_PORT + 40),
        NORI_BROWSER_CONTROL_PORT: String(CONTROL_PORT + 40),
        NORI_BROWSER_HEADLESS: '1',
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

    await window.waitForSelector('#tab-bar', { timeout: 10000 });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
      electronApp = null;
    }
    if (testServer) await new Promise((resolve) => testServer.close(resolve));
  });

  test('typing a single-word search query navigates to Google search', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill('cats');
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 15000 })
      .toContain('google.com/search?q=cats');
  });

  test('typing a multi-word search query navigates to Google search', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill('best pizza near me');
    await window.keyboard.press('Enter');
    await expect.poll(async () => {
      const val = await urlBar.inputValue();
      return val.includes('google.com/search') && val.includes('near');
    }, { timeout: 15000 }).toBe(true);
  });

  test('typing a full URL with protocol navigates directly', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`http://127.0.0.1:${testServerPort}`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => await urlBar.inputValue(), { timeout: 10000 })
      .toContain(`127.0.0.1:${testServerPort}`);
  });

  test('typing an IP address without protocol navigates as URL', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`127.0.0.1:${testServerPort}/ip-test`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => {
      const val = await urlBar.inputValue();
      return val.startsWith('http://') && val.includes('/ip-test');
    }, { timeout: 10000 }).toBe(true);
  });

  test('typing a search query with special characters navigates to Google search', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill('cats & dogs');
    await window.keyboard.press('Enter');
    await expect.poll(async () => {
      const val = await urlBar.inputValue();
      return val.includes('google.com/search') && val.includes('dogs');
    }, { timeout: 15000 }).toBe(true);
  });

  test('typing localhost with port navigates as URL not search', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill(`localhost:${testServerPort}/localhost-test`);
    await window.keyboard.press('Enter');
    await expect.poll(async () => {
      const val = await urlBar.inputValue();
      return val.startsWith('http://') && val.includes('/localhost-test');
    }, { timeout: 10000 }).toBe(true);
  });
});
