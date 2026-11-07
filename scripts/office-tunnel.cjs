'use strict';

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

function appendCsvValue(current, value) {
  const values = String(current || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(',');
}

function resolveOfficeTunnelConfig(env = process.env) {
  const token = String(env.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
  if (!token) {
    throw new Error('CLOUDFLARE_TUNNEL_TOKEN is required. Create a remotely-managed Cloudflare Tunnel and put its run token in .env.');
  }

  const rawHostname = String(env.OFFICE_GATEWAY_HOSTNAME || '').trim();
  if (!rawHostname) {
    throw new Error('OFFICE_GATEWAY_HOSTNAME is required (for example: claude-office.example.com).');
  }

  let parsed;
  try {
    parsed = new URL(rawHostname.includes('://') ? rawHostname : 'https://' + rawHostname);
  } catch {
    throw new Error('OFFICE_GATEWAY_HOSTNAME must be a hostname such as claude-office.example.com.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('OFFICE_GATEWAY_HOSTNAME must be an HTTPS hostname only, without credentials, port, path, query, or hash.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('OFFICE_GATEWAY_HOSTNAME must be a public DNS hostname.');
  }

  const host = String(env.HOST || '127.0.0.1').trim().toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('For Office Tunnel mode, HOST must stay on loopback (127.0.0.1, localhost, or ::1). Do not bind the gateway to a public interface.');
  }

  const port = Number(env.PORT || 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }

  const childEnv = {
    ...env,
    HOST: host,
    PORT: String(port),
    GATEWAY_ALLOWED_HOSTS: appendCsvValue(env.GATEWAY_ALLOWED_HOSTS, hostname),
    CORS_ALLOWED_ORIGINS: appendCsvValue(env.CORS_ALLOWED_ORIGINS, 'https://pivot.claude.ai')
  };

  return {
    token,
    hostname,
    host,
    port,
    publicUrl: 'https://' + hostname,
    localUrl: 'http://' + (host.includes(':') ? '[' + host.replace(/^\[|\]$/g, '') + ']' : host) + ':' + port,
    childEnv
  };
}

function executableAvailable(executable) {
  const result = spawnSync(executable, ['--version'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

async function waitForGateway(url, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('The BYV gateway exited before becoming ready (exit code ' + child.exitCode + ').');
    }
    try {
      const response = await fetch(url + '/api/hello', { method: 'HEAD' });
      if (response.status === 204) return;
      lastError = new Error('Gateway readiness probe returned HTTP ' + response.status + '.');
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the BYV gateway at ' + url + '. ' + (lastError ? lastError.message : ''));
}

async function main() {
  let config;
  try {
    config = resolveOfficeTunnelConfig();
  } catch (error) {
    process.stderr.write('[office-tunnel] ' + error.message + '\n');
    process.stderr.write('[office-tunnel] Copy .env.example to .env and configure the Cloudflare tunnel values.\n');
    process.exitCode = 1;
    return;
  }

  const cloudflared = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  if (!executableAvailable(cloudflared)) {
    process.stderr.write('[office-tunnel] cloudflared was not found or could not run. Install it and ensure it is on PATH.\n');
    process.stderr.write('[office-tunnel] Windows downloads: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write('[office-tunnel] Starting BYV gateway at ' + config.localUrl + '\n');
  process.stdout.write('[office-tunnel] Waiting for the local gateway to become ready...\n');

  const gateway = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: config.childEnv,
    stdio: 'inherit',
    windowsHide: true
  });

  let tunnel = null;
  let shuttingDown = false;
  const stop = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = Number.isInteger(code) ? code : 0;
    if (tunnel && tunnel.exitCode === null) tunnel.kill();
    if (gateway.exitCode === null) gateway.kill();
  };

  const onSignal = () => stop(0);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  gateway.once('error', (error) => {
    process.stderr.write('[office-tunnel] Could not start BYV gateway: ' + error.message + '\n');
    stop(1);
  });
  gateway.once('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write('[office-tunnel] BYV gateway stopped.\n');
      stop(code === 0 ? 0 : (code || 1));
    }
  });

  try {
    await waitForGateway(config.localUrl, gateway);
    if (shuttingDown) return;

    process.stdout.write('\n[office-tunnel] Gateway is ready. Starting the Cloudflare Named Tunnel...\n');
    process.stdout.write('[office-tunnel] Claude for Office URL: ' + config.publicUrl + '\n');
    process.stdout.write('[office-tunnel] Stop both processes with Ctrl+C.\n\n');

    tunnel = spawn(cloudflared, [
      'tunnel', '--no-autoupdate', 'run', '--token', config.token
    ], {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true
    });

    tunnel.once('error', (error) => {
      process.stderr.write('[office-tunnel] Could not start cloudflared: ' + error.message + '\n');
      stop(1);
    });
    tunnel.once('exit', (code) => {
      if (!shuttingDown) {
        process.stderr.write('[office-tunnel] Cloudflare Tunnel stopped.\n');
        stop(code === 0 ? 0 : (code || 1));
      }
    });
  } catch (error) {
    process.stderr.write('[office-tunnel] ' + error.message + '\n');
    stop(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('[office-tunnel] ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { appendCsvValue, resolveOfficeTunnelConfig, waitForGateway };
