# Noridoc: renderer

Path: @/renderer

### Overview

- Frontend UI for the Nori Browser Electron app: a terminal sidebar on the left, a draggable divider, a browser toolbar with URL bar, and a Chrome-like tab bar on the right
- `renderer.js` is the source; it gets bundled by esbuild into `bundle.js` which is loaded by `index.html`
- All communication with the main process goes through `window.api` (exposed via `@/preload.js`)

### How it fits into the larger codebase

- Loaded by `mainWindow.loadFile()` in `@/main.js`; sits alongside (not inside) the `WebContentsView` instances which render actual web content in tabs
- Receives URL updates, CDP port info, and tab state from the main process via IPC listeners (`onUrlChanged`, `onCdpPort`, `onTabsChanged`)
- Sends user actions back to main process: terminal keystrokes (`sendTerminalInput`), URL bar navigation (`navigate`), toolbar buttons (`goBack`, `goForward`, `reload`), sidebar width changes (`resizeSidebar`), sidebar toggle (`toggleSidebar`), and tab operations (`createTab`, `closeTab`, `switchTab`, `reorderTab`, `reopenClosedTab`, `duplicateTab`, `closeOtherTabs`, `closeTabsToRight`, `showTabContextMenu`)
- The terminal is rendered by xterm.js with the FitAddon; terminal sizing (`cols`/`rows`) is synced to the main process so `node-pty` can resize its pseudoterminal accordingly
- Each tab's `WebContentsView` occupies the area below the toolbar and tab bar, to the right of the sidebar. View bounds are managed entirely by the main process -- the renderer just reports sidebar width changes

### Core Implementation

- **Terminal setup**: xterm.js `Terminal` instance opens into `#terminal-container`, with `FitAddon` handling auto-resize. A `ResizeObserver` on the container triggers re-fit + PTY resize on layout changes (guarded against zero dimensions to avoid errors when the sidebar is hidden). A custom key event handler on xterm suppresses Ctrl+J so xterm does not consume it as a linefeed character
- **URL bar**: Pressing Enter in `#url-bar` sends the value through `window.api.navigate()`. The main process handles protocol prefixing and loads the URL into the active tab's `WebContentsView`
- **Tab bar**: The `#tab-bar` contains a `#tab-list` (rendered dynamically from `tabs-changed` IPC events) and a `#new-tab-btn`. Each tab element has: a click handler for switching, a close button, middle-click (`auxclick` with `button === 1`) to close the tab, right-click (`contextmenu`) to show a native context menu via `window.api.showTabContextMenu()`, and drag-and-drop support for reordering. The `renderTabs()` function rebuilds the entire tab list on every `tabs-changed` event, marking the active tab with the `.active` CSS class
- **Tab drag-and-drop reordering**: Tabs have `draggable=true`. Drag events track the source tab ID in a `dragTabId` closure variable. On drop, `window.api.reorderTab()` sends the dragged tab's ID and the drop target's index to the main process, which splices the tab array and emits `tabs-changed` back
- **Tab context menu**: Right-clicking a tab sends `tab-context-menu` IPC to the main process, which builds and displays a native Electron `Menu.popup()`. This is NOT a custom HTML menu -- it uses the OS-native context menu. The menu items (New Tab, Reload, Duplicate, Close Tab, Close Other Tabs, Close Tabs to the Right) invoke main process tab functions directly
- **Sidebar resize**: Mousedown on `#divider` starts a drag; mousemove updates `sidebar.style.width`, notifies main process via `resizeSidebar()`, and re-fits the terminal. Constrained to 200-800px
- **Sidebar toggle (Ctrl+J)**: A document-level `keydown` listener catches Ctrl+J and calls `window.api.toggleSidebar()`. The main process responds with a `sidebar-toggled` IPC event; the renderer handler toggles a `.sidebar-hidden` CSS class (`display: none !important` in `@/renderer/styles.css`) on both `#sidebar` and `#divider`. When the sidebar is shown, a `requestAnimationFrame` re-fits the terminal and syncs the PTY size
- **CDP info display**: `#cdp-info` span in the sidebar header shows the CDP port once received from the main process

### Things to Know

- `index.html` has a strict Content-Security-Policy: `default-src 'self'`, `style-src 'self' 'unsafe-inline'`, `script-src 'self'`. Any new external resources will be blocked
- `bundle.js` is a build artifact checked into the repo. It must be rebuilt (`npm run build`) after any change to `renderer.js`
- xterm.css is loaded directly from `node_modules` via a relative path in `index.html` -- this works because Electron loads files from the filesystem, not a web server
- The `renderTabs()` function is destructive -- it clears `tabList.innerHTML` and rebuilds the entire DOM on every `tabs-changed` event. All event listeners (click, auxclick, contextmenu, drag events) are re-attached each render cycle. This means there are no stale listener issues, but it also means no DOM state (e.g., scroll position within the tab bar) survives a re-render
- The URL bar `value` is populated by the `onUrlChanged` IPC event whenever the active tab navigates or the user switches tabs
- Tab styling in `styles.css` uses Chrome-like conventions: rounded top corners on tabs, a distinct background on the active tab, a visible drag-over indicator (left blue border), and opacity reduction during drag
- Ctrl+J is intercepted at three layers: xterm's custom key handler (returns `false` to prevent linefeed), a document `keydown` listener (sends `toggle-sidebar` IPC), and the main process `before-input-event` on both webContents (see `@/main.js`). All three are needed because focus can be in xterm, the renderer document, or the WebContentsView

Created and maintained by Nori.
