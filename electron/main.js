const { app, BrowserWindow, ipcMain, screen, desktopCapturer, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.join(__dirname, '..');
const SERVER_URL = 'http://localhost:3000';

let mainWindow = null;
let overlayWindow = null;
let serverProcess = null;
let sessionActive = false;

// --- Server lifecycle ---

function startServer() {
  serverProcess = spawn('node', [path.join(PROJECT_ROOT, 'server', 'index.js')], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
  serverProcess.on('exit', (code) => {
    console.log(`[main] Server exited with code ${code}`);
    serverProcess = null;
  });
}

function waitForServer(timeout = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      if (Date.now() - start > timeout) return reject(new Error('Server start timeout'));
      http.get(SERVER_URL, (res) => {
        res.resume();
        resolve();
      }).on('error', () => setTimeout(poll, 200));
    }
    poll();
  });
}

function killServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

// --- Windows ---

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Claude Tutors',
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(SERVER_URL);

  mainWindow.on('blur', () => {
    if (sessionActive && overlayWindow) {
      overlayWindow.showInactive();
    }
  });

  mainWindow.on('focus', () => {
    if (overlayWindow) {
      overlayWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createOverlayWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  overlayWindow = new BrowserWindow({
    width: 280,
    height: 340,
    x: workArea.x + workArea.width - 280 - 16,
    y: workArea.y + 16,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

  // Start click-through
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// --- IPC ---

ipcMain.on('forward-to-overlay', (_event, eventName, data) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('overlay-event', eventName, data);
  }
});

ipcMain.on('session-active', (_event, active) => {
  sessionActive = active;
});

ipcMain.on('set-ignore-mouse-events', (_event, ignore, opts) => {
  if (overlayWindow) {
    overlayWindow.setIgnoreMouseEvents(ignore, opts || {});
  }
});

// --- App lifecycle ---

app.whenReady().then(async () => {
  startServer();

  try {
    await waitForServer();
  } catch (e) {
    console.error('[main] Failed to start server:', e.message);
    app.quit();
    return;
  }

  // Handle screen sharing — Electron doesn't show the native picker for getDisplayMedia,
  // so we use desktopCapturer to get sources and grant the first screen automatically.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length > 0) {
      callback({ video: sources[0] });
    } else {
      callback({});
    }
  });

  createMainWindow();
  createOverlayWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  killServer();
});
