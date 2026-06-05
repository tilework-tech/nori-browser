const { chromium } = require('playwright');

async function connectToBrowser(cdpPort) {
  const port = cdpPort || process.env.NORI_BROWSER_CDP_PORT || '19222';
  const cdpUrl = `http://localhost:${port}`;
  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());

  const page = pages.find((p) => {
    const url = p.url();
    return url.startsWith('http') && !url.includes('index.html');
  }) || pages[0];

  return { browser, page, contexts, pages };
}

module.exports = { connectToBrowser };

if (require.main === module) {
  connectToBrowser()
    .then(async ({ browser, page, pages }) => {
      console.log(`Connected to browser (${pages.length} page(s))`);
      console.log(`Current URL: ${page.url()}`);
      console.log(`Title: ${await page.title()}`);
      console.log('\nUse connectToBrowser() in your scripts to control the browser.');
      console.log(`CDP endpoint: http://localhost:${process.env.NORI_BROWSER_CDP_PORT || '19222'}`);
      await browser.close();
    })
    .catch((err) => {
      console.error('Failed to connect:', err.message);
      process.exit(1);
    });
}
