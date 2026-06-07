# Noridoc: test

Path: @/test

### Overview

- End-to-end Playwright tests for the Nori Browser Electron app
- Tests launch the real Electron app with a local HTTP test server, verifying the full integration: UI elements, terminal I/O, URL bar navigation, CDP connectivity, environment variables, window state transitions (resize, maximize), session directory lifecycle, the agent bridge CLI workflow, and multi-tab operations

### How it fits into the larger codebase

- Run via `npm test`, which first builds `renderer/bundle.js` then runs `npx playwright test`
- Configured by `@/playwright.config.js`: 60s timeout, 1 retry, traces on first retry
- Tests use `NORI_BROWSER_SHELL=/bin/bash` to get a predictable terminal shell, `NORI_BROWSER_HEADLESS=1` to prevent visible Electron windows from appearing, and offset CDP/control ports to avoid collisions with a running dev instance
- Tests exercise the same bridge CLI commands (`navigate`, `status`, `eval`, `content`, `list-tabs`) that an agent would use in production
- Tests also verify keyboard shortcuts (Ctrl+J sidebar toggle) by simulating keypresses and asserting DOM visibility changes

### Core Implementation

- **Test server**: A minimal `http.createServer` spun up in `beforeAll` on a random port, serving test HTML pages. Eliminates external network dependencies
- **Electron launch**: `electron.launch()` with the app's `main.js`, custom env vars, waits for the renderer window and control socket to be ready
- **Terminal interaction**: Tests use a TCP control socket (`connectControl()` / `sendAndWait()`) to send commands and wait for marker strings in terminal output. This is more reliable than UI-based xterm interaction
- **Test suites**: The tests are split into `test.describe` blocks, each with its own Electron app instance and distinct CDP/control port offsets to avoid collisions. Suites cover core functionality, tab management, tab pinning, favicons/loading indicators, and omnibox search classification
- **Bridge CLI tests**: Verify the real agent workflow -- send bridge commands via the control socket or `execSync`, wait for status markers (e.g., `NAVIGATE_OK`, `LIST_TABS_OK`), and cross-check browser state
- **Session directory tests**: Verify `NORI_SESSION_DIR` env var is set, `system-prompt.txt` exists with correct CDP port and bridge path, system prompt contains network etiquette instructions (random delays, exponential backoff, robots.txt), and that the session directory is removed when the app closes

### Things to Know

- Within each `test.describe` block, tests share one Electron app instance and test order matters -- later tests depend on browser/tab state from earlier tests
- Each suite uses its own port offsets (`CDP_PORT + 0`, `+ 10`, `+ 20`, `+ 30`, `+ 40`) so all suites can run independently without port collisions
- The session cleanup test and the "closing the last tab closes the window" test both close the Electron app and must run last within their respective suites. The `afterAll` handlers guard against a null `electronApp`
- Tab tests use `window.evaluate()` to click tab elements rather than direct Playwright selectors to avoid stale element handles after tab list re-renders
- The maximize test must temporarily call `win.show()` before `win.maximize()` because `maximize()` is a window-manager operation that requires the window to be mapped. The test re-hides the window in a `finally` block
- Menu accelerator tests (Ctrl+T, Ctrl+W, Ctrl+Shift+T) use `electronApp.evaluate(({ Menu }) => ...)` to invoke menu items from the main process rather than simulating keyboard shortcuts, because Electron menu accelerators are not reliably triggered by Playwright keypresses in CI

Created and maintained by Nori.
