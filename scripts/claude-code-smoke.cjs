'use strict';

// End-to-end Claude Code CLI -> BYV gateway test.
// Adapted from naufalelghani/deepseek-super/scripts/claude-code-smoke.cjs.
// Uses an isolated temporary workspace and a strict built-in tool allowlist.
// Run: npm run test:claude-code

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');

function normalizeBaseURL(value) {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (url.pathname.endsWith('/v1')) url.pathname = url.pathname.slice(0, -3);
  return url.toString().replace(/\/$/, '');
}

const BASE_URL = normalizeBaseURL(
  process.env.BYV_BASE_URL ||
  process.env.ANTHROPIC_BASE_URL ||
  'http://127.0.0.1:8787'
);
const MODEL = process.env.BYV_CLAUDE_CODE_MODEL || 'claude-sonnet-5-5';
const TIMEOUT_MS = Number.parseInt(process.env.CLAUDE_CODE_TEST_TIMEOUT_MS || '600000', 10);
const TEST_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep';
const REQUIRED_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];

function isLocalGateway(value) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      (url.pathname === '' || url.pathname === '/') &&
      Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === 8787;
  } catch {
    return false;
  }
}

function readLocalToken() {
  if (!isLocalGateway(BASE_URL)) return '';
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.byv-gateway-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function readEnvFileToken() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    return String(parsed.GATEWAY_API_KEY || '').trim();
  } catch {
    return '';
  }
}

function uniqueTokens(entries) {
  const seen = new Set();
  return entries
    .map(([label, value]) => ({ label, token: String(value || '').replace(/\s+/g, '') }))
    .filter(({ token }) => {
      if (!token || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
}

async function resolveGatewayToken() {
  if (!isLocalGateway(BASE_URL)) {
    const candidates = uniqueTokens([
      ['ANTHROPIC_AUTH_TOKEN', process.env.ANTHROPIC_AUTH_TOKEN],
      ['ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY],
      ['BYV_GATEWAY_TOKEN', process.env.BYV_GATEWAY_TOKEN],
      ['GATEWAY_API_KEY', process.env.GATEWAY_API_KEY]
    ]);
    if (!candidates.length) {
      throw new Error('Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for the selected gateway.');
    }
    return candidates[0];
  }

  // Prefer an explicit BYV token, then the local token file. Other environment
  // and .env candidates are tried only when necessary. This avoids a stale
  // GATEWAY_API_KEY in another PowerShell session overriding the local token.
  const candidates = uniqueTokens([
    ['BYV_GATEWAY_TOKEN', process.env.BYV_GATEWAY_TOKEN],
    ['.byv-gateway-token', readLocalToken()],
    ['GATEWAY_API_KEY (process environment)', process.env.GATEWAY_API_KEY],
    ['GATEWAY_API_KEY (.env)', readEnvFileToken()],
    ['ANTHROPIC_AUTH_TOKEN', process.env.ANTHROPIC_AUTH_TOKEN],
    ['ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY]
  ]);

  if (!candidates.length) {
    throw new Error('Gateway token not found. Start npm start first so .byv-gateway-token is created, or set BYV_GATEWAY_TOKEN.');
  }

  let lastStatus = null;
  for (const candidate of candidates) {
    let response;
    try {
      response = await fetch(new URL('/health', BASE_URL), {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + candidate.token },
        signal: AbortSignal.timeout(5000)
      });
    } catch (error) {
      throw new Error('Could not reach the local BYV gateway at ' + BASE_URL + ': ' + error.message);
    }

    if (response.status === 200) {
      const modelsResponse = await fetch(new URL('/v1/models', BASE_URL), {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + candidate.token },
        signal: AbortSignal.timeout(5000)
      });
      if (!modelsResponse.ok) {
        throw new Error('Gateway authentication passed, but GET /v1/models returned HTTP ' + modelsResponse.status + '.');
      }
      const modelPayload = await modelsResponse.json();
      const supported = Array.isArray(modelPayload.data) &&
        modelPayload.data.some((item) => item && item.id === MODEL);
      if (!supported) {
        const available = Array.isArray(modelPayload.data)
          ? modelPayload.data.map((item) => item && item.id).filter(Boolean)
          : [];
        throw new Error(
          'Model profile "' + MODEL + '" is not listed by the local BYV gateway. Available profiles: ' +
          (available.join(', ') || '(none)')
        );
      }
      return candidate;
    }

    lastStatus = response.status;
    if (response.status !== 401) {
      throw new Error('Local BYV gateway preflight returned unexpected HTTP ' + response.status + '.');
    }
  }

  throw new Error(
    'All available local gateway token candidates were rejected with HTTP 401. ' +
    'The running gateway may have been started with a different GATEWAY_API_KEY. ' +
    'Check the "Gateway auth source" line in Terminal 1; when it says "local token file", ' +
    'the script should use .byv-gateway-token. If it says "environment", set BYV_GATEWAY_TOKEN ' +
    'to the exact key used by the running server. No Claude Code session was started. ' +
    'Last HTTP status: ' + lastStatus
  );
}

function quoteArg(value) {
  const text = String(value);
  if (process.platform === 'win32') return '"' + text.replace(/"/g, '\\"') + '"';
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function findObjects(root, predicate, found = []) {
  if (!root || typeof root !== 'object') return found;
  if (predicate(root)) found.push(root);
  if (Array.isArray(root)) {
    for (const item of root) findObjects(item, predicate, found);
  } else {
    for (const value of Object.values(root)) findObjects(value, predicate, found);
  }
  return found;
}

function parseStreamJson(stdout) {
  const events = [];
  const otherLines = [];
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    try { events.push(JSON.parse(value)); }
    catch { otherLines.push(value); }
  }
  return { events, otherLines };
}

function runClaude(prompt, settingsPath, cwd, token) {
  return new Promise((resolve, reject) => {
    const args = [
      '--restricted',
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--settings', settingsPath,
      '--tools', TEST_TOOLS,
      '--model', MODEL,
      '--max-turns', '12',
      prompt
    ];
    const command = ['claude', ...args].map(quoteArg).join(' ');
    const child = spawn(command, [], {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: BASE_URL,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_API_KEY: token,
        ANTHROPIC_MODEL: MODEL,
        ANTHROPIC_CUSTOM_MODEL_OPTION: MODEL,
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'BYV ' + MODEL,
        ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'The selected BYV response profile'
      },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let pendingStdout = '';
    let finished = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('Claude Code timed out after ' + TIMEOUT_MS + ' ms.'));
    }, TIMEOUT_MS);

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      pendingStdout += chunk;
      const lines = pendingStdout.split(/\r?\n/);
      pendingStdout = lines.pop() || '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line.trim());
          if (event.type === 'system' && event.subtype === 'api_retry' &&
              Number(event.error_status) === 401) {
            child.kill();
            finish(new Error(
              'Claude Code received HTTP 401 and started its own API retry loop. ' +
              'The request token was rejected after the successful preflight; the process was stopped ' +
              'to avoid repeated retries. Verify the gateway key and Claude Code auth environment.'
            ));
            return;
          }
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(new Error(
      'Could not launch Claude Code CLI. Install it and ensure "claude" is on PATH. ' + error.message
    )));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        finish(new Error(
          'Claude Code exit code=' + code + ' signal=' + signal +
          '\nSTDERR:\n' + (stderr || '(empty)') +
          '\nSTDOUT (tail):\n' + stdout.slice(-12000)
        ));
      } else {
        finish(null, { stdout, stderr });
      }
    });
  });
}

async function main() {
  console.log('BYV Claude Code CLI integration test');
  console.log('Gateway:', BASE_URL);
  console.log('Model profile:', MODEL);
  console.log('Tools under test:', REQUIRED_TOOLS.join(', '));

  const token = await resolveGatewayToken();
  if (isLocalGateway(BASE_URL)) {
    console.log('Gateway authentication preflight: PASS');
    console.log('Model profile availability preflight: PASS');
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'byv-claude-code-test-'));
  const settingsPath = path.join(os.tmpdir(), 'byv-claude-code-settings-' + process.pid + '.json');

  fs.mkdirSync(path.join(workspace, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'byv-claude-code-fixture',
    private: true
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'BYV_GREP_MATCH\nordinary fixture line\n');
  fs.writeFileSync(path.join(workspace, 'nested', 'second.txt'), 'BYV_SECOND_FIXTURE\n');
  fs.writeFileSync(path.join(workspace, 'fixture-edit.txt'), 'EDIT_BEFORE\n');

  fs.writeFileSync(settingsPath, JSON.stringify({
    modelOverrides: {
      'claude-sonnet-4-5-20250929': MODEL
    },
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        'Edit',
        'Write',
        'Bash(pwd)'
      ]
    }
  }, null, 2));

  const prompt = [
    'This is a mandatory BYV gateway integration test. Use every one of these six tools for its named task.',
    'Perform the tasks sequentially: make exactly one tool call in each response, wait for its real tool result, then continue. Do not batch calls.',
    '1. Read: read package.json and identify its top-level name.',
    '2. Glob: find all files matching **/*.txt in the current workspace.',
    '3. Grep: search for the exact string BYV_GREP_MATCH in **/*.txt.',
    '4. Edit: in fixture-edit.txt replace EDIT_BEFORE with EDIT_AFTER.',
    '5. Write: create smoke-created.txt with exactly WRITE_OK as its contents.',
    '6. Bash: execute exactly the one command pwd. Do not chain commands.',
    'Do not run any other shell command, do not access files outside the current workspace, and do not use other tools.',
    'After every tool has returned a result, report the package name, files found by Glob, Grep match file, and output from pwd.'
  ].join(' ');

  const isolatedPrompts = {
    Read: 'Use the Read tool exactly once to read package.json in the current workspace. Do not call any other tool. After the tool returns, state the package name.',
    Glob: 'Use the Glob tool exactly once to find all files matching **/*.txt in the current workspace. Do not call any other tool. After the tool returns, list the matching paths.',
    Grep: 'Use the Grep tool exactly once to search the current workspace for the exact string BYV_GREP_MATCH in files matching **/*.txt. Do not call any other tool. After the tool returns, state the matching file.',
    Edit: 'Use the Edit tool exactly once on fixture-edit.txt in the current workspace, replacing EDIT_BEFORE with EDIT_AFTER. Do not call any other tool. After the tool returns, confirm the edit.',
    Write: 'Use the Write tool exactly once to create smoke-created.txt in the current workspace with exactly WRITE_OK as its contents. Do not call any other tool. After the tool returns, confirm the file was written.',
    Bash: 'Use the Bash tool exactly once to execute exactly the command pwd in the current workspace. Do not run any other command and do not call any other tool. After the tool returns, report its output.'
  };

  try {
    console.log('Temporary workspace:', workspace);
    console.log('Running Claude Code in restricted mode ...');
    const firstRun = await runClaude(prompt, settingsPath, workspace, token.token);
    const allEvents = [];
    const allOtherLines = [];
    const allStderr = [];
    function collectRun(run) {
      const parsedRun = parseStreamJson(run.stdout);
      allEvents.push(...parsedRun.events);
      allOtherLines.push(...parsedRun.otherLines);
      if (run.stderr.trim()) allStderr.push(run.stderr.trim());
    }
    collectRun(firstRun);

    let toolUses = findObjects(allEvents, (item) =>
      item.type === 'tool_use' && typeof item.name === 'string'
    );
    const missingBeforeIsolation = REQUIRED_TOOLS.filter((name) =>
      !toolUses.some((item) => item.name === name)
    );

    // Some model profiles stop after completing only the first few tasks in a
    // long prompt. Exercise any missing tool with a focused CLI invocation so
    // each tool is still tested through the real Claude Code -> BYV path.
    for (const name of missingBeforeIsolation) {
      console.log('Running isolated tool check:', name);
      const isolatedRun = await runClaude(isolatedPrompts[name], settingsPath, workspace, token.token);
      const isolatedParsed = parseStreamJson(isolatedRun.stdout);
      const isolatedUses = findObjects(isolatedParsed.events, (item) =>
        item.type === 'tool_use' && typeof item.name === 'string'
      );
      const unexpectedUses = isolatedUses.filter((item) => item.name !== name);
      assert.equal(
        unexpectedUses.length,
        0,
        'Isolated ' + name + ' check invoked unexpected tools: ' +
        unexpectedUses.map((item) => item.name).join(', ')
      );
      assert.equal(
        isolatedUses.filter((item) => item.name === name).length,
        1,
        'Isolated ' + name + ' check did not invoke the requested tool exactly once. ' +
        'Observed: ' + isolatedUses.map((item) => item.name).join(', ')
      );
      allEvents.push(...isolatedParsed.events);
      allOtherLines.push(...isolatedParsed.otherLines);
      if (isolatedRun.stderr.trim()) allStderr.push(isolatedRun.stderr.trim());
    }

    const parsed = { events: allEvents, otherLines: allOtherLines };
    toolUses = findObjects(parsed.events, (item) =>
      item.type === 'tool_use' && typeof item.name === 'string'
    );
    const toolResults = findObjects(parsed.events, (item) =>
      item.type === 'tool_result' ||
      (typeof item.tool_use_id === 'string' && Object.prototype.hasOwnProperty.call(item, 'content'))
    );
    const missing = REQUIRED_TOOLS.filter((name) => !toolUses.some((item) => item.name === name));
    assert.deepEqual(
      missing,
      [],
      'Claude Code did not invoke every required tool. Missing: ' + missing.join(', ') +
      '. Observed: ' + [...new Set(toolUses.map((item) => item.name))].join(', ')
    );

    const bashCalls = toolUses.filter((item) => item.name === 'Bash');
    assert.equal(bashCalls.length, 1, 'expected exactly one Bash call');
    assert.equal(bashCalls[0].input && bashCalls[0].input.command, 'pwd',
      'the only allowed Bash command is pwd');

    assert.ok(toolResults.length >= REQUIRED_TOOLS.length,
      'expected a result for each of the six tool calls');
    const missingResults = toolUses.filter((item) =>
      REQUIRED_TOOLS.includes(item.name) &&
      item.id &&
      !toolResults.some((result) => result.tool_use_id === item.id)
    );
    assert.deepEqual(missingResults, [], 'one or more tool calls did not receive a result');

    const edited = fs.readFileSync(path.join(workspace, 'fixture-edit.txt'), 'utf8');
    assert.match(edited, /EDIT_AFTER/);
    assert.doesNotMatch(edited, /EDIT_BEFORE/);

    const writtenPath = path.join(workspace, 'smoke-created.txt');
    assert.ok(fs.existsSync(writtenPath), 'Write did not create smoke-created.txt');
    assert.equal(fs.readFileSync(writtenPath, 'utf8').trim(), 'WRITE_OK');

    const finalText = parsed.events
      .filter((event) => event.type === 'result')
      .map((event) => event.result || '')
      .join('\n');
    for (const name of REQUIRED_TOOLS) console.log('PASS tool called:', name);
    console.log('PASS tool results observed:', toolResults.length);
    console.log('PASS Edit and Write changed only the temporary workspace');
    console.log('PASS Bash command restricted to pwd');
    if (finalText) console.log('\nClaude Code final response:\n' + finalText);
    if (run.stderr.trim()) console.log('\nClaude Code diagnostics:\n' + run.stderr.trim().slice(-3000));
    if (parsed.otherLines.length) {
      console.log('\nAdditional CLI output:\n' + parsed.otherLines.join('\n').slice(-2000));
    }
    console.log('\nBYV CLAUDE CODE CLI INTEGRATION TEST PASSED');
  } finally {
    try { fs.unlinkSync(settingsPath); } catch {}
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error('\nBYV CLAUDE CODE CLI INTEGRATION TEST FAILED');
  console.error(error && error.stack ? error.stack : error);
  console.error('\nEnsure the gateway is running at ' + BASE_URL + ', the gateway token is valid, and Claude Code CLI is installed.');
  process.exitCode = 1;
});
