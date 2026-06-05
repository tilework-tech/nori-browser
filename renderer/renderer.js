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

requestAnimationFrame(() => {
  fitAddon.fit();
  window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
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

const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  window.api.resizeTerminal({ cols: term.cols, rows: term.rows });
});
resizeObserver.observe(document.getElementById('terminal-container'));

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

const divider = document.getElementById('divider');
const sidebar = document.getElementById('sidebar');
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
