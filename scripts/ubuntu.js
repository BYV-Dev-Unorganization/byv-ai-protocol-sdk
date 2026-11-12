'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.byv-ubuntu');
const SERVER_LOG = path.join(STATE_DIR, 'server.log');
const TUNNEL_LOG = path.join(STATE_DIR, 'cloudflared.log');
const SERVER_PID = path.join(STATE_DIR, 'server.pid');
const TUNNEL_PID = path.join(STATE_DIR, 'cloudflared.pid');
const URL_FILE = path.join(STATE_DIR, 'public-url.txt');
const STATUS_FILE = path.join(STATE_DIR, 'status.json');

function log(message) { process.stdout.write('[byv:ubuntu] ' + message + '\n'); }
function fail(message) { process.stderr.write('[byv:ubuntu] ERROR: ' + message + '\n'); process.exit(1); }
function readPid(file) {
  try { const pid = Number(fs.readFileSync(file, 'utf8').trim()); return Number.isSafeInteger(pid) && pid > 1 ? pid : null; }
  catch { return null; }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function isManagedProcess(pid, kind) {
  if (!alive(pid) || process.platform !== 'linux') return false;
  try {
    const command = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\\0/g, ' ');
    if (kind === 'server') {
      return fs.realpathSync('/proc/' + pid + '/cwd') === ROOT && /(?:^|\\s)src\\/index\\.js(?:\\s|$)/.test(command);
    }
    return /cloudflared/.test(command) && /\\btunnel\\b/.test(command) && command.includes('--url') && command.includes('--http-host-header');
  } catch { return false; }
}
function savePid(file, pid) { fs.writeFileSync(file, String(pid) + '\n', { mode: 0o600 }); }
function writeStatus(extra) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ updated_at: new Date().toISOString(), ...extra }, null, 2) + '\n', { mode: 0o600 });
}
function tailUrl() {
  try {
    const logText = fs.readFileSync(TUNNEL_LOG, 'utf8');
    const matches = logText.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    return matches && matches.length ? matches[matches.length - 1] : '';
  } catch { return ''; }
}
function localConfig() {
  let fileEnv = {};
  try { fileEnv = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const host = process.env.HOST || fileEnv.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || fileEnv.PORT || 8787);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    fail('HOST harus loopback (127.0.0.1/localhost/::1). Jangan bind gateway ke interface publik.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT di .env tidak valid.');
  return { host: host === 'localhost' ? '127.0.0.1' : host, port };
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + result.status);
}
function ensureCloudflared() {
  const found = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
  if (found.status === 0) {
    log('cloudflared tersedia: ' + (found.stdout || found.stderr).trim());
    return;
  }
  if (process.platform !== 'linux' || !fs.existsSync('/etc/os-release')) {
    fail('cloudflared belum terpasang. Auto-install hanya didukung pada Ubuntu/Debian Linux.');
  }
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  if (!/^ID=ubuntu$/m.test(osRelease) && !/^ID=debian$/m.test(osRelease)) {
    fail('Auto-install cloudflared hanya mendukung Ubuntu/Debian.');
  }
  if (spawnSync('apt-get', ['--version'], { stdio: 'ignore' }).status !== 0) fail('apt-get tidak ditemukan.');
  const isRoot = process.getuid && process.getuid() === 0;
  const sudo = isRoot ? '' : 'sudo ';
  if (!isRoot && spawnSync('sudo', ['--version'], { stdio: 'ignore' }).status !== 0) fail('sudo diperlukan untuk memasang cloudflared.');
  if (spawnSync('curl', ['--version'], { stdio: 'ignore' }).status !== 0) {
    log('curl belum ada; memasang curl dan ca-certificates...');
    run('bash', ['-lc', sudo + 'apt-get update && ' + sudo + 'apt-get install -y curl ca-certificates']);
  }
  log('cloudflared belum ada. Memasang dari repository resmi Cloudflare...');
  const command = [
    sudo + 'install -d -m 0755 /usr/share/keyrings',
    'curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | ' + sudo + 'tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null',
    'echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | ' + sudo + 'tee /etc/apt/sources.list.d/cloudflared.list >/dev/null',
    sudo + 'apt-get update',
    sudo + 'apt-get install -y cloudflared'
  ].join(' && ');
  run('bash', ['-lc', command]);
  const check = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
  if (check.status !== 0) fail('Instalasi selesai tetapi cloudflared belum dapat dijalankan.');
  log('cloudflared berhasil dipasang: ' + (check.stdout || check.stderr).trim());
}
function spawnBackground(command, args, logFile, pidFile) {
  const fd = fs.openSync(logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(command, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], env: process.env });
  } finally {
    fs.closeSync(fd);
  }
  child.once('error', (error) => {
    try { fs.appendFileSync(logFile, '\n[launcher] ' + error.message + '\n'); } catch {}
  });
  child.unref();
  if (!child.pid) fail('Gagal membuat proses background: ' + command);
  savePid(pidFile, child.pid);
  return child.pid;
}
async function waitForServer(url) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
async function waitForTunnel() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const url = tailUrl();
    if (url) return url;
    const pid = readPid(TUNNEL_PID);
    if (pid && !alive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return '';
}
async function start() {
  if (process.platform !== 'linux') fail('Perintah npm run ubuntu hanya untuk Linux/Ubuntu.');
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
  const { host, port } = localConfig();
  const localUrl = 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
  const dashboardUrl = localUrl + '/dashboard';

  let serverPid = readPid(SERVER_PID);
  const serverReady = await waitForServer(dashboardUrl);
  if (!serverReady) {
    if (serverPid && isManagedProcess(serverPid, 'server')) fail('Server PID ' + serverPid + ' masih hidup tetapi dashboard tidak merespons. Periksa ' + SERVER_LOG);
    if (serverPid) { try { fs.unlinkSync(SERVER_PID); } catch {} serverPid = null; }
    log('Menjalankan BYV gateway di background pada ' + localUrl + ' ...');
    serverPid = spawnBackground(process.execPath, ['src/index.js'], SERVER_LOG, SERVER_PID);
    if (!await waitForServer(dashboardUrl)) fail('BYV tidak siap dalam 30 detik. Periksa ' + SERVER_LOG);
  } else {
    log('BYV sudah aktif di ' + localUrl + '; menggunakan proses yang berjalan.');
    if (serverPid && !isManagedProcess(serverPid, 'server')) { try { fs.unlinkSync(SERVER_PID); } catch {} serverPid = null; }
    if (!serverPid) writeStatus({ local_url: localUrl, dashboard_url: dashboardUrl, server_managed: false });
  }

  ensureCloudflared();
  let tunnelPid = readPid(TUNNEL_PID);
  let publicUrl = tailUrl();
  if (tunnelPid && isManagedProcess(tunnelPid, 'tunnel') && publicUrl) {
    log('Cloudflare Tunnel sudah berjalan.');
  } else {
    if (tunnelPid && isManagedProcess(tunnelPid, 'tunnel')) {
      try { process.kill(tunnelPid, 'SIGTERM'); } catch {}
    }
    if (tunnelPid && !isManagedProcess(tunnelPid, 'tunnel')) { try { fs.unlinkSync(TUNNEL_PID); } catch {} }
    fs.writeFileSync(TUNNEL_LOG, '', { mode: 0o600 });
    log('Membuat Quick Tunnel dan menjalankannya di background...');
    tunnelPid = spawnBackground('cloudflared', [
      'tunnel', '--no-autoupdate', '--url', localUrl,
      '--http-host-header', host.includes(':') ? '[' + host + ']:' + port : host + ':' + port
    ], TUNNEL_LOG, TUNNEL_PID);
    publicUrl = await waitForTunnel();
    if (!publicUrl) fail('URL Cloudflare belum terdeteksi. Periksa ' + TUNNEL_LOG);
  }

  fs.writeFileSync(URL_FILE, publicUrl + '\n', { mode: 0o600 });
  try { fs.chmodSync(URL_FILE, 0o600); } catch {}
  writeStatus({
    local_url: localUrl,
    dashboard_url: dashboardUrl,
    public_url: publicUrl,
    public_dashboard_url: publicUrl + '/dashboard',
    server_pid: readPid(SERVER_PID),
    tunnel_pid: tunnelPid,
    server_managed: Boolean(readPid(SERVER_PID)),
    tunnel_managed: true
  });
  log('BYV dashboard lokal : ' + dashboardUrl);
  log('URL publik          : ' + publicUrl + '/dashboard');
  log('URL disimpan        : ' + URL_FILE);
  log('Status              : ' + STATUS_FILE);
  log('Log                 : ' + TUNNEL_LOG);
  log('Proses berjalan di background. URL Quick Tunnel dapat berubah setelah tunnel dibuat ulang.');
}
function status() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch {}
  const url = (() => { try { return fs.readFileSync(URL_FILE, 'utf8').trim(); } catch { return ''; } })();
  log('Public URL: ' + (url ? url + '/dashboard' : 'belum tersedia'));
  log('Status: ' + JSON.stringify({
    ...data,
    server_running: isManagedProcess(readPid(SERVER_PID), 'server'),
    tunnel_running: isManagedProcess(readPid(TUNNEL_PID), 'tunnel')
  }, null, 2));
}
function stop() {
  for (const [name, file] of [['Cloudflare Tunnel', TUNNEL_PID], ['BYV server', SERVER_PID]]) {
    const pid = readPid(file);
    const kind = file === TUNNEL_PID ? 'tunnel' : 'server';
    if (pid && isManagedProcess(pid, kind)) {
      try { process.kill(pid, 'SIGTERM'); log(name + ' dihentikan (PID ' + pid + ').'); }
      catch (error) { log('Tidak dapat menghentikan ' + name + ': ' + error.message); }
    } else log(name + ' tidak berjalan.');
    try { fs.unlinkSync(file); } catch {}
  }
  try { fs.unlinkSync(URL_FILE); } catch {}
  try { fs.unlinkSync(STATUS_FILE); } catch {}
}
const action = process.argv[2] || 'start';
if (action === 'status') status();
else if (action === 'stop') stop();
else if (action === 'start') start().catch((error) => fail(error.stack || error.message));
else fail('Aksi tidak dikenal. Gunakan start, status, atau stop.');
