import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

const term = new Terminal({
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 14,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    selectionBackground: '#264f78',
  },
  cursorBlink: true,
  allowProposedApi: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));

term.attachCustomKeyEventHandler((ev) => {
  if (ev.ctrlKey && ev.key === 'j') return false;
  return true;
});

requestAnimationFrame(() => {
  fitAddon.fit();
  window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
  window.api.signalTerminalReady();
});

term.onData((data) => {
  window.api.sendTerminalInput(data);
});

window.api.onTerminalData((data) => {
  term.write(data);
});

window.api.onTerminalExit((code) => {
  term.write(`\r\n[Process exited with code ${code}]\r\n`);
});

const terminalContainer = document.getElementById('terminal-container');
const resizeObserver = new ResizeObserver(() => {
  const rect = terminalContainer.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    fitAddon.fit();
    window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
  }
});
resizeObserver.observe(terminalContainer);

const urlBar = document.getElementById('url-bar');
urlBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.api.navigate(urlBar.value);
  }
});

window.api.onUrlChanged((url) => {
  urlBar.value = url;
});

document.getElementById('btn-back').addEventListener('click', () => window.api.goBack());
document.getElementById('btn-forward').addEventListener('click', () => window.api.goForward());
document.getElementById('btn-reload').addEventListener('click', () => window.api.reload());

window.api.onCdpPort((port) => {
  document.getElementById('cdp-info').textContent = `CDP :${port}`;
});

// Tab bar
const tabList = document.getElementById('tab-list');
const newTabBtn = document.getElementById('new-tab-btn');

newTabBtn.addEventListener('click', () => {
  window.api.createTab();
});

let dragTabId = null;

function renderTabs(data) {
  tabList.innerHTML = '';
  for (const tab of data.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === data.activeTabId ? ' active' : '') + (tab.pinned ? ' pinned' : '');
    el.dataset.tabId = tab.id;
    el.draggable = true;

    if (tab.isLoading) {
      const spinner = document.createElement('div');
      spinner.className = 'tab-spinner';
      el.appendChild(spinner);
    } else if (tab.favicon) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.src = tab.favicon;
      img.width = 16;
      img.height = 16;
      img.addEventListener('error', () => {
        img.style.display = 'none';
      });
      el.appendChild(img);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'New Tab';
    el.appendChild(title);

    if (!tab.pinned) {
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        window.api.closeTab(tab.id);
      });
      el.appendChild(close);
    }

    el.addEventListener('click', () => {
      window.api.switchTab(tab.id);
    });

    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        window.api.closeTab(tab.id);
      }
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.api.showTabContextMenu(tab.id);
    });

    el.addEventListener('dragstart', (e) => {
      dragTabId = tab.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragTabId = null;
      tabList.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragTabId && dragTabId !== tab.id) {
        el.classList.add('drag-over');
      }
    });

    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (dragTabId && dragTabId !== tab.id) {
        const dropIndex = data.tabs.findIndex(t => t.id === tab.id);
        window.api.reorderTab(dragTabId, dropIndex);
      }
    });

    tabList.appendChild(el);
  }
}

window.api.onTabsChanged((data) => {
  renderTabs(data);
});

// Sidebar divider
const divider = document.getElementById('divider');
const sidebar = document.getElementById('sidebar');

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'j') {
    e.preventDefault();
    window.api.toggleSidebar();
  }
});

window.api.onSidebarToggled((visible) => {
  if (visible) {
    sidebar.classList.remove('sidebar-hidden');
    divider.classList.remove('sidebar-hidden');
    requestAnimationFrame(() => {
      fitAddon.fit();
      window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
    });
  } else {
    sidebar.classList.add('sidebar-hidden');
    divider.classList.add('sidebar-hidden');
  }
});
let isDragging = false;

divider.addEventListener('mousedown', (e) => {
  isDragging = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const newWidth = Math.max(200, Math.min(800, e.clientX));
  sidebar.style.width = `${newWidth}px`;
  window.api.resizeSidebar(newWidth);
  fitAddon.fit();
  window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

// Find bar
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findMatches = document.getElementById('find-matches');
const findNextBtn = document.getElementById('find-next-btn');
const findPrevBtn = document.getElementById('find-prev-btn');
const findCloseBtn = document.getElementById('find-close-btn');
let currentFindText = '';

function showFindBar() {
  findBar.classList.remove('hidden');
  findInput.focus();
  findInput.select();
}

function hideFindBar() {
  findBar.classList.add('hidden');
  currentFindText = '';
  findMatches.textContent = '0 of 0';
  window.api.findClose();
}

window.api.onShowFindBar(() => showFindBar());

findInput.addEventListener('input', () => {
  currentFindText = findInput.value;
  if (currentFindText) {
    window.api.findInPage(currentFindText);
  } else {
    findMatches.textContent = '0 of 0';
    window.api.findClose();
  }
});

findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideFindBar();
  } else if (e.key === 'Enter') {
    if (e.shiftKey) {
      window.api.findNext(false);
    } else {
      window.api.findNext(true);
    }
  }
});

findNextBtn.addEventListener('click', () => window.api.findNext(true));
findPrevBtn.addEventListener('click', () => window.api.findNext(false));
findCloseBtn.addEventListener('click', () => hideFindBar());

window.api.onFindResults((data) => {
  findMatches.textContent = `${data.current} of ${data.total}`;
});

// Zoom indicator
const zoomIndicator = document.getElementById('zoom-indicator');
let zoomTimeout;

window.api.onZoomChanged((percent) => {
  zoomIndicator.textContent = `${percent}%`;
  zoomIndicator.classList.remove('hidden');
  clearTimeout(zoomTimeout);
  zoomTimeout = setTimeout(() => {
    zoomIndicator.classList.add('hidden');
  }, 1500);
});

// Download shelf
const downloadShelf = document.getElementById('download-shelf');
const activeDownloads = new Map();

function renderDownloadShelf() {
  if (activeDownloads.size === 0) {
    downloadShelf.classList.add('hidden');
    return;
  }
  downloadShelf.classList.remove('hidden');
  downloadShelf.innerHTML = '';

  for (const [id, dl] of activeDownloads) {
    const item = document.createElement('div');
    item.className = 'download-item';

    const name = document.createElement('span');
    name.className = 'download-filename';
    name.textContent = dl.filename;
    item.appendChild(name);

    if (dl.state === 'progressing') {
      const progress = document.createElement('div');
      progress.className = 'download-progress';
      const fill = document.createElement('div');
      fill.className = 'download-progress-fill';
      fill.style.width = `${dl.percentComplete}%`;
      progress.appendChild(fill);
      item.appendChild(progress);

      const cancel = document.createElement('button');
      cancel.className = 'download-action';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => window.api.downloadCancel(id));
      item.appendChild(cancel);
    } else if (dl.state === 'completed') {
      const open = document.createElement('button');
      open.className = 'download-action';
      open.textContent = 'Open';
      open.addEventListener('click', () => window.api.downloadOpen(id));
      item.appendChild(open);

      const show = document.createElement('button');
      show.className = 'download-action';
      show.textContent = 'Show';
      show.addEventListener('click', () => window.api.downloadShow(id));
      item.appendChild(show);
    }

    downloadShelf.appendChild(item);
  }

  const closeBtn = document.createElement('button');
  closeBtn.id = 'download-shelf-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    activeDownloads.clear();
    renderDownloadShelf();
  });
  downloadShelf.appendChild(closeBtn);
}

window.api.onDownloadProgress((data) => {
  activeDownloads.set(data.id, data);
  renderDownloadShelf();
});

window.api.onDownloadDone((data) => {
  activeDownloads.set(data.id, { ...activeDownloads.get(data.id), ...data });
  renderDownloadShelf();
});

// Status bar
const statusBar = document.getElementById('status-bar');

window.api.onStatusBarUrl((url) => {
  if (url) {
    statusBar.textContent = url;
    statusBar.classList.remove('hidden');
  } else {
    statusBar.classList.add('hidden');
  }
});

// Fullscreen
window.api.onFullscreenChanged((isFs) => {
  const toolbar = document.getElementById('toolbar');
  const tabBar = document.getElementById('tab-bar');
  if (isFs) {
    toolbar.classList.add('hidden');
    tabBar.classList.add('hidden');
  } else {
    toolbar.classList.remove('hidden');
    tabBar.classList.remove('hidden');
  }
});
