const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');

// Expand dropped paths (files and folders) into a flat list of zip entries.
async function collectEntries(paths) {
  const entries = [];
  const topNames = new Set();
  const uniqueTop = (name) => {
    let n = name, i = 1;
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    while (topNames.has(n)) n = `${stem} (${i++})${ext}`;
    topNames.add(n);
    return n;
  };

  async function walk(dir, prefix) {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      if (it.name === '.DS_Store') continue;
      const abs = path.join(dir, it.name);
      const name = `${prefix}/${it.name}`;
      if (it.isDirectory()) {
        await walk(abs, name); // symlinked dirs report isSymbolicLink(), so no loops
      } else if (it.isFile() || it.isSymbolicLink()) {
        const st = await fsp.stat(abs).catch(() => null);
        if (st?.isFile()) entries.push({ abs, name, size: st.size, mtime: st.mtime, mode: st.mode });
      }
    }
  }

  for (const p of paths) {
    const st = await fsp.stat(p);
    if (st.isDirectory()) await walk(p, uniqueTop(path.basename(p)));
    else if (st.isFile()) entries.push({ abs: p, name: uniqueTop(path.basename(p)), size: st.size, mtime: st.mtime, mode: st.mode });
  }
  return entries;
}

/**
 * Zip `entries` into `outPath`, reporting byte-level progress on the *input* side.
 * Entries are appended one at a time so only one file descriptor is open.
 */
async function createZip(entries, outPath, { onProgress = () => {}, signal } = {}) {
  const { ZipArchive } = await import('archiver');
  const total = entries.reduce((s, e) => s + e.size, 0);
  let processed = 0;
  let current = '';
  let lastEmit = 0;
  const emit = (force) => {
    const now = Date.now();
    if (force || now - lastEmit > 50) { lastEmit = now; onProgress({ processed, total, current }); }
  };

  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = fs.createWriteStream(outPath, { mode: 0o600 });
  let currentStream = null;

  const done = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
    signal?.addEventListener('abort', () => {
      currentStream?.destroy();
      archive.abort();
      output.destroy();
      reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    }, { once: true });
  });
  archive.pipe(output);

  for (const e of entries) {
    if (signal?.aborted) break;
    current = e.name;
    emit(true);
    const counter = new Transform({
      transform(chunk, _enc, cb) { processed += chunk.length; emit(); cb(null, chunk); },
    });
    currentStream = fs.createReadStream(e.abs);
    currentStream.on('error', (err) => counter.destroy(err));
    const entryDone = new Promise((res, rej) => {
      archive.once('entry', res);
      counter.once('error', rej);
    });
    entryDone.catch(() => {});
    archive.append(currentStream.pipe(counter), { name: e.name, date: e.mtime, mode: e.mode & 0o777 });
    await Promise.race([entryDone, done]);
  }
  if (!signal?.aborted) archive.finalize();
  await done;
  emit(true);
  return { total, count: entries.length };
}

module.exports = { collectEntries, createZip };
