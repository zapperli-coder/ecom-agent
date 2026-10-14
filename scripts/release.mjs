#!/usr/bin/env node
// Build a shareable zip: dist/ecom-agent-<version>.zip
//
// Only the allowlisted files below are copied, so data/ (login profile, order DB),
// .env (credentials) and anything else local can never end up in the package.
// Then every shipped file is scanned for your own secrets and personal strings:
//   - every non-empty value in your .env
//   - RELEASE_DENYLIST in .env (comma-separated, e.g. member id, real name, phone)
// The build fails if any of them appears.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['src', 'start.bat', 'start.ps1', 'README.md', 'LICENSE', '.env.example', 'package.json', 'package-lock.json'];
const FORBIDDEN = [/(^|[\\/])\.env$/, /(^|[\\/])data([\\/]|$)/, /\.db$/, /\.sqlite3$/, /(^|[\\/])node_modules([\\/]|$)/];
const MIN_SECRET_LEN = 4;  // shorter values (e.g. "5") would false-positive everywhere
// Plain settings whose values (a warehouse name, a folder) legitimately appear in the code.
const NON_SECRET_KEYS = new Set(['RELEASE_DENYLIST', 'SHEXP68_WAREHOUSE', 'ECOM_DATA_DIR']);

function fail(msg) { console.error(`release: ${msg}`); process.exit(1); }

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function sensitiveStrings() {
  const env = readEnv(path.join(ROOT, '.env'));
  const deny = (env.RELEASE_DENYLIST || '').split(',').map(s => s.trim());
  const values = Object.entries(env).filter(([k]) => !NON_SECRET_KEYS.has(k)).map(([, v]) => v);
  return [...new Set([...values, ...deny])].filter(s => s.length >= MIN_SECRET_LEN);
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p) : [p];
  });
}

function stage(stageDir) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) fail(`missing ${rel}`);
    fs.cpSync(src, path.join(stageDir, rel), { recursive: true });
  }
}

function audit(stageDir) {
  const secrets = sensitiveStrings();
  const problems = [];
  for (const file of listFiles(stageDir)) {
    const rel = path.relative(stageDir, file);
    if (FORBIDDEN.some(re => re.test(rel))) problems.push(`${rel}: forbidden file`);
    const text = fs.readFileSync(file, 'utf8');
    for (const s of secrets) if (text.includes(s)) problems.push(`${rel}: contains a value from your .env / RELEASE_DENYLIST`);
  }
  if (problems.length) fail(`refusing to package — personal data found:\n  ${problems.join('\n  ')}`);
  return secrets.length;
}

function zip(stageDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  const cwd = path.dirname(stageDir);
  if (process.platform === 'win32') {
    // Windows' bundled bsdtar writes zip with -a (Compress-Archive trips over AV file locks).
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', zipPath, path.basename(stageDir)], { cwd, stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', zipPath, path.basename(stageDir)], { cwd, stdio: 'inherit' });
  }
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) fail(`zip was not created: ${zipPath}`);
}

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const name = `ecom-agent-${version}`;
const stageDir = path.join(ROOT, 'dist', name);
const zipPath = path.join(ROOT, 'dist', `${name}.zip`);

stage(stageDir);
const checked = audit(stageDir);
zip(stageDir, zipPath);
console.log(`release: ${path.relative(ROOT, zipPath)} (${listFiles(stageDir).length} files, ${checked} personal strings checked)`);
