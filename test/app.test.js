const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const { chromium } = require('playwright');
const path = require('path');

const CDP_PORT = 19223;
const APP_PATH = path.join(__dirname, '..');

test.describe('Nori Browser', () => {
  let electronApp;
  let window;

  test.beforeAll(async () => {
    electronApp = await electron.launch({
      args: [path.join(APP_PATH, 'main.js')],
      env: {
        ...process.env,
        NORI_BROWSER_SHELL: '/bin/bash',
        NORI_BROWSER_CDP_PORT: String(CDP_PORT),
      },
    });
    window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(1000);
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test('window opens with sidebar, terminal, toolbar, and URL bar', async () => {
    const sidebar = await window.$('#sidebar');
    expect(sidebar).toBeTruthy();

    const terminal = await window.$('#terminal-container');
    expect(terminal).toBeTruthy();

    const toolbar = await window.$('#toolbar');
    expect(toolbar).toBeTruthy();

    const urlBar = await window.$('#url-bar');
    expect(urlBar).toBeTruthy();

    const btnBack = await window.$('#btn-back');
    expect(btnBack).toBeTruthy();

    const btnForward = await window.$('#btn-forward');
    expect(btnForward).toBeTruthy();

    const btnReload = await window.$('#btn-reload');
    expect(btnReload).toBeTruthy();
  });

  test('terminal renders xterm and accepts input', async () => {
    await window.waitForSelector('.xterm-screen', { timeout: 5000 });

    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('echo NORI_TEST_OUTPUT_12345');
    await window.keyboard.press('Enter');
    await window.waitForTimeout(1500);

    const terminalText = await window.$eval(
      '.xterm-screen',
      (el) => el.textContent
    );
    expect(terminalText).toContain('NORI_TEST_OUTPUT_12345');
  });

  test('terminal output is routed back from the process', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('echo RESPONSE_CHECK_67890');
    await window.keyboard.press('Enter');
    await window.waitForTimeout(1500);

    const terminalText = await window.$eval(
      '.xterm-screen',
      (el) => el.textContent
    );
    expect(terminalText).toContain('RESPONSE_CHECK_67890');
  });

  test('URL bar accepts input and triggers navigation', async () => {
    const urlBar = await window.$('#url-bar');
    await urlBar.click({ clickCount: 3 });
    await urlBar.fill('https://example.com');
    await window.keyboard.press('Enter');

    await window.waitForTimeout(3000);

    const currentUrl = await urlBar.inputValue();
    expect(currentUrl).toContain('example.com');
  });

  test('playwright can connect via CDP and see browser pages', async () => {
    let cdpBrowser;
    try {
      cdpBrowser = await chromium.connectOverCDP(
        `http://localhost:${CDP_PORT}`
      );

      const contexts = cdpBrowser.contexts();
      expect(contexts.length).toBeGreaterThan(0);

      const allPages = contexts.flatMap((c) => c.pages());
      expect(allPages.length).toBeGreaterThan(0);
    } finally {
      if (cdpBrowser) await cdpBrowser.close();
    }
  });

  test('playwright can navigate the browser view via CDP', async () => {
    let cdpBrowser;
    try {
      cdpBrowser = await chromium.connectOverCDP(
        `http://localhost:${CDP_PORT}`
      );

      const contexts = cdpBrowser.contexts();
      const allPages = contexts.flatMap((c) => c.pages());

      const browserPage = allPages.find((p) => {
        const url = p.url();
        return !url.startsWith('file://');
      });
      expect(browserPage).toBeTruthy();

      await browserPage.goto('https://example.com');
      const title = await browserPage.title();
      expect(title).toContain('Example');
    } finally {
      if (cdpBrowser) await cdpBrowser.close();
    }
  });

  test('CDP port environment variable is available in terminal', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('echo CDP_PORT=$NORI_BROWSER_CDP_PORT');
    await window.keyboard.press('Enter');
    await window.waitForTimeout(1000);

    const terminalText = await window.$eval(
      '.xterm-screen',
      (el) => el.textContent
    );
    expect(terminalText).toContain(`CDP_PORT=${CDP_PORT}`);
  });

  test('sidebar divider exists and has correct initial width', async () => {
    const divider = await window.$('#divider');
    expect(divider).toBeTruthy();

    const sidebarWidth = await window.$eval(
      '#sidebar',
      (el) => el.offsetWidth
    );
    expect(sidebarWidth).toBe(400);
  });

  test('PLAYWRIGHT_CDP_URL environment variable is available in terminal', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('echo PW_CDP=$PLAYWRIGHT_CDP_URL');
    await window.keyboard.press('Enter');
    await window.waitForTimeout(1000);

    const terminalText = await window.$eval(
      '.xterm-screen',
      (el) => el.textContent
    );
    expect(terminalText).toContain(`PW_CDP=http://localhost:${CDP_PORT}`);
  });

  test('cursor position query (ESC[6n) gets a response without crashing', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type("printf '\\033[6n' && read -t 0.5 -s -d R resp && echo CPR_OK || echo CPR_FAIL");
    await window.keyboard.press('Enter');
    await window.waitForTimeout(2000);

    const terminalText = await window.$eval(
      '.xterm-screen',
      (el) => el.textContent
    );
    expect(terminalText).toContain('CPR_OK');
  });

  test('terminal process starts in a session directory under ~/nori-browser/', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    await window.keyboard.type('pwd');
    await window.keyboard.press('Enter');
    await window.waitForTimeout(1000);

    const terminalText = await window.$eval(
      '.xterm-screen',
      (el) => el.textContent
    );
    expect(terminalText).toMatch(/\/nori-browser\/\d{8}-\d{6}/);
  });

  test('playwright script in terminal can control the browser via CDP', async () => {
    const terminalEl = await window.$('.xterm-screen');
    await terminalEl.click();

    const script = [
      `node -e "const{chromium}=require('playwright');`,
      `(async()=>{`,
      `const b=await chromium.connectOverCDP('http://localhost:${CDP_PORT}');`,
      `const pages=b.contexts().flatMap(c=>c.pages());`,
      `const p=pages.find(pg=>!pg.url().startsWith('file://'));`,
      `await p.goto('https://example.com');`,
      `console.log('E2E_NAV_OK:'+await p.title());`,
      `await b.close();`,
      `})()"`,
    ].join('');

    await window.keyboard.type(script);
    await window.keyboard.press('Enter');
    await window.waitForTimeout(8000);

    const terminalText = await window.$eval(
      '.xterm-screen',
      (el) => el.textContent
    );
    expect(terminalText).toContain('E2E_NAV_OK:');

    const urlBar = await window.$('#url-bar');
    const currentUrl = await urlBar.inputValue();
    expect(currentUrl).toContain('example.com');
  });
});
