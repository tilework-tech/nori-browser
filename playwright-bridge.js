const { chromium } = require('playwright');

async function connectToBrowser(cdpPort) {
  const port = cdpPort || process.env.NORI_BROWSER_CDP_PORT || '19222';
  const cdpUrl = `http://localhost:${port}`;
  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());

  const page = pages.find((p) => !p.url().startsWith('file://')) || pages[0];

  return { browser, page, contexts, pages };
}

module.exports = { connectToBrowser };

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  run(command || 'status', args).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

async function run(command, args) {
  const { browser, page, pages } = await connectToBrowser();

  try {
    switch (command) {
      case 'status': {
        const url = page.url();
        const title = await page.title();
        console.log(`URL: ${url}`);
        console.log(`Title: ${title}`);
        console.log(`Pages: ${pages.length}`);
        console.log('STATUS_OK');
        break;
      }
      case 'navigate': {
        const url = args[0];
        if (!url) {
          console.error('Usage: playwright-bridge.js navigate <url>');
          process.exit(1);
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const title = await page.title();
        console.log(`Navigated to: ${url}`);
        console.log(`Title: ${title}`);
        console.log('NAVIGATE_OK');
        break;
      }
      case 'snapshot': {
        const snapshot = await page.accessibility.snapshot();
        console.log(JSON.stringify(snapshot, null, 2));
        console.log('SNAPSHOT_OK');
        break;
      }
      case 'click': {
        const selector = args[0];
        if (!selector) {
          console.error('Usage: playwright-bridge.js click <selector>');
          process.exit(1);
        }
        await page.click(selector);
        console.log(`Clicked: ${selector}`);
        console.log('CLICK_OK');
        break;
      }
      case 'fill': {
        const selector = args[0];
        const value = args.slice(1).join(' ');
        if (!selector || args.length < 2) {
          console.error('Usage: playwright-bridge.js fill <selector> <value>');
          process.exit(1);
        }
        await page.fill(selector, value);
        console.log(`Filled ${selector} with: ${value}`);
        console.log('FILL_OK');
        break;
      }
      case 'eval': {
        const expression = args.join(' ');
        if (!expression) {
          console.error('Usage: playwright-bridge.js eval <expression>');
          process.exit(1);
        }
        const result = await page.evaluate(expression);
        console.log(`Result: ${JSON.stringify(result)}`);
        console.log('EVAL_OK');
        break;
      }
      case 'content': {
        const text = await page.textContent('body');
        console.log(text || '(empty)');
        console.log('CONTENT_OK');
        break;
      }
      case 'screenshot': {
        const filePath = args[0] || '/tmp/nori-screenshot.png';
        await page.screenshot({ path: filePath });
        console.log(`Screenshot saved: ${filePath}`);
        console.log('SCREENSHOT_OK');
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Commands: status, navigate, snapshot, click, fill, eval, content, screenshot');
        process.exit(1);
    }
  } finally {
    await browser.close();
  }
}
