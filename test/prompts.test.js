'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE_TEMPLATE, buildSystemPrompt, toolsToPrompt } = require('../src/prompts');

test('system template has exactly one tools placeholder and runtime prompt replaces it', () => {
  assert.equal((BASE_TEMPLATE.match(/\{\{AVAILABLE_TOOLS\}\}/g) || []).length, 1);
  const prompt = buildSystemPrompt({
    model: 'claude-sonnet-5-5',
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]
  });
  assert.doesNotMatch(prompt, /\{\{AVAILABLE_TOOLS\}\}/);
  assert.match(prompt, /"name": "Read"/);
  assert.match(prompt, /BYV parameter/);
});

test('no-tool prompt explicitly disables protocol calls', () => {
  const prompt = toolsToPrompt([]);
  assert.match(prompt, /No tools are available/);
  assert.match(prompt, /Do not emit BYV calls/);
});

test('tool choice overlays enforce none, any, and a specific tool', () => {
  const none = buildSystemPrompt({ model: 'byv-default', tools: [], tool_choice: 'none' });
  const any = buildSystemPrompt({ model: 'byv-default', tools: [{ name: 'Read', input_schema: { type: 'object' } }], tool_choice: 'any' });
  const specific = buildSystemPrompt({ model: 'byv-default', tools: [{ name: 'Read', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'Read' } });
  assert.match(none, /STOP: DO NOT CALL TOOLS/);
  assert.match(any, /must call at least one available tool/);
  assert.match(specific, /must call the tool named Read/);
});