const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Apps launched from Finder don't inherit the shell PATH, so look in the usual spots.
const CANDIDATES = [
  '/opt/homebrew/bin/gpg',
  '/usr/local/bin/gpg',
  '/usr/local/MacGPG2/bin/gpg',
  '/opt/local/bin/gpg',
  '/usr/bin/gpg',
];

let gpgPath = null;
function findGpg() {
  if (gpgPath) return gpgPath;
  gpgPath = CANDIDATES.find((p) => fs.existsSync(p)) || 'gpg';
  return gpgPath;
}

function run(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(findGpg(), args, { maxBuffer: 32 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err) {
        if (err.name === 'AbortError') return reject(err);
        const msg = (stderr || err.message).toString().trim();
        return reject(new Error(err.code === 'ENOENT' ? 'gpg not found. Install it with: brew install gnupg' : msg));
      }
      resolve(stdout.toString());
    });
  });
}

// gpg escapes ':' and other chars in --with-colons output as \xNN
const unescape = (s) => s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function parseKeys(out) {
  const keys = [];
  let cur = null;
  let expectPrimaryFpr = false;
  for (const line of out.split('\n')) {
    const f = line.split(':');
    switch (f[0]) {
      case 'pub':
        cur = {
          validity: f[1],
          keyId: f[4],
          created: f[5] ? new Date(Number(f[5]) * 1000).toISOString().slice(0, 10) : null,
          expires: f[6] ? new Date(Number(f[6]) * 1000).toISOString().slice(0, 10) : null,
          algo: f[3],
          bits: f[2],
          caps: f[11] || '',
          fingerprint: null,
          uids: [],
        };
        keys.push(cur);
        expectPrimaryFpr = true;
        break;
      case 'fpr':
        if (cur && expectPrimaryFpr) { cur.fingerprint = f[9]; expectPrimaryFpr = false; }
        break;
      case 'sub':
        expectPrimaryFpr = false;
        break;
      case 'uid':
        if (cur && f[1] !== 'r' && f[1] !== 'e') cur.uids.push(unescape(f[9]));
        break;
    }
  }
  return keys
    .filter((k) => k.fingerprint)
    .map((k) => ({
      ...k,
      // Uppercase E in the primary key's capability field = key is usable for encryption overall.
      canEncrypt: k.caps.includes('E') && !['r', 'e', 'd', 'i'].includes(k.validity),
      status: { r: 'revoked', e: 'expired', d: 'disabled', i: 'invalid' }[k.validity] || 'ok',
    }));
}

async function listKeys() {
  const out = await run(['--batch', '--with-colons', '--fixed-list-mode', '--list-keys']);
  return parseKeys(out);
}

// "<dir>/<stem><ext>", or "<dir>/<stem> (n)<ext>" if that exists.
function uniqueOutput(dir, stem, ext) {
  let out = path.join(dir, `${stem}${ext}`);
  for (let n = 1; fs.existsSync(out); n++) out = path.join(dir, `${stem} (${n})${ext}`);
  return out;
}

async function encrypt(file, fingerprint, { output, noCompress = false, signal } = {}) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
  output ??= uniqueOutput(path.dirname(file), path.basename(file), '.gpg');
  try {
    await run([
      '--batch', '--yes',
      '--trust-model', 'always', // the user explicitly picked this key
      ...(noCompress ? ['--compress-algo', 'none'] : []),
      '--recipient', fingerprint,
      '--output', output,
      '--encrypt', file,
    ], { signal });
  } catch (err) {
    fs.rmSync(output, { force: true }); // don't leave a partial .gpg behind
    throw err;
  }
  return output;
}

module.exports = { listKeys, encrypt, parseKeys, findGpg, uniqueOutput };
