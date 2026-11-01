'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_PROFILES, modelProfilePrompt, listModels, isSupportedModel } = require('../src/model-profiles');

test('exposes six response profiles while keeping one provider model configuration', () => {
  assert.deepEqual(Object.keys(MODEL_PROFILES), [
    'byv-default',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-mythos-5-1',
    'claude-fable-5.1'
  ]);
  assert.equal(listModels().length, 6);
});

test('each profile makes clear it is style guidance over the same upstream model', () => {
  for (const model of Object.keys(MODEL_PROFILES)) {
    const prompt = modelProfilePrompt(model);
    assert.match(prompt, /same configured upstream provider and model/);
    assert.match(prompt, /does not change model weights/i);
  }
});

test('profile aliases resolve to their canonical profile', () => {
  assert.equal(modelProfilePrompt('claude-mythos-5.1'), modelProfilePrompt('claude-mythos-5-1'));
  assert.equal(modelProfilePrompt('claude-fable-5-1'), modelProfilePrompt('claude-fable-5.1'));
});

test('accepts canonical profile IDs and documented aliases, rejects arbitrary IDs', () => {
  assert.equal(isSupportedModel('byv-default'), true);
  assert.equal(isSupportedModel('byv'), true);
  assert.equal(isSupportedModel('claude-fable-5-1'), true);
  assert.equal(isSupportedModel('claude-mythos-5.1'), true);
  assert.equal(isSupportedModel('an-unknown-model'), false);
});
