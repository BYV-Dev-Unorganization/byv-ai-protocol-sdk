'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { effortPrompt, buildSystemPrompt } = require('../src/prompts');

test('maps every supported effort level to explicit guidance and ignores unknown levels', () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  for (const level of levels) {
    const prompt = effortPrompt(level);
    assert.ok(prompt.includes('=== RESPONSE EFFORT ==='), level);
    assert.ok(prompt.length > 40, level + ' should produce meaningful guidance');
  }
  assert.equal(effortPrompt(undefined), '');
  assert.equal(effortPrompt('unknown'), '');
});

test('places effort guidance after the response profile and before runtime tool-choice controls', () => {
  const prompt = buildSystemPrompt({
    model: 'byv-flash-v1',
    output_config: { effort: 'high' },
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    tool_choice: 'any'
  });
  const profile = prompt.indexOf('=== MODEL RESPONSE PROFILE ===');
  const effort = prompt.indexOf('=== RESPONSE EFFORT ===');
  const runtime = prompt.indexOf('=== ACTIVE GATEWAY RUNTIME OVERLAY');
  assert.ok(profile >= 0 && effort > profile && runtime > effort);
});
