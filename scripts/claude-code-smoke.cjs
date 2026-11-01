'use strict';

// End-to-end Claude Code CLI -> BYV gateway test.
// The CLI runs only in a temporary workspace with a narrow tool allowlist.
// Run: npm run test:claude-code

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
const MODEL = process.env.ANTHROPIC_MODEL || process.env.BYV_MODEL || 'byv-flash-v1';
const TIMEOUT_MS = Number.parseInt(process.env.CLAUDE_CODE_TEST_TIMEOUT_MS || '600000', 10);

function isLocalGateway(value) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      (url.pathname === '' || url.pathname === '/') &&
      Number(url.port || 80) === 8787;
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

const TOKEN = (
  process.env.GATEWAY_API_KEY ||
  (isLocalGateway(BASE_URL) ? readLocalToken() : '') ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.ANTHROPIC_API_KEY ||
  ''
).replace(/\s+/g, '');

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

function runClaude(prompt, settingsPath, cwd) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--settings', settingsPath,
      '--tools', 'Read,Glob,Grep,Edit,Write,Bash',
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
        ANTHROPIC_AUTH_TOKEN: TOKEN,
        ANTHROPIC_API_KEY: TOKEN,
        ANTHROPIC_MODEL: MODEL,
        ANTHROPIC_CUSTOM_MODEL_OPTION: MODEL,
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'BYV local gateway',
        ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'The selected BYV response profile'
      },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
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
  console.log('Tools under test: Read, Glob, Grep, Edit, Write, Bash(pwd)');

  if (!TOKEN) {
    throw new Error(isLocalGateway(BASE_URL)
      ? 'Gateway token not found. Start npm start first so .byv-gateway-token is created, or set GATEWAY_API_KEY.'
      : 'Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for the selected gateway.');
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
    permissions: {
      allow: [
        'Read(./**)',
        'Glob',
        'Grep',
        'Edit(./**)',
        'Write(./**)',
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

  try {
    console.log('Temporary workspace:', workspace);
    console.log('Running Claude Code in non-interactive, dontAsk mode ...');
    const run = await runClaude(prompt, settingsPath, workspace);
    const parsed = parseStreamJson(run.stdout);
    const toolUses = findObjects(parsed.events, (item) =>
      item.type === 'tool_use' && typeof item.name === 'string'
    );
    const toolResults = findObjects(parsed.events, (item) =>
      item.type === 'tool_result' ||
      (typeof item.tool_use_id === 'string' && Object.prototype.hasOwnProperty.call(item, 'content'))
    );
    const required = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
    const missing = required.filter((name) => !toolUses.some((item) => item.name === name));
    assert.deepEqual(missing, [], 'Claude Code did not invoke every required tool');

    const bashCalls = toolUses.filter((item) => item.name === 'Bash');
    assert.equal(bashCalls.length, 1, 'expected exactly one Bash call');
    assert.equal(bashCalls[0].input && bashCalls[0].input.command, 'pwd',
      'the only allowed Bash command is pwd');

    assert.ok(toolResults.length >= required.length,
      'expected a result for each of the six tool calls');
    const missingResults = toolUses.filter((item) =>
      required.includes(item.name) &&
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
    for (const name of required) console.log('PASS tool called:', name);
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
  console.error('\nEnsure the gateway is running at ' + BASE_URL + ', the provider responds, and Claude Code CLI is installed.');
  process.exitCode = 1;
});
