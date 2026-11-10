'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_PROFILES, MODEL_PROFILE_ALIASES, modelProfilePrompt, listModels, isSupportedModel } = require('../src/model-profiles');

test('exposes all response profiles with the BYV Flash V1 default', () => {
  assert.deepEqual(Object.keys(MODEL_PROFILES), [
    'byv-flash-v1',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-mythos-5-1',
    'claude-fable-5.1',
    'claude-fable-5-2',
    'claude-mythos-5-2',
    'claude-opus-5',
    'claude-opus-4-8'
  ]);
  assert.deepEqual(
    listModels().map(({ id, display_name }) => [id, display_name]),
    [
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-sonnet-5-5', 'Sonnet 5.5'],
      ['claude-haiku-5-5', 'Haiku 5.5'],
      ['claude-mythos-5-2', 'Mythos 5.2'],
      ['claude-mythos-5-1', 'Mythos 5.1'],
      ['claude-fable-5-2', 'Fable 5.2'],
      ['claude-fable-5.1', 'Fable 5.1'],
      ['claude-opus-5', 'Opus 5'],
      ['claude-opus-4-8', 'Opus 4.8'],
      ['byv-flash-v1', 'BYV Flash V1']
    ]
  );
});

test('each profile makes clear it is style guidance over the same upstream model', () => {
  for (const model of Object.keys(MODEL_PROFILES)) {
    const prompt = modelProfilePrompt(model);
    assert.match(prompt, /same configured upstream provider and model/);
    assert.match(prompt, /does not change model weights/i);
    assert.match(prompt, /style guidance only/i);
    assert.match(prompt, /active gateway runtime controls/i);
    assert.match(prompt, /tool permissions, input schemas, or required output format/i);
  }
});

test('generates dotted and hyphenated aliases for every Claude model profile', () => {
  for (const [alias, canonicalId] of Object.entries(MODEL_PROFILE_ALIASES)) {
    assert.notEqual(alias, canonicalId, `alias must not map to itself: ${alias}`);
    assert.ok(Object.hasOwn(MODEL_PROFILES, canonicalId), `alias target must exist: ${alias}`);
    assert.equal(isSupportedModel(alias), true, `alias must be supported: ${alias}`);
    assert.equal(
      modelProfilePrompt(alias),
      modelProfilePrompt(canonicalId),
      `alias must resolve to its canonical profile: ${alias}`
    );
  }

  for (const canonicalId of Object.keys(MODEL_PROFILES)) {
    const match = canonicalId.match(/^(claude-.+?)-(\\d+)[.-](\\d+)$/);
    if (!match) continue;
    const [, family, major, minor] = match;
    const dotted = family + '-' + major + '.' + minor;
    const hyphenated = family + '-' + major + '-' + minor;
    assert.equal(isSupportedModel(dotted), true, `dotted spelling must be supported: ${dotted}`);
    assert.equal(isSupportedModel(hyphenated), true, `hyphenated spelling must be supported: ${hyphenated}`);
    assert.equal(modelProfilePrompt(dotted), modelProfilePrompt(canonicalId));
    assert.equal(modelProfilePrompt(hyphenated), modelProfilePrompt(canonicalId));
  }
});

test('accepts canonical profile IDs and BYV aliases, rejects arbitrary IDs', () => {
  assert.equal(isSupportedModel('byv-flash-v1'), true);
  assert.equal(isSupportedModel('byv-default'), true);
  assert.equal(isSupportedModel('byv'), true);
  assert.equal(isSupportedModel('an-unknown-model'), false);
});


test('Claude Desktop discovery metadata identifies stable tier defaults', () => {
  const models = listModels();
  const byId = Object.fromEntries(models.map((model) => [model.id, model]));
  assert.equal(byId['claude-opus-5-5'].anthropic_family_tier, 'opus');
  assert.equal(byId['claude-opus-5-5'].is_family_default, true);
  assert.equal(byId['claude-opus-5'].anthropic_family_tier, 'opus');
  assert.equal(byId['claude-sonnet-5-5'].anthropic_family_tier, 'sonnet');
  assert.equal(byId['claude-sonnet-5-5'].is_family_default, true);
  assert.equal(byId['claude-haiku-5-5'].anthropic_family_tier, 'haiku');
  assert.equal(byId['claude-haiku-5-5'].is_family_default, true);
  assert.equal(byId['claude-mythos-5-2'].anthropic_family_tier, 'mythos');
  assert.equal(byId['claude-mythos-5-2'].is_family_default, true);
  assert.equal(byId['claude-mythos-5-1'].anthropic_family_tier, 'mythos');
  assert.equal(byId['claude-fable-5-2'].anthropic_family_tier, 'fable');
  assert.equal(byId['claude-fable-5-2'].is_family_default, true);
  assert.equal(byId['claude-fable-5.1'].anthropic_family_tier, 'fable');
  assert.ok(models.every((model) => model.created_at === '1970-01-01T00:00:00Z'));
  assert.ok(models.every((model) => (model.line === null || ['opus', 'sonnet', 'haiku', 'fable', 'mythos'].includes(model.line))));
});

test('model discovery output is deterministic across calls', () => {
  const first = listModels();
  const second = listModels();
  assert.deepEqual(first, second);
});
