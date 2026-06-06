const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');

const CDP_PORT = 19223;
const APP_PATH = path.join(__dirname, '..');

let testServer;
let testServerPort;

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
    await window.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
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

  test('terminal accepts input and shows output', async () => {
    await window.waitForSelector('.xterm-screen', { timeout: 5000 });
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('echo NORI_TEST_OUTPUT_12345');
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.$eval('.xterm-screen', (el) => el.textContent);
    }, { timeout: 5000 }).toContain('NORI_TEST_OUTPUT_12345');
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

  test('terminal has NORI_BROWSER_DIR and NODE_PATH environment variables', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('echo NODEPATH_CHK=$NODE_PATH');
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.$eval('.xterm-screen', (el) => el.textContent);
    }, { timeout: 5000 }).toContain('node_modules');

    await window.keyboard.type('ls $NORI_BROWSER_DIR/playwright-bridge.js && echo BRIDGE_FOUND_OK');
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.$eval('.xterm-screen', (el) => el.textContent);
    }, { timeout: 5000 }).toContain('BRIDGE_FOUND_OK');
  });

  test('terminal has CDP environment variables', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('echo CDP_PORT=$NORI_BROWSER_CDP_PORT');
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.$eval('.xterm-screen', (el) => el.textContent);
    }, { timeout: 5000 }).toContain(`CDP_PORT=${CDP_PORT}`);

    await window.keyboard.type('echo PW_CDP=$PLAYWRIGHT_CDP_URL');
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.$eval('.xterm-screen', (el) => el.textContent);
    }, { timeout: 5000 }).toContain(`PW_CDP=http://localhost:${CDP_PORT}`);
  });

  test('agent can use playwright-bridge.js from terminal to navigate browser', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    const navUrl = `http://127.0.0.1:${testServerPort}/page-a`;
    await window.keyboard.type(`node $NORI_BROWSER_DIR/playwright-bridge.js navigate '${navUrl}'`);
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.$eval('.xterm-screen', (el) => el.textContent);
    }, { timeout: 15000 }).toContain('NAVIGATE_OK');

    const urlBar = await window.$('#url-bar');
    await expect.poll(async () => {
      return await urlBar.inputValue();
    }, { timeout: 5000 }).toContain(`127.0.0.1:${testServerPort}/page-a`);
  });

  test('agent can use playwright-bridge.js from terminal to get page status', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('node $NORI_BROWSER_DIR/playwright-bridge.js status');
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.$eval('.xterm-screen', (el) => el.textContent);
    }, { timeout: 15000 }).toContain('STATUS_OK');
  });

  test('agent can use playwright-bridge.js to evaluate JavaScript on page', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type(`node $NORI_BROWSER_DIR/playwright-bridge.js eval 'document.title'`);
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.$eval('.xterm-screen', (el) => el.textContent);
    }, { timeout: 15000 }).toContain('EVAL_OK');
  });

  test('agent can use playwright-bridge.js to get page content', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('node $NORI_BROWSER_DIR/playwright-bridge.js content');
    await window.keyboard.press('Enter');

    await expect.poll(async () => {
      return await window.$eval('.xterm-screen', (el) => el.textContent);
    }, { timeout: 15000 }).toContain('CONTENT_OK');
  });
});
