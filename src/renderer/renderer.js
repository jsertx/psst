const $ = (id) => document.getElementById(id);
const state = { files: [], info: [], keys: [], busy: false, view: 'drop', nameEdited: false };

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${view}`);
  state.view = view;
  document.body.classList.toggle('on-drop', view === 'drop');
  document.body.classList.toggle('on-result', view === 'result');
}

let errTimer;
function showError(msg) {
  $('error').textContent = msg;
  $('error').classList.remove('hidden');
  clearTimeout(errTimer);
  errTimer = setTimeout(() => $('error').classList.add('hidden'), 6000);
}

const basename = (p) => p.split(/[\\/]/).pop();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------- Full-window drop handling ----------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (dragDepth++ === 0) document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (state.busy) return;
  const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
  await openFiles(paths);
});

// If a list is already open, drops (window or Dock) add to it; otherwise they start a new batch.
async function openFiles(paths) {
  if (state.busy || !paths.length) return;
  const adding = state.files.length > 0;
  const fresh = (await window.api.inspect(paths)).filter((i) => !i.missing);
  if (!fresh.length) return showError('Those files no longer exist.');

  if (adding) {
    const known = new Set(state.files);
    state.info.push(...fresh.filter((i) => !known.has(i.path)));
  } else {
    state.info = fresh;
    state.nameEdited = false;
  }
  state.files = state.info.map((i) => i.path);
  renderFiles();
  setupMode(adding);
  if (adding && state.view !== 'keys') show('keys');
  if (!adding) await loadKeys();
}

function removeFile(p) {
  state.info = state.info.filter((i) => i.path !== p);
  state.files = state.info.map((i) => i.path);
  if (!state.files.length) return reset();
  renderFiles();
  setupMode(true);
}

const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};

// ---------- Zip vs. separate ----------
// keep=true: the list changed while on the key picker, so keep the user's mode and name.
function setupMode(keep = false) {
  const hasDir = state.info.some((i) => i.isDir);
  const needsChoice = state.files.length > 1 || hasDir;
  $('mode').classList.toggle('hidden', !needsChoice);
  if (!needsChoice) return;

  // Folders can't be encrypted directly, so they force zip mode.
  const sep = document.querySelector('input[name=mode][value=separate]');
  sep.disabled = hasDir;
  $('opt-separate').classList.toggle('disabled', hasDir);
  $('opt-separate').title = hasDir ? 'Folders have to be zipped' : '';
  if (!keep || hasDir) document.querySelector('input[name=mode][value=zip]').checked = true;

  if (!state.nameEdited) $('zip-name').value = state.files.length === 1 && hasDir ? basename(state.files[0]) : 'Archive';
}

const zipMode = () => !$('mode').classList.contains('hidden') &&
  document.querySelector('input[name=mode]:checked').value === 'zip';

$('zip-name').addEventListener('input', () => { state.nameEdited = true; });

window.api.onFilesOpened(openFiles);

// ---------- Keys ----------
async function loadKeys() {
  try {
    state.keys = await window.api.listKeys();
  } catch (err) {
    showError(err.message);
    return;
  }
  $('search').value = '';
  renderKeys();
  show('keys');
  $('search').focus();
}

const ICON_FILE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
const ICON_DIR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 6h6l2 2h10v11H3z"/></svg>';

function renderFiles() {
  $('file-list').replaceChildren(...state.info.map((i) => {
    const li = el('li', 'file-row');
    li.title = i.path;
    const ico = el('span', 'ico');
    ico.innerHTML = i.isDir ? ICON_DIR : ICON_FILE; // static markup, no user data
    li.append(ico, el('span', 'fname', basename(i.path)), el('span', 'fsize', i.isDir ? 'Folder' : fmtBytes(i.size)));
    const rm = el('button', 'rm', '×');
    rm.title = 'Remove';
    rm.addEventListener('click', () => removeFile(i.path));
    li.appendChild(rm);
    return li;
  }));
  const files = state.info.filter((i) => !i.isDir);
  const dirs = state.info.length - files.length;
  const parts = [];
  if (files.length) parts.push(`${files.length} file${files.length === 1 ? '' : 's'} · ${fmtBytes(files.reduce((s, f) => s + f.size, 0))}`);
  if (dirs) parts.push(`${dirs} folder${dirs === 1 ? '' : 's'}`);
  $('files-count').textContent = parts.join(' + ');
}

function matches(key, q) {
  if (!q) return true;
  const hay = [...key.uids, key.keyId, key.fingerprint].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
}

function renderKeys() {
  const q = $('search').value.trim();
  const list = state.keys
    .filter((k) => matches(k, q))
    .sort((a, b) => (b.canEncrypt - a.canEncrypt) || (a.uids[0] || '').localeCompare(b.uids[0] || ''));

  $('key-list').replaceChildren(...list.map((k) => {
    const li = el('li');
    const btn = el('button', 'key');
    btn.disabled = !k.canEncrypt;
    btn.dataset.fpr = k.fingerprint;
    btn.appendChild(el('div', 'name', k.uids[0] || '(no user ID)'));
    if (k.uids.length > 1) btn.appendChild(el('div', 'extra', k.uids.slice(1).join(' · ')));
    const meta = el('div', 'meta');
    meta.appendChild(el('code', null, k.fingerprint.replace(/(.{4})/g, '$1 ').trim().slice(-24)));
    if (k.created) meta.appendChild(el('span', null, `created ${k.created}`));
    if (k.expires) meta.appendChild(el('span', null, `expires ${k.expires}`));
    if (k.status !== 'ok') meta.appendChild(el('span', 'badge', k.status));
    else if (!k.canEncrypt) meta.appendChild(el('span', 'badge', 'no encryption subkey'));
    btn.appendChild(meta);
    btn.title = k.fingerprint;
    btn.addEventListener('click', () => doEncrypt(k, btn));
    li.appendChild(btn);
    return li;
  }));
  $('keys-empty').classList.toggle('hidden', list.length > 0);
}

$('search').addEventListener('input', renderKeys);
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.querySelector('.key:not(:disabled)')?.click();
  if (e.key === 'Escape') reset();
});

// ---------- Encrypt ----------
async function doEncrypt(key, btn) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add('busy');
  btn.classList.add('selected');
  try {
    if (zipMode()) {
      await doZipEncrypt(key);
    } else {
      const { results, jobId } = await window.api.encrypt(state.files, key.fingerprint);
      renderResult(results, key, null, jobId);
      show('result');
    }
  } catch (err) {
    showError(err.message);
  } finally {
    state.busy = false;
    document.body.classList.remove('busy');
    btn.classList.remove('selected');
  }
}

// ---------- Zip + encrypt with progress ----------
function setProgress({ title, pct, bytes = '', file = '', indeterminate = false }) {
  $('prog-title').textContent = title;
  $('prog-fill').parentElement.classList.toggle('indeterminate', indeterminate);
  $('prog-fill').style.width = indeterminate ? '' : `${pct}%`;
  $('prog-pct').textContent = indeterminate ? '' : `${Math.floor(pct)}%`;
  $('prog-bytes').textContent = bytes;
  $('prog-file').textContent = file;
}

async function doZipEncrypt(key) {
  setProgress({ title: 'Scanning…', indeterminate: true });
  $('btn-cancel').disabled = false;
  show('progress');

  const off = window.api.onJobProgress((m) => {
    if (m.phase === 'scan') setProgress({ title: 'Scanning…', indeterminate: true });
    if (m.phase === 'zip') {
      const pct = m.total ? (m.processed / m.total) * 100 : 100;
      setProgress({
        title: `Zipping ${m.files} file${m.files === 1 ? '' : 's'}…`,
        pct,
        bytes: `${fmtBytes(m.processed)} of ${fmtBytes(m.total)}`,
        file: m.current,
      });
    }
    if (m.phase === 'encrypt') setProgress({ title: `Encrypting for ${key.uids[0] || key.keyId}…`, indeterminate: true });
  });

  try {
    const name = $('zip-name').value;
    const r = await window.api.encryptZip(state.files, key.fingerprint, name);
    if (r.cancelled) { show('keys'); return; }
    renderResult([r.ok
      ? { ok: true, output: r.output, file: r.output }
      : { ok: false, file: `${name}.zip`, error: r.error }], key, r.ok ? `Zipped ${r.count} file${r.count === 1 ? '' : 's'} and encrypted for ${key.uids[0] || key.keyId}` : null, r.jobId);
    show('result');
  } finally {
    off();
  }
}

$('btn-cancel').addEventListener('click', () => {
  $('btn-cancel').disabled = true;
  $('prog-title').textContent = 'Cancelling…';
  window.api.cancelJob();
});

let deleteJobId = null;
function setupDelete(jobId) {
  deleteJobId = jobId || null;
  $('btn-delete').classList.toggle('hidden', !deleteJobId);
  $('btn-delete').disabled = false;
  $('delete-status').classList.add('hidden');
}

$('btn-delete').addEventListener('click', async () => {
  if (!deleteJobId) return;
  $('btn-delete').disabled = true;
  const r = await window.api.deleteSources(deleteJobId); // native confirmation dialog lives in main
  const status = $('delete-status');
  if (r.cancelled) { $('btn-delete').disabled = false; return; }
  status.classList.remove('hidden');
  status.classList.toggle('fail', !r.ok);
  if (r.ok) {
    status.textContent = `${r.deleted} original${r.deleted === 1 ? '' : 's'} ${r.permanent ? 'permanently deleted' : 'moved to Trash'}.`;
    $('btn-delete').classList.add('hidden');
    deleteJobId = null;
  } else if (r.failed?.length) {
    status.textContent = `Deleted ${r.deleted}, failed ${r.failed.length}: ${r.failed.map((f) => `${basename(f.path)} (${f.error})`).join(', ')}`;
    $('btn-delete').classList.add('hidden');
  } else {
    status.textContent = r.error;
  }
});

function renderResult(results, key, customTitle, jobId) {
  setupDelete(jobId);
  const ok = results.filter((r) => r.ok).length;
  const box = $('result');
  const title = customTitle || (ok === results.length
    ? `Encrypted ${ok} file${ok === 1 ? '' : 's'} for ${key.uids[0] || key.keyId}`
    : `${ok} of ${results.length} encrypted`);
  box.replaceChildren(el('h2', null, title), ...results.map((r) => {
    const row = el('div', `row ${r.ok ? 'ok' : 'fail'}`);
    row.appendChild(el('span', 'dot'));
    const body = el('div', 'body');
    body.appendChild(el('div', 'path', basename(r.ok ? r.output : r.file)));
    body.appendChild(el('div', 'sub', r.ok ? r.output : r.error));
    row.appendChild(body);
    if (r.ok) {
      const b = el('button', 'link', 'Show');
      b.addEventListener('click', () => window.api.reveal(r.output));
      row.appendChild(b);
    }
    return row;
  }));
}

function reset() {
  state.files = [];
  state.info = [];
  show('drop');
}
$('btn-clear').addEventListener('click', reset);
$('btn-again').addEventListener('click', reset);

show('drop');
