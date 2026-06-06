# Noridoc: renderer

Path: @/renderer

### Overview

- Frontend UI for the Nori Browser Electron app: a terminal sidebar on the left, a draggable divider, a browser toolbar with URL bar, and a Chrome-like tab bar on the right
- `renderer.js` is the source; it gets bundled by esbuild into `bundle.js` which is loaded by `index.html`
- All communication with the main process goes through `window.api` (exposed via `@/preload.js`)

### How it fits into the larger codebase

- Loaded by `mainWindow.loadFile()` in `@/main.js`; sits alongside (not inside) the `WebContentsView` instances which render actual web content in tabs
- Receives URL updates, CDP port info, and tab state from the main process via IPC listeners (`onUrlChanged`, `onCdpPort`, `onTabsChanged`)
- Sends user actions back to main process: terminal keystrokes (`sendTerminalInput`), URL bar navigation (`navigate`), toolbar buttons (`goBack`, `goForward`, `reload`), sidebar width changes (`resizeSidebar`), and tab operations (`createTab`, `closeTab`, `switchTab`, `reorderTab`)
- The terminal is rendered by xterm.js with the FitAddon; terminal sizing (`cols`/`rows`) is synced to the main process so `node-pty` can resize its pseudoterminal accordingly
- Each tab's `WebContentsView` occupies the area below the toolbar and tab bar, to the right of the sidebar. View bounds are managed entirely by the main process -- the renderer just reports sidebar width changes

### Core Implementation

- **Terminal setup**: xterm.js `Terminal` instance opens into `#terminal-container`, with `FitAddon` handling auto-resize. A `ResizeObserver` on the container triggers re-fit + PTY resize on layout changes
- **URL bar**: Pressing Enter in `#url-bar` sends the value through `window.api.navigate()`. The main process handles protocol prefixing and loads the URL into the active tab's `WebContentsView`
- **Tab bar**: The `#tab-bar` contains a `#tab-list` (rendered dynamically from `tabs-changed` IPC events) and a `#new-tab-btn`. Each tab element has a click handler for switching, a close button, and drag-and-drop support for reordering. The `renderTabs()` function rebuilds the entire tab list on every `tabs-changed` event, marking the active tab with the `.active` CSS class
- **Tab drag-and-drop reordering**: Tabs have `draggable=true`. Drag events track the source tab ID in a `dragTabId` closure variable. On drop, `window.api.reorderTab()` sends the dragged tab's ID and the drop target's index to the main process, which splices the tab array and emits `tabs-changed` back
- **Sidebar resize**: Mousedown on `#divider` starts a drag; mousemove updates `sidebar.style.width`, notifies main process via `resizeSidebar()`, and re-fits the terminal. Constrained to 200-800px
- **CDP info display**: `#cdp-info` span in the sidebar header shows the CDP port once received from the main process

### Things to Know

- `index.html` has a strict Content-Security-Policy: `default-src 'self'`, `style-src 'self' 'unsafe-inline'`, `script-src 'self'`. Any new external resources will be blocked
- `bundle.js` is a build artifact checked into the repo. It must be rebuilt (`npm run build`) after any change to `renderer.js`
- xterm.css is loaded directly from `node_modules` via a relative path in `index.html` -- this works because Electron loads files from the filesystem, not a web server
- The URL bar `value` is populated by the `onUrlChanged` IPC event whenever the active tab navigates or the user switches tabs
- Tab styling in `styles.css` uses Chrome-like conventions: rounded top corners on tabs, a distinct background on the active tab, a visible drag-over indicator (left blue border), and opacity reduction during drag

Created and maintained by Nori.
