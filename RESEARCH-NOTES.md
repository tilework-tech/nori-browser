# Research Notes

## Architecture
- Electron app using BrowserView (not webview tag) for browser content
- Single main process (main.js) manages window, BrowserView, terminal (node-pty), control socket
- Renderer process (renderer.js) handles terminal UI (xterm.js), URL bar, toolbar
- Preload.js bridges IPC between renderer and main process
- playwright-bridge.js provides CLI interface for agent to control browser via CDP

## Key Constraints
- BrowserView is used for the web content area (not an iframe or webview tag)
- The app currently supports only a single BrowserView (single tab)
- Tab support will require managing multiple BrowserViews

## Tab Support Research

### BrowserView Deprecation
- `BrowserView` is deprecated since Electron 30. In Electron 33 it is a wrapper around `WebContentsView`.
- Replace with `WebContentsView` which extends `View` base class.
- Migration: `new BrowserView()` -> `new WebContentsView()`, `win.setBrowserView()` -> `win.contentView.addChildView()`.

### Tab Switching Strategy
- **Use `view.setVisible(boolean)`** — recommended approach.
- `addChildView/removeChildView` cycling causes flickering (Electron issue #43961).
- `setBounds(0,0,0,0)` hack breaks `innerWidth` and `visibilityState` (issue #44590).
- `setVisible(false)` hides without detaching — no flickering, state preserved.
- `getVisible()` NOT available in Electron 33 — track visibility state manually.

### Tab Management Architecture
- Store tabs in a `Map<tabId, { view, url, title }>` structure.
- Track `activeTabId` separately.
- On switch: `setVisible(false)` on old, `setVisible(true)` on new.
- On create: `new WebContentsView()`, `addChildView()`, set bounds, set active.
- On close: `removeChildView()`, `view.webContents.close()`, remove from map.
- On resize: update bounds for ALL views (so hidden tabs get correct bounds when shown).
- Use `webContents.setWindowOpenHandler()` to intercept `window.open()` and create new tabs.

### Chrome Keyboard Shortcuts (Linux)
| Action | Shortcut |
|---|---|
| New tab | `Ctrl+T` |
| Close tab | `Ctrl+W` |
| Reopen closed tab | `Ctrl+Shift+T` |
| Next tab | `Ctrl+Tab` or `Ctrl+PgDn` |
| Previous tab | `Ctrl+Shift+Tab` or `Ctrl+PgUp` |
| Jump to tab 1-8 | `Ctrl+1` through `Ctrl+8` |
| Jump to last tab | `Ctrl+9` |
| Move tab left | `Ctrl+Shift+PgUp` |
| Move tab right | `Ctrl+Shift+PgDn` |

### Files Requiring Changes
- `main.js` — Replace single BrowserView with multi-tab WebContentsView management
- `preload.js` — Add IPC bindings for tab operations
- `renderer/renderer.js` — Add tab bar UI logic
- `renderer/index.html` — Add tab bar HTML
- `renderer/styles.css` — Tab bar styling
- `playwright-bridge.js` — Tab management commands for scriptability
- `test/app.test.js` — New tab tests, update existing tests
