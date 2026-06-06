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

## Reopen Closed Tab (Ctrl+Shift+T) Research

### Chrome Behavior
- Chrome maintains a **LIFO stack** of recently closed tabs, max **25 entries**
- Each Ctrl+Shift+T pops the most recent entry
- Tab reopens at its **original position** in the tab strip (or end if position no longer valid)
- Chrome restores full back/forward navigation history + scroll position + form data

### Electron 33 Limitations
- `navigationHistory.getAllEntries()` and `getActiveIndex()` are available for reading history
- `navigationHistory.restore()` requires **Electron 34+** — NOT available on 33.4.11
- Practical approach: Save URL + tab position on close, reopen with `loadURL()` at original position
- Full history restoration requires upgrading to Electron 34+

### Data to Save on Tab Close
```js
{ url: String, title: String, index: Number }
```

## Context Menu Research

### Approach
- Use `Menu.buildFromTemplate()` + `menu.popup()` in main process (native OS menus)
- Renderer sends tab ID via IPC on `contextmenu` event
- Main process builds menu with tab-specific actions, executes them directly
- State changes broadcast via existing `sendTabsChanged()` mechanism

### IPC Pattern
- New channel: `'tab-context-menu'` (renderer → main, sends tabId)
- No return channel needed — actions execute directly in main process, state pushed via `tabs-changed`

## Middle-Click Research

### Implementation
- Use `auxclick` event on tab elements, check `event.button === 1`
- Reuse existing `closeTab` IPC channel — no new IPC needed
- Must be wired up inside `renderTabs()` since it rebuilds DOM on every state change

## Playwright Bridge Tab Sync Gap

### Current Issue
- Bridge operates via CDP (`context.newPage()`), completely bypassing main process's `createTab()`
- Tabs created via bridge may not appear in the tab bar UI
- Bridge uses 0-based index addressing; main process uses string IDs
- `list-tabs` in bridge enumerates CDP pages, which may differ from main's `tabs[]` ordering

### Missing Bridge Commands
- `reorder-tab <from-index> <to-index>` — not available via CDP, needs IPC or HTTP endpoint
- `duplicate-tab [index]` — not available via CDP
