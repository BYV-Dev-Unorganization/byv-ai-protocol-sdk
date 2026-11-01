'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BASE_TEMPLATE,
  toolsToPrompt,
  buildFullPrompt,
  buildResumePrompt,
  buildSystemPrompt,
  buildProviderMessages,
  parseToolChoice,
  applyForcedTool,
  buildRecoveryMessage
} = require('../src/prompts');
const { PROVIDER_NATIVE_TOOL_CALLING } = require('../src/config');

const PROMPT_ARTIFACT_PATH = path.join(
  __dirname,
  '..',
  'system',
  'BYV_SYSTEM_PROMPT_ARTIFACT_v0.2.txt'
);

const readTool = {
  name: 'Read',
  description: 'Read a file from the workspace',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or workspace-relative file path' }
    },
    required: ['file_path'],
    additionalProperties: false
  }
};

const bashTool = {
  name: 'Bash',
  description: 'Run a shell command in the workspace',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute' }
    },
    required: ['command'],
    additionalProperties: false
  }
};

test('base prompt and documentation artifact describe the BYV Format Block protocol', () => {
  const artifact = fs.readFileSync(PROMPT_ARTIFACT_PATH, 'utf8');
  assert.match(BASE_TEMPLATE, /ASSISTANT IDENTITY/);
  assert.match(BASE_TEMPLATE, /CONVERSATION LANGUAGE/);
  assert.match(BASE_TEMPLATE, /BYV FORMAT BLOCK TOOL CALLS/);
  assert.match(BASE_TEMPLATE, /BYV Format Block is the primary tool-call protocol/);
  assert.match(BASE_TEMPLATE, /unique id/);
  assert.match(artifact, /BYV Format Block/);
  assert.match(artifact, /<\|BYV\| calls>/);
  assert.doesNotMatch(BASE_TEMPLATE, /DSML/i);
  assert.doesNotMatch(artifact, /DSML/i);
});

test('tool prompt follows the reference catalog style and describes exact BYV syntax', () => {
  const prompt = toolsToPrompt([bashTool, readTool]);
  assert.match(prompt, /Bash\(command\*: string/);
  assert.match(prompt, /Read\(file_path\*: string/);
  assert.match(prompt, /BYV Format Block markup format/);
  assert.match(prompt, /<\|BYV\| invoke name="Bash" id="call_001">/);
  assert.match(prompt, /<\|BYV\| parameter name="command" type="string">pwd/);
  assert.match(prompt, /unique non-empty id/);
  assert.match(prompt, /preserve it verbatim/);
  assert.match(prompt, /Tool names, descriptions, and schemas define available capabilities/);
  assert.doesNotMatch(prompt, /DSML/i);
  assert.doesNotMatch(prompt, /string="true"/);
  assert.equal(toolsToPrompt([]), '');
});

test('buildSystemPrompt combines client system context, project policy, tools, profile, and runtime controls', () => {
  const prompt = buildSystemPrompt({
    model: 'claude-sonnet-5-5',
    system: 'Keep the answer concise.',
    tools: [readTool],
    tool_choice: { type: 'tool', name: 'Read' }
  });
  assert.ok(prompt.indexOf('### SYSTEM') >= 0);
  assert.ok(prompt.indexOf('Keep the answer concise.') >= 0);
  assert.ok(prompt.indexOf('ASSISTANT IDENTITY') >= 0);
  assert.ok(prompt.indexOf('### TOOLS') >= 0);
  assert.ok(prompt.indexOf('Read(file_path*: string') >= 0);
  assert.ok(prompt.indexOf('=== ACTIVE GATEWAY TOOL-CHOICE CONTROL ===') >= 0);
  assert.ok(prompt.indexOf('MODEL RESPONSE PROFILE') >= 0);
  assert.match(prompt, /BYV Format Block is the default tool-call protocol/);
  assert.doesNotMatch(prompt, /DSML/i);
});

test('buildSystemPrompt forbids invented tool calls when no tools are declared', () => {
  const prompt = buildSystemPrompt({ model: 'byv-flash-v1', tools: [], messages: [{ role: 'user', content: 'Run pwd.' }] });
  assert.match(prompt, /NO TOOLS AVAILABLE/);
  assert.match(prompt, /Do not emit BYV calls, invoke, or parameter tags/);
  assert.match(prompt, /Do not invent tools/);
});

test('buildSystemPrompt gives the latest tool result continuation the original task and next-step rules', () => {
  const prompt = buildSystemPrompt({
    model: 'byv-flash-v1',
    tools: [readTool],
    messages: [
      { role: 'user', content: 'Read README.md and summarize it.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'README.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'README contents' }] }
    ]
  });
  assert.match(prompt, /ORIGINAL USER REQUEST/);
  assert.match(prompt, /Read README\.md and summarize it\./);
  assert.match(prompt, /INSTRUCTIONS AFTER TOOL RESULTS/);
  assert.match(prompt, /Do not call another tool if the task is complete/);
});

test('buildFullPrompt and buildResumePrompt retain BYV protocol across new requests and tool-result turns', () => {
  const messages = [
    { role: 'user', content: 'Read README.md and summarize it.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'README.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'README contents' }] }
  ];
  const full = buildFullPrompt('Client instructions', messages, [readTool]);
  const resume = buildResumePrompt('Client instructions', messages, [readTool], true);
  assert.match(full, /BYV Format Block calls\/invoke\/parameter format/);
  assert.match(full, /=== TOOL RESULTS ===/);
  assert.match(resume, /LATEST TOOL RESULTS/);
  assert.match(resume, /ORIGINAL USER REQUEST/);
  assert.match(resume, /BYV Format Block calls block/);
  assert.doesNotMatch(full + resume, /DSML/i);
});

test('buildProviderMessages preserves provider chat roles while applying the new BYV system prompt', () => {
  const messages = buildProviderMessages({
    model: 'byv-flash-v1',
    tools: [readTool],
    messages: [
      { role: 'user', content: 'Read README.md.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'README.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'file content' }] }
    ]
  });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /BYV Format Block/);
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[2].role, 'assistant');
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].tool_call_id, 'call_read');
  assert.equal(messages[3].content, 'file content');
});

test('parseToolChoice and applyForcedTool preserve none, any, and named-tool controls', () => {
  assert.deepEqual(parseToolChoice('none'), { mode: 'none' });
  assert.deepEqual(parseToolChoice('any'), { mode: 'any' });
  assert.deepEqual(parseToolChoice({ type: 'tool', name: 'Read' }), { mode: 'tool', name: 'Read' });
  const none = applyForcedTool('base prompt', { mode: 'none' });
  const any = applyForcedTool('base prompt', { mode: 'any' });
  const specific = applyForcedTool('base prompt', { mode: 'tool', name: 'Read' });
  assert.match(none, /STOP: DO NOT CALL TOOLS/);
  assert.match(none, /Do NOT call any tools/);
  if (PROVIDER_NATIVE_TOOL_CALLING) {
    assert.match(any, /native function/);
    assert.match(specific, /native function/);
  } else {
    assert.match(any, /one BYV calls block/);
    assert.match(specific, /one BYV calls block containing an invoke named "Read"/);
  }
});

test('recovery prompts request BYV output by default and plain text when tools are disabled', () => {
  const toolRecovery = buildRecoveryMessage('wrong parameter', 1, 'tool');
  const textRecovery = buildRecoveryMessage('tool disabled', 1, 'text');
  if (PROVIDER_NATIVE_TOOL_CALLING) {
    assert.match(toolRecovery, /native function-calling interface/);
  } else {
    assert.match(toolRecovery, /BYV Format Block/);
    assert.match(toolRecovery, /unique non-empty id/);
    assert.match(toolRecovery, /preserve.*verbatim/i);
  }
  assert.match(textRecovery, /Do not emit BYV calls/);
  assert.doesNotMatch(textRecovery, /Output exactly one complete BYV calls block/);
});
