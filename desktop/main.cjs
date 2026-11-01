'use strict';
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { startBackgroundJobs } = require('./jobs.cjs');

const isDev = !app.isPackaged;

const state = {
  backendProcess: null,
  jobs: null,
  mainWindow: null,
  splashWindow: null,
  setupWindow: null,
  config: null,
  logStream: null,
};

// ---------- paths ----------

function backendDir() {
  return isDev
    ? path.join(__dirname, 'resources', 'backend')
    : path.join(process.resourcesPath, 'backend');
}

function userDataDir() {
  return app.getPath('userData');
}

function configPath() {
  return path.join(userDataDir(), 'config.json');
}

function uploadDir() {
  return path.join(userDataDir(), 'uploads');
}

function logPath() {
  return path.join(userDataDir(), 'logs', 'app.log');
}

// ---------- logging ----------

function openLog() {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true });
  state.logStream = fs.createWriteStream(logPath(), { flags: 'a' });
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  if (isDev) console.log(stamped);
  if (state.logStream) state.logStream.write(stamped + '\n');
}

// ---------- config ----------

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg.dbName || !cfg.dbUser) return null;
    return cfg;
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** Merge a submitted form into the previously-saved config so a blank password / secret key
 *  on a later "Settings" edit means "keep what's already there", not "erase it". Only a true
 *  first run (no prior config at all) treats a blank secret key as "generate a new one". */
function mergeConfig(existing, submitted) {
  const merged = { ...submitted };
  if (!submitted.dbPass && existing) merged.dbPass = existing.dbPass || '';
  if (!submitted.appSecretKey) {
    merged.appSecretKey = existing && existing.appSecretKey
      ? existing.appSecretKey
      : crypto.randomBytes(32).toString('hex');
  }
  return merged;
}

function runtimeEnv(cfg) {
  const port = Number(cfg.port) || 3100;
  return {
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    DB_HOST: cfg.dbHost || '127.0.0.1',
    DB_PORT: String(cfg.dbPort || 3306),
    DB_NAME: cfg.dbName,
    DB_USER: cfg.dbUser,
    DB_PASS: cfg.dbPass || '',
    APP_NAME: cfg.appName || 'URBAN DRY CLEAN',
    APP_URL: `http://127.0.0.1:${port}`,
    APP_SECRET_KEY: cfg.appSecretKey,
    UPLOAD_DIR: uploadDir(),
    SERVE_UPLOADS: 'true',
    TRUST_PROXY: 'false',
  };
}

// ---------- DB connection test ----------

async function testDbConnection(cfg) {
  const mysqlEntry = path.join(backendDir(), 'node_modules', 'mysql2', 'promise.js');
  if (!fs.existsSync(mysqlEntry)) {
    return { ok: false, error: 'Backend files not found. Reinstall the app and try again.' };
  }
  let mysql;
  try {
    mysql = require(mysqlEntry);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  let conn;
  try {
    conn = await mysql.createConnection({
      host: cfg.dbHost || '127.0.0.1',
      port: Number(cfg.dbPort) || 3306,
      user: cfg.dbUser,
      password: cfg.dbPass || '',
      database: cfg.dbName,
      connectTimeout: 5000,
    });
    await conn.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

// ---------- backend process ----------

function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tryOnce, 400);
    };
    tryOnce();
  });
}

function startBackend(cfg) {
  const dir = backendDir();
  const serverScript = path.join(dir, 'dist', 'server.js');
  const env = runtimeEnv(cfg);
  log(`[backend] starting on port ${env.PORT} (db ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME})`);
  const child = spawn(process.execPath, [serverScript], {
    cwd: dir,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log(`[backend] ${d}`.trimEnd()));
  child.stderr.on('data', (d) => log(`[backend:err] ${d}`.trimEnd()));
  child.on('exit', (code, signal) => {
    log(`[backend] exited (code=${code} signal=${signal})`);
    if (state.backendProcess === child) state.backendProcess = null;
  });
  state.backendProcess = child;
  return child;
}

function stopBackend() {
  if (state.jobs) { state.jobs.stop(); state.jobs = null; }
  const child = state.backendProcess;
  if (!child) return;
  state.backendProcess = null;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      child.kill('SIGTERM');
    }
  } catch (err) {
    log(`[backend] stop error: ${err.message}`);
  }
}

// ---------- windows ----------

function createSplashWindow() {
  const win = new BrowserWindow({
    width: 360, height: 300, frame: false, resizable: false, show: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  state.splashWindow = win;
  win.on('closed', () => { if (state.splashWindow === win) state.splashWindow = null; });
  return win;
}

function splashStatus(text) {
  if (state.splashWindow && !state.splashWindow.isDestroyed()) {
    state.splashWindow.webContents.send('splash:status', text);
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Settings...', click: () => openSettings() },
        { type: 'separator' },
        { label: 'Open logs folder', click: () => shell.openPath(path.dirname(logPath())) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => state.mainWindow && state.mainWindow.reload() },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => dialog.showMessageBox(state.mainWindow || undefined, {
            type: 'info',
            title: 'Urban Dry Clean CRM',
            message: 'Urban Dry Clean CRM',
            detail: `Version ${app.getVersion()}\nLocal server: ${state.config ? `http://127.0.0.1:${state.config.port || 3100}` : 'not running'}`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(port) {
  const win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640, show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => {
    win.show();
    if (state.splashWindow) { state.splashWindow.close(); }
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  state.mainWindow = win;
  win.on('closed', () => { state.mainWindow = null; });
  return win;
}

// ---------- setup window ----------

function openSetupWindow() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640, height: 760, resizable: true,
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
    });
    state.setupWindow = win;
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'setup.html'));
    win.on('closed', () => {
      state.setupWindow = null;
      resolve(null); // window closed without saving (e.g. first run, user quit)
    });

    ipcMain.handle('config:get', () => state.config || {});
    ipcMain.handle('config:test', (_e, cfg) => testDbConnection(cfg));
    ipcMain.handle('config:save', async (_e, submitted) => {
      try {
        const merged = mergeConfig(state.config, submitted);
        saveConfig(merged);
        state.config = merged;
        win.removeAllListeners('closed');
        win.close();
        state.setupWindow = null;
        resolve(merged);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });
  });
}

async function openSettings() {
  stopBackend();
  if (state.mainWindow) { state.mainWindow.close(); }
  const previous = state.config;
  const newConfig = await openSetupWindow();
  cleanupSetupIpc();
  const cfg = newConfig || previous; // cancelled: fall back to the config already running
  if (cfg) await launchBackendAndWindow(cfg);
  else app.quit();
}

function cleanupSetupIpc() {
  ipcMain.removeHandler('config:get');
  ipcMain.removeHandler('config:test');
  ipcMain.removeHandler('config:save');
}

// ---------- launch sequence ----------

async function launchBackendAndWindow(cfg) {
  state.config = cfg;
  createSplashWindow();
  splashStatus('Starting local server...');
  startBackend(cfg);

  const port = Number(cfg.port) || 3100;
  const healthy = await waitForHealth(port, 30000);
  if (!healthy) {
    splashStatus('Still waiting for the database...');
    const healthyAfterWait = await waitForHealth(port, 20000);
    if (!healthyAfterWait) {
      if (state.splashWindow) state.splashWindow.close();
      const choice = await dialog.showMessageBox({
        type: 'error',
        title: 'Could not start',
        message: 'Urban Dry Clean CRM could not reach its local server.',
        detail: 'This usually means the database settings are wrong, or the database server is unreachable. ' +
          `Check the log at ${logPath()} for details.`,
        buttons: ['Open Settings', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      stopBackend();
      if (choice.response === 0) { await openSettings(); return; }
      app.quit();
      return;
    }
  }

  splashStatus('Ready.');
  createMainWindow(port);
  state.jobs = startBackgroundJobs({ backendDir: backendDir(), runtimeEnv: runtimeEnv(cfg), log });
}

async function boot() {
  openLog();
  log('[app] starting');
  buildMenu();

  const existing = loadConfig();
  if (existing) {
    await launchBackendAndWindow(existing);
    return;
  }
  const newConfig = await openSetupWindow();
  cleanupSetupIpc();
  if (newConfig) {
    await launchBackendAndWindow(newConfig);
  } else {
    app.quit();
  }
}

// ---------- app lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      state.mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && state.config) {
      createMainWindow(Number(state.config.port) || 3100);
    }
  });

  app.on('before-quit', () => {
    stopBackend();
  });
}
