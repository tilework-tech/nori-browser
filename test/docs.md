# Noridoc: test

Path: @/test

### Overview

- End-to-end Playwright tests for the Nori Browser Electron app
- Tests launch the real Electron app with a local HTTP test server, verifying the full integration: UI elements, terminal I/O, URL bar navigation, CDP connectivity, environment variables, and the agent bridge CLI workflow

### How it fits into the larger codebase

- Run via `npm test`, which first builds `renderer/bundle.js` then runs `npx playwright test`
- Configured by `@/playwright.config.js`: 60s timeout, 1 retry, traces on first retry
- Tests use `NORI_BROWSER_SHELL=/bin/bash` to get a predictable terminal shell, and `NORI_BROWSER_CDP_PORT=19223` to avoid port collisions with a running dev instance
- Tests exercise the same bridge CLI commands (`navigate`, `status`, `eval`, `content`) that an agent would use in production, by typing them into the terminal and checking for status markers in terminal output

### Core Implementation

- **Test server**: A minimal `http.createServer` spun up in `beforeAll` on a random port, serving `/page-a` and `/page-b` HTML pages. Eliminates external network dependencies
- **Electron launch**: `electron.launch()` with the app's `main.js`, custom env vars, waits for `domcontentloaded` + 1s settle time
- **Terminal interaction pattern**: Tests click `.xterm-screen`, type a command via `window.keyboard`, then use `expect.poll()` to wait for expected output in the terminal's text content
- **Bridge CLI tests**: Verify the real agent workflow -- type `node $NORI_BROWSER_DIR/playwright-bridge.js <command>` into the terminal, wait for the status marker (e.g., `NAVIGATE_OK`, `STATUS_OK`), and cross-check browser state (URL bar value, page content)

### Things to Know

- All tests run in a single `test.describe` block sharing one Electron app instance. Test order matters -- later tests depend on browser state from earlier navigation
- Terminal output assertions use `expect.poll()` instead of `waitForTimeout` -- they poll the xterm screen's `textContent` until the expected string appears or timeout hits
- The test server listens on `127.0.0.1` with port `0` (OS-assigned) to avoid port conflicts
- Tests verify the four environment variables (`NORI_BROWSER_CDP_PORT`, `PLAYWRIGHT_CDP_URL`, `NODE_PATH`, `NORI_BROWSER_DIR`) are correctly injected into the terminal session

Created and maintained by Nori.
