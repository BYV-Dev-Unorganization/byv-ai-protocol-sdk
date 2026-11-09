'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt } = require('../src/prompts');

test('does not inject Anthropic effort settings into provider system prompt text', () => {
  const base = buildSystemPrompt({
    model: 'byv-flash-v1',
    tools: [{ name: 'Read', input_schema: { type: 'object' } }]
  }, { noToolExperiment: true, nativeToolCalling: false });
  const low = buildSystemPrompt({
    model: 'byv-flash-v1',
    output_config: { effort: 'low' },
    tools: [{ name: 'Read', input_schema: { type: 'object' } }]
  }, { noToolExperiment: true, nativeToolCalling: false });
  const high = buildSystemPrompt({
    model: 'byv-flash-v1',
    output_config: { effort: 'high' },
    tools: [{ name: 'Read', input_schema: { type: 'object' } }]
  }, { noToolExperiment: true, nativeToolCalling: false });

  assert.equal(low, base);
  assert.equal(high, base);
  assert.doesNotMatch(high, /RESPONSE EFFORT|reasoning depth/i);
});

test('keeps runtime tool-choice controls before model-profile guidance without an effort overlay', () => {
  const prompt = buildSystemPrompt({
    model: 'byv-flash-v1',
    output_config: { effort: 'high' },
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    tool_choice: 'any'
  }, { noToolExperiment: true, nativeToolCalling: false });
  const profile = prompt.indexOf('=== MODEL RESPONSE PROFILE ===');
  const runtime = prompt.indexOf('=== ACTIVE GATEWAY TOOL-CHOICE CONTROL ===');

  assert.ok(runtime >= 0 && profile > runtime);
  assert.equal(prompt.includes('=== RESPONSE EFFORT ==='), false);
});
