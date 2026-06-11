const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

let mainWindow;
let pythonProcess = null;
const BACKEND_PORT = 57832;

// Ensures Windows groups the taskbar icon under our app identity rather than
// the generic "electron.exe", so the .ico/.png we ship is what actually shows.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.wisetech.subsync');
}

// ── Path resolution ────────────────────────────────────────────────────
function getResourcePath(...parts) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...parts);
  }
  return path.join(__dirname, ...parts);
}

function getPythonExe() {
  if (app.isPackaged) {
    // Bundled embeddable Python — python.exe is at the root of the bundle
    return path.join(process.resourcesPath, 'python-bundle', 'python.exe');
  }
  // Dev: use venv if present, otherwise system python
  const venvPy = path.join(__dirname, 'python', 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPy)) return venvPy;
  return 'python';
}

function getFfmpegExe() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python-bundle', 'ffmpeg.exe');
  }
  const localFfmpeg = path.join(__dirname, 'python', 'ffmpeg.exe');
  if (fs.existsSync(localFfmpeg)) return localFfmpeg;
  return 'ffmpeg'; // fall back to system PATH
}

// ── Backend health check ───────────────────────────────────────────────
// Uses a TCP probe first (fast/reliable), then HTTP once port is open
const net = require('net');

function tcpProbe(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(1000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error',   () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

function waitForBackend(maxMs = 90000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let done = false;

    console.log('[main] Waiting for backend on port', BACKEND_PORT);
    // Give Python a head start before first probe
    setTimeout(attempt, 5000);

    async function attempt() {
      if (done) return;

      // Step 1: TCP probe — is the port open at all?
      const portOpen = await tcpProbe(BACKEND_PORT);
      if (!portOpen) {
        console.log('[main] Port not open yet, retrying...');
        return scheduleRetry();
      }

      // Step 2: HTTP health check — is Flask actually serving?
      try {
        const ok = await new Promise((res) => {
          const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/health`, (resp) => {
            resp.resume();
            res(resp.statusCode === 200);
          });
          req.on('error', () => res(false));
          req.setTimeout(2000, () => { req.destroy(); res(false); });
        });
        if (ok) {
          console.log('[main] Backend ready after', Date.now() - start, 'ms');
          done = true;
          return resolve();
        }
      } catch (_) {}

      scheduleRetry();
    }

    function scheduleRetry() {
      if (done) return;
      if (Date.now() - start > maxMs) {
        done = true;
        return reject(new Error('Backend timeout'));
      }
      setTimeout(attempt, 1500);
    }
  });
}

// ── Kill any stale process on our port before starting ────────────────
function killPortIfBusy() {
  return new Promise((resolve) => {
    // netstat to find PID using our port, then kill it
    const { exec } = require('child_process');
    exec(`netstat -ano | findstr :${BACKEND_PORT}`, (err, stdout) => {
      if (err || !stdout.trim()) return resolve();
      const lines = stdout.trim().split('\n');
      const pids = new Set();
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
      });
      if (pids.size === 0) return resolve();
      console.log('[main] Killing stale processes on port', BACKEND_PORT, [...pids]);
      const killCmds = [...pids].map(pid => `taskkill /PID ${pid} /F`).join(' & ');
      exec(killCmds, () => setTimeout(resolve, 500));
    });
  });
}

// ── Launch Python backend ──────────────────────────────────────────────
function startPythonBackend() {
  const pythonExe = getPythonExe();
  const ffmpegExe = getFfmpegExe();

  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'python-bundle', 'server.py')
    : path.join(__dirname, 'python', 'server.py');

  const bundlePythonPath = app.isPackaged
    ? path.join(process.resourcesPath, 'python-bundle', 'Lib', 'site-packages')
    : null;

  // In dev mode, verify the venv exists before trying to spawn
  if (!app.isPackaged) {
    const venvPy = path.join(__dirname, 'python', 'venv', 'Scripts', 'python.exe');
    if (!fs.existsSync(venvPy)) {
      console.error('[main] ERROR: venv not found at', venvPy);
      console.error('[main] Run scripts\setup-dev.bat first, then npm start');
      return; // let waitForBackend time out -> show error.html
    }
  }

  const env = {
    ...process.env,
    SUBSYNC_PORT: String(BACKEND_PORT),
    FFMPEG_PATH: ffmpegExe,
    PYTHONUNBUFFERED: '1',
    ...(bundlePythonPath ? { PYTHONPATH: bundlePythonPath } : {}),
    PYTHONNOUSERSITE: app.isPackaged ? '1' : '0',
  };

  console.log('[main] Python exe:', pythonExe);
  console.log('[main] Server script:', scriptPath);

  pythonProcess = spawn(pythonExe, [scriptPath], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pythonProcess.stdout.on('data', d => console.log('[python]', d.toString().trim()));
  pythonProcess.stderr.on('data', d => console.error('[python:err]', d.toString().trim()));

  pythonProcess.on('exit', (code) => {
    console.log('[main] Python backend exited with code', code);
    pythonProcess = null;
  });
}

// ── Create window ──────────────────────────────────────────────────────
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1200,
    minWidth: 1040,
    minHeight: 1000,
    useContentSize: true,
    backgroundColor: '#0f0f13',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f0f13',
      symbolColor: '#888',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'resources', 'icon.png'),
    show: false,
  });

  // Show splash while backend loads — wait for the renderer to be ready
  // before showing, otherwise the window can appear with just backgroundColor
  // and no splash content.
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadFile(path.join(__dirname, 'src', 'splash.html'));

  await killPortIfBusy();
  startPythonBackend();

  try {
    await waitForBackend(90000);
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  } catch (e) {
    console.error('Backend failed to start:', e);
    // Pass a reason query param so the error page can show context
    const venvExists = fs.existsSync(path.join(__dirname, 'python', 'venv', 'Scripts', 'python.exe'));
    const reason = venvExists ? 'crash' : 'no-venv';
    mainWindow.loadFile(path.join(__dirname, 'src', 'error.html'), { query: { reason } });
  }
}

// ── IPC Handlers ───────────────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async (_, opts) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: opts.filters || [],
  });
  return result.filePaths[0] || null;
});

ipcMain.handle('save-file-dialog', async (_, opts) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: opts.defaultName || 'output.srt',
    filters: opts.filters || [],
  });
  return result.filePath || null;
});

ipcMain.handle('open-folder', async (_, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle('open-external', async (_, url) => {
  // Only allow http(s) links to avoid opening arbitrary local/protocol handlers
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('read-file', async (_, filePath) => {
  return fs.readFileSync(filePath, 'utf8');
});

ipcMain.handle('write-file', async (_, filePath, content) => {
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
});

ipcMain.handle('get-backend-port', () => BACKEND_PORT);

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-temp-path', (_, ext) => {
  const safeExt = (ext || 'srt').replace(/[^a-z0-9]/gi, '') || 'srt';
  const name = `subsync-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${safeExt}`;
  return path.join(os.tmpdir(), name);
});

ipcMain.handle('delete-file', (_, filePath) => {
  try { fs.unlinkSync(filePath); return true; } catch (_) { return false; }
});

// ── App lifecycle ──────────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
  }
  app.quit();
});

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
});
