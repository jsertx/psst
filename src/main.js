const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const gpg = require('./gpg');
const zip = require('./zip');

app.setName('Pssst');

const TMP_PREFIX = 'pssst-';
const LEGACY_TMP_PREFIXES = ['gpgshare-']; // from before the rename
const tempDirs = new Set(); // cleaned up after each job, and again on quit as a safety net
let currentJob = null;      // AbortController for the running zip+encrypt job

function removeTemp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.delete(dir);
}

// Leftovers from a crash or force-quit in a previous run.
function sweepStaleTemp() {
  const root = os.tmpdir();
  for (const name of fs.readdirSync(root)) {
    if ([TMP_PREFIX, ...LEGACY_TMP_PREFIXES].some((p) => name.startsWith(p))) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

let win = null;
let winReady = false;
let pendingFiles = [];
let flushTimer = null;

function createWindow() {
  winReady = false;
  win = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 420,
    minHeight: 480,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111317',
    icon: path.join(__dirname, '..', 'icons', 'appl', 'icon_512x512@2x.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Dropping a file outside the dropzone must never navigate the window to it.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => { winReady = true; flushFiles(); });
  win.on('closed', () => { win = null; winReady = false; });
}

// Files dropped on the Dock icon (or "Open With" in Finder) arrive one `open-file`
// event per file, possibly before the app is ready. Batch them and hand them to
// the renderer once it has loaded.
function queueFiles(paths) {
  pendingFiles.push(...paths);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushFiles, 150);
}

function flushFiles() {
  if (!pendingFiles.length || !app.isReady()) return;
  if (!win) return createWindow(); // did-finish-load will flush
  if (!winReady) return;
  const files = [...new Set(pendingFiles)];
  pendingFiles = [];
  win.webContents.send('files:opened', files);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueFiles([filePath]);
});

// Sources that were successfully encrypted, keyed by job id. The renderer can only
// ask to delete a job's sources by id, never pass arbitrary paths to delete.
const deletableJobs = new Map(); // id -> [{ source, output }]
function registerJob(pairs) {
  if (!pairs.length) return null;
  const id = crypto.randomUUID();
  deletableJobs.set(id, pairs);
  return id;
}

ipcMain.handle('gpg:listKeys', () => gpg.listKeys());
ipcMain.handle('gpg:encrypt', async (_e, files, fingerprint) => {
  const results = [];
  for (const file of files) {
    try {
      results.push({ file, output: await gpg.encrypt(file, fingerprint), ok: true });
    } catch (err) {
      results.push({ file, error: err.message, ok: false });
    }
  }
  const jobId = registerJob(results.filter((r) => r.ok).map((r) => ({ source: r.file, output: r.output })));
  return { results, jobId };
});

function countItems(p) {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return 1;
  let n = 0;
  for (const name of fs.readdirSync(p)) n += countItems(path.join(p, name));
  return n;
}

ipcMain.handle('sources:delete', async (event, jobId) => {
  const pairs = deletableJobs.get(jobId);
  if (!pairs) return { ok: false, error: 'Nothing to delete for this job.' };

  // Only delete sources whose encrypted output is still there and non-empty.
  const valid = pairs.filter(({ output }) => {
    try { return fs.statSync(output).size > 0; } catch { return false; }
  });
  // Never delete a source that contains one of this job's .gpg outputs
  // (e.g. you dropped a folder and a file from inside it, and the output landed in that folder).
  const outputs = pairs.map((p) => p.output);
  const contains = (dir, file) => path.relative(dir, file) && !path.relative(dir, file).startsWith('..') && !path.isAbsolute(path.relative(dir, file));
  const sources = [...new Set(valid.map((p) => p.source))]
    .filter((s) => fs.existsSync(s))
    .filter((s) => !outputs.some((o) => contains(s, o)));
  if (!sources.length) return { ok: false, error: 'The originals or the encrypted files are gone, nothing was deleted.' };

  const dirs = sources.filter((s) => fs.statSync(s).isDirectory());
  const nested = dirs.reduce((n, d) => n + countItems(d), 0);
  const list = sources.slice(0, 8).map((s) => `• ${path.basename(s)}${dirs.includes(s) ? '/' : ''}`).join('\n')
    + (sources.length > 8 ? `\n…and ${sources.length - 8} more` : '');

  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
    type: 'warning',
    message: `Delete ${sources.length} original ${sources.length === 1 ? 'item' : 'items'}?`,
    detail: `${list}${dirs.length ? `\n\nFolders are deleted with everything inside (${nested} files).` : ''}`
      + '\n\nThe encrypted .gpg files are kept. If you encrypted for someone else\'s key, you won\'t be able to decrypt them yourself.',
    buttons: ['Move to Trash', 'Delete Permanently', 'Cancel'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  });
  if (response === 2) return { ok: false, cancelled: true };

  const permanent = response === 1;
  const failed = [];
  for (const s of sources) {
    try {
      if (permanent) fs.rmSync(s, { recursive: true });
      else await shell.trashItem(s);
    } catch (err) {
      failed.push({ path: s, error: err.message });
    }
  }
  deletableJobs.delete(jobId);
  return { ok: failed.length === 0, deleted: sources.length - failed.length, failed, permanent };
});
ipcMain.handle('fs:inspect', (_e, paths) =>
  paths.map((p) => {
    try {
      const st = fs.statSync(p);
      return { path: p, isDir: st.isDirectory(), size: st.size };
    } catch {
      return { path: p, missing: true };
    }
  }));

ipcMain.handle('gpg:encryptZip', async (event, paths, fingerprint, name) => {
  const send = (msg) => !event.sender.isDestroyed() && event.sender.send('job:progress', msg);
  const ac = new AbortController();
  currentJob = ac;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX)); // 0700, per-user tmp
  tempDirs.add(tmp);
  try {
    const stem = (name || 'Archive').replace(/[\/:]/g, '-').replace(/\.zip$/i, '').trim() || 'Archive';
    send({ phase: 'scan' });
    const entries = await zip.collectEntries(paths);
    if (!entries.length) throw new Error('Nothing to zip — the dropped folders are empty.');

    const zipPath = path.join(tmp, `${stem}.zip`);
    await zip.createZip(entries, zipPath, {
      signal: ac.signal,
      onProgress: (p) => send({ phase: 'zip', ...p, files: entries.length }),
    });

    send({ phase: 'encrypt' });
    const output = gpg.uniqueOutput(path.dirname(paths[0]), stem, '.zip.gpg');
    // Already deflated, so skip gpg's own compression.
    await gpg.encrypt(zipPath, fingerprint, { output, noCompress: true, signal: ac.signal });
    const jobId = registerJob(paths.map((source) => ({ source, output })));
    return { ok: true, output, count: entries.length, jobId };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, cancelled: true };
    return { ok: false, error: err.message };
  } finally {
    removeTemp(tmp); // plaintext zip never outlives the job
    currentJob = null;
  }
});

ipcMain.handle('job:cancel', () => currentJob?.abort());

ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));

// One instance only, so the stale-temp sweep can't touch another instance's job.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

app.on('will-quit', () => {
  currentJob?.abort();
  for (const dir of tempDirs) removeTemp(dir);
});

app.whenReady().then(() => {
  try { sweepStaleTemp(); } catch {}
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, '..', 'icons', 'appl', 'icon_512x512@2x.png'));
  }
  createWindow();
  app.on('activate', () => !win && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
