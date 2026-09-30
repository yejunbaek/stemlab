const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'engine');
const BUNDLED_PY = IS_WIN ? path.join(ROOT, 'python', 'python.exe') : null;
const USER = app.getPath('userData');
const DATA_DIR = path.join(USER, 'data');
const ENV_DIR = path.join(USER, 'engine-env');
const ENV_PY = IS_WIN ? path.join(ENV_DIR, 'Scripts', 'python.exe') : path.join(ENV_DIR, 'bin', 'python');
const MARKER = path.join(ENV_DIR, 'stemlab-setup.json');
const TORCH = ['torch==2.5.1', 'torchaudio==2.5.1'];

let win = null;
let engine = null;
let engineInfo = null;
let updater = null;
let updateState = { status: 'idle' };

function basePython() {
  if (BUNDLED_PY && fs.existsSync(BUNDLED_PY)) return BUNDLED_PY;
  return IS_WIN ? 'python' : 'python3';
}

function reqHash() {
  const txt = fs.readFileSync(path.join(ENGINE_DIR, 'requirements.txt'), 'utf8') + TORCH.join(',');
  return crypto.createHash('sha1').update(txt).digest('hex').slice(0, 12);
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch { return null; }
}

function hasNvidia() {
  try {
    const r = spawnSync('nvidia-smi', ['-L'], { timeout: 5000, windowsHide: true });
    return r.status === 0 && String(r.stdout).includes('GPU');
  } catch { return false; }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    TORCH_HOME: path.join(DATA_DIR, 'models'),
    ...extra,
  };
}

function run(cmd, args, onLine, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: env || childEnv(), windowsHide: true });
    let tail = [];
    const handle = (buf) => {
      String(buf).split(/\r?\n|\r/).forEach((line) => {
        line = line.trim();
        if (!line) return;
        tail.push(line); if (tail.length > 30) tail.shift();
        onLine && onLine(line);
      });
    };
    p.stdout.on('data', handle);
    p.stderr.on('data', handle);
    p.on('error', (e) => reject(new Error(`Couldn't start ${path.basename(cmd)}: ${e.message}`)));
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(tail.slice(-6).join('\n') || `exit ${code}`)));
  });
}

// ---------------------------------------------------------------- one-time setup

ipcMain.handle('setup:status', () => {
  const m = readMarker();
  return {
    installed: !!m && fs.existsSync(ENV_PY),
    upToDate: !!m && m.reqHash === reqHash(),
    gpuInstalled: !!(m && m.gpu),
    nvidia: hasNvidia(),
  };
});

ipcMain.handle('setup:run', async (_e, { gpu }) => {
  const steps = [];
  const log = (line) => send('setup:log', line);
  const prev = readMarker();
  if (!fs.existsSync(ENV_PY)) {
    steps.push(['Preparing the audio engine', 3, basePython(), ['-m', 'venv', ENV_DIR]]);
  }
  steps.push(['Updating the installer', 3, ENV_PY, ['-m', 'pip', 'install', '--upgrade', 'pip']]);
  if (!prev || !!prev.gpu !== !!gpu || !fs.existsSync(ENV_PY)) {
    const torchArgs = ['-m', 'pip', 'install', ...TORCH];
    if (gpu) torchArgs.push('--index-url', 'https://download.pytorch.org/whl/cu124');
    steps.push([gpu ? 'Downloading the AI engine (GPU version)' : 'Downloading the AI engine', 45, ENV_PY, torchArgs]);
  }
  steps.push(['Installing audio tools', 30, ENV_PY, ['-m', 'pip', 'install', '-r', path.join(ENGINE_DIR, 'requirements.txt')]]);
  steps.push(['Downloading the instrument-splitting model', 19, ENV_PY,
    ['-c', "from demucs.pretrained import get_model; get_model('htdemucs_6s'); print('model ready')"]]);

  const total = steps.reduce((a, s) => a + s[1], 0);
  let done = 0;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [label, weight, cmd, args] of steps) {
    send('setup:progress', { label, fraction: done / total });
    log(`— ${label}`);
    await run(cmd, args, log);
    done += weight;
  }
  fs.writeFileSync(MARKER, JSON.stringify({ reqHash: reqHash(), gpu: !!gpu, at: Date.now(), ytdlpChecked: Date.now() }));
  send('setup:progress', { label: 'Ready', fraction: 1 });
  return true;
});

// ---------------------------------------------------------------- engine process

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function maybeUpdateDownloader() {
  // YouTube changes often; keep the downloader fresh (takes effect next launch).
  const m = readMarker();
  if (!m || Date.now() - (m.ytdlpChecked || 0) < 7 * 24 * 3600 * 1000) return;
  run(ENV_PY, ['-m', 'pip', 'install', '-U', 'yt-dlp[default]'], null)
    .then(() => fs.writeFileSync(MARKER, JSON.stringify({ ...m, ytdlpChecked: Date.now() })))
    .catch(() => {});
}

ipcMain.handle('engine:start', async () => {
  if (engineInfo) return engineInfo;
  const port = await freePort();
  const token = crypto.randomBytes(24).toString('hex');
  const args = [path.join(ENGINE_DIR, 'server.py'), '--port', String(port), '--data', DATA_DIR,
    '--token', token, '--js-runtime', process.execPath];
  // yt-dlp runs YouTube's player code with this app's built-in Node.js
  engine = spawn(ENV_PY, args, { env: childEnv({ ELECTRON_RUN_AS_NODE: '1' }), windowsHide: true });
  const lines = [];
  engineInfo = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The audio engine took too long to start.\n' + lines.slice(-8).join('\n'))), 120000);
    const onData = (buf) => {
      String(buf).split(/\r?\n/).forEach((l) => {
        if (!l.trim()) return;
        lines.push(l); if (lines.length > 200) lines.shift();
        if (l.includes('STEMLAB_READY')) { clearTimeout(timer); resolve({ port, token }); }
      });
    };
    engine.stdout.on('data', onData);
    engine.stderr.on('data', onData);
    engine.on('error', (e) => { clearTimeout(timer); reject(e); });
    engine.on('close', (code) => {
      clearTimeout(timer);
      if (!engineInfo) reject(new Error('The audio engine stopped while starting.\n' + lines.slice(-8).join('\n')));
      else send('engine:died', { code, log: lines.slice(-12).join('\n') });
      engine = null; engineInfo = null;
    });
  });
  maybeUpdateDownloader();
  return engineInfo;
});

// ---------------------------------------------------------------- dialogs & shell

ipcMain.handle('dialog:openAudio', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a song',
    properties: ['openFile'],
    filters: [
      { name: 'Audio and video', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'mp4', 'mov', 'mkv', 'webm'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose where to save', properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('music'),
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

// ---------------------------------------------------------------- updates
// New versions are published as GitHub releases; every installed copy checks there.

function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  send('update:state', updateState);
}

function notesText(n) {
  if (!n) return '';
  const raw = Array.isArray(n) ? n.map((x) => x.note || '').join('\n') : String(n);
  return raw.replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function initUpdater() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch { return; }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  updater.on('update-not-available', () => setUpdate({ status: 'current', checkedAt: Date.now() }));
  updater.on('update-available', (info) => setUpdate({
    status: 'available', version: info.version, notes: notesText(info.releaseNotes), date: info.releaseDate,
  }));
  updater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (info) => setUpdate({ status: 'ready', version: info.version }));
  updater.on('error', (e) => setUpdate({ status: 'error', error: String((e && e.message) || e).split('\n')[0] }));
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 4000);
  setInterval(check, 4 * 3600 * 1000);
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:state', () => ({ ...updateState, enabled: !!updater }));
ipcMain.handle('update:check', async () => {
  if (!updater) return { ...updateState, enabled: false };
  await updater.checkForUpdates().catch(() => {});
  return updateState;
});
ipcMain.handle('update:download', () => {
  if (!updater) return;
  setUpdate({ status: 'downloading', percent: 0 });
  updater.downloadUpdate().catch((e) => setUpdate({ status: 'error', error: String(e.message || e) }));
});
ipcMain.handle('update:install', () => {
  if (!updater) return;
  if (engine) engine.kill();
  setImmediate(() => updater.quitAndInstall(false, true));
});

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: '#23211e',
    title: 'Stemlab',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { createWindow(); initUpdater(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (engine) engine.kill(); });
