# Noridoc: test

Path: @/test

### Overview

- Playwright-based integration tests that launch the full Electron app and exercise the terminal, browser, CDP connectivity, and IPC behaviors
- Tests run against a real Electron instance with `NORI_BROWSER_SHELL=/bin/bash` to avoid depending on nori/claude CLI availability

### How it fits into the larger codebase

- Tests are run via `npm test`, which first rebuilds `renderer/bundle.js` then executes `npx playwright test` using the config in `@/playwright.config.js`
- The test suite launches `@/main.js` as an Electron app using Playwright's `_electron.launch()`, overriding `NORI_BROWSER_SHELL` to use `/bin/bash` and `NORI_BROWSER_CDP_PORT` to use a non-default port (19223) to avoid collisions
- All tests share a single Electron app instance (`test.beforeAll` / `test.afterAll`), so test order matters -- earlier tests leave terminal history that later tests can see
- Tests verify behaviors across the full IPC chain: renderer -> preload -> main -> PTY -> main -> renderer

### Core Implementation

- **Terminal tests**: type commands into xterm.js via Playwright keyboard API, then read `.xterm-screen` text content to verify output appeared
- **CDP tests**: connect to the Electron browser via `chromium.connectOverCDP()` on the test CDP port, then navigate and verify page titles
- **ESC[6n test**: sends a `printf '\033[6n'` command through the terminal and verifies a cursor position response arrives within 100ms, confirming the main process intercepts and responds directly
- **Session directory test**: runs `pwd` in the terminal and verifies the output matches `~/nori-browser/YYYYMMDD-HHMMSS` pattern

### Things to Know

- Tests use a shared Electron instance, so a failing test can leave the terminal in a bad state for subsequent tests. The test order is sequential within the describe block.
- The `waitForTimeout` delays throughout the tests are necessary because terminal output arrives asynchronously via IPC. Reducing these can cause flaky failures.
- The CDP port is set to 19223 (not the default 19222) to prevent conflicts if the app is running normally during test execution.
- Playwright config (`@/playwright.config.js`) sets a 60-second timeout and 1 retry with traces on first retry.

Created and maintained by Nori.
