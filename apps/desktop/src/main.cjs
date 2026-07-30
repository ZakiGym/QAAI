/**
 * QAAI desktop shell.
 *
 * A native window around the cockpit that also owns the backend: on launch it
 * checks whether the API, worker, demo store, and web server are already up,
 * starts whichever are not, waits for them to answer, and only then shows the
 * UI. Quitting stops everything it started — but deliberately leaves alone
 * anything that was already running, so launching the app never kills a dev
 * server someone is using in a terminal.
 *
 * CommonJS on purpose: Electron's main process still loads `.cjs` most
 * predictably, and this file has no build step.
 */

const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Boot order matters. The demo store is what the tests hit, the API owns the
 * database, and the web server is the only one the window actually loads — so
 * it goes last and is the thing we wait on before showing anything.
 */
const SERVICES = [
  { name: 'demo', workspace: '@qaai/demo', port: 5050, healthPath: '/__health' },
  { name: 'api', workspace: '@qaai/api', port: 4000, healthPath: '/health' },
  { name: 'worker', workspace: '@qaai/worker', port: null, healthPath: null },
  { name: 'web', workspace: '@qaai/web', port: 3000, healthPath: '/' },
];

const started = [];
let mainWindow = null;

function ping(port, healthPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: healthPath, timeout: timeoutMs },
      (res) => {
        res.resume();
        // Any answer at all means something is listening. The API returns 401
        // on some paths when signed out, which still counts as "up".
        resolve(true);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, healthPath, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(port, healthPath)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function startService(service) {
  const child = spawn('npm', ['run', 'dev', '-w', service.workspace], {
    cwd: REPO_ROOT,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = (buf) => process.stdout.write(`[${service.name}] ${buf}`);
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stdout.write(`[${service.name}] exited with ${code}\n`);
    }
  });

  started.push({ name: service.name, child });
  return child;
}

async function bootBackend(onStatus) {
  for (const service of SERVICES) {
    // The worker has no port to probe, so it is always (re)started. Two workers
    // draining the same queue is harmless — BullMQ hands each job to one.
    if (service.port !== null && (await ping(service.port, service.healthPath))) {
      onStatus(`${service.name} already running`);
      continue;
    }

    onStatus(`starting ${service.name}…`);
    startService(service);

    if (service.port !== null) {
      const ok = await waitForPort(service.port, service.healthPath);
      if (!ok) throw new Error(`${service.name} did not come up on port ${service.port}`);
    }
  }
}

/** A splash window, so the several seconds Next takes to boot are not a blank screen. */
function createSplash() {
  const splash = new BrowserWindow({
    width: 420,
    height: 220,
    frame: false,
    resizable: false,
    backgroundColor: '#0e1013',
    show: true,
  });

  const html = `
    <style>
      body { margin:0; height:100vh; display:flex; flex-direction:column;
             align-items:center; justify-content:center; gap:10px;
             background:#0e1013; color:#e8eaed;
             font:14px -apple-system, BlinkMacSystemFont, sans-serif; }
      h1 { margin:0; font-size:22px; letter-spacing:-0.02em; }
      p  { margin:0; color:#6b7480; font-size:12px; }
    </style>
    <h1>QAAI</h1>
    <p id="status">starting…</p>`;

  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return splash;
}

function createMainWindow() {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e1013',
    // macOS keeps its traffic lights over the page; the header reserves space
    // for them (see `.app-drag` in globals.css) and `trafficLightPosition`
    // centres them against a 44px header rather than the default 12px inset.
    //
    // Windows and Linux get a normal frame — there is no equivalent overlay
    // convention there, and a frameless window with no custom controls would
    // leave those users unable to close it.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 15 } }
      : { frame: true }),
    show: false,
    webPreferences: {
      // The cockpit is a plain web client; it needs no privileged bridge, so it
      // gets none. No nodeIntegration, context isolation on.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL('http://localhost:3000');
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Anything that is not the cockpit opens in the real browser rather than
  // trapping the user in a chromeless window with no back button.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

app.whenReady().then(async () => {
  buildMenu();
  const splash = createSplash();

  const setStatus = (text) => {
    if (splash.isDestroyed()) return;
    void splash.webContents.executeJavaScript(
      `document.getElementById('status').textContent = ${JSON.stringify(text)}`,
    );
  };

  try {
    await bootBackend(setStatus);
    setStatus('opening cockpit…');
    createMainWindow();
    mainWindow.once('ready-to-show', () => {
      if (!splash.isDestroyed()) splash.destroy();
    });
  } catch (err) {
    if (!splash.isDestroyed()) splash.destroy();
    dialog.showErrorBox(
      'QAAI could not start',
      `${err.message}\n\nPostgres and Redis must be running:\n` +
        `  brew services start postgresql@17\n  brew services start redis`,
    );
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => app.quit());

/** Stop only what this process started. */
app.on('before-quit', () => {
  for (const { child } of started) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
});
