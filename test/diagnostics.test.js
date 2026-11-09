'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnostics } = require('../src/diagnostics');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'byv-diagnostics-'));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('diagnostics omit request and response content by default', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnostics = createDiagnostics({ directory, captureContent: false });

  diagnostics.record('request.received', {
    request_id: 'req_metadata',
    message_count: 1,
    content: { body: { messages: [{ role: 'user', content: 'private prompt text' }] } }
  });
  diagnostics.record('provider.response.completed', {
    request_id: 'req_metadata',
    response_chars: 18,
    content: { text: 'private answer text' }
  });

  const requests = readJsonl(path.join(directory, 'requests.jsonl'));
  const responses = readJsonl(path.join(directory, 'responses.jsonl'));
  const timeline = readJsonl(path.join(directory, 'timeline.jsonl'));

  assert.equal(requests[0].content_captured, false);
  assert.equal(Object.hasOwn(requests[0], 'content'), false);
  assert.equal(responses[0].content_captured, false);
  assert.equal(Object.hasOwn(responses[0], 'content'), false);
  assert.equal(JSON.stringify(timeline).includes('private prompt text'), false);
  assert.equal(JSON.stringify(timeline).includes('private answer text'), false);
});

test('opt-in content capture redacts secret fields and common secret patterns', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnostics = createDiagnostics({
    directory,
    captureContent: true,
    secrets: ['provider-secret-value']
  });

  diagnostics.record('provider.response.completed', {
    request_id: 'req_capture',
    usage: { input_tokens: 123, output_tokens: 45 },
    content: {
      text: 'key=provider-secret-value; api_key=inline-secret-123; Authorization: Bearer abc.def.ghi',
      nested: { password: 'plain-password', token: 'plain-token' }
    }
  });

  const entry = readJsonl(path.join(directory, 'responses.jsonl'))[0];
  assert.equal(entry.content_captured, true);
  assert.equal(entry.usage.input_tokens, 123);
  const serialized = JSON.stringify(entry.content);
  assert.equal(serialized.includes('provider-secret-value'), false);
  assert.equal(serialized.includes('inline-secret-123'), false);
  assert.equal(serialized.includes('abc.def.ghi'), false);
  assert.equal(serialized.includes('plain-password'), false);
  assert.equal(serialized.includes('plain-token'), false);
  assert.equal(serialized.includes('[REDACTED]'), true);
});

test('opt-in diagnostics redact base64 image data and image URLs', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnostics = createDiagnostics({ directory, captureContent: true });
  const base64 = 'private-image-base64-value';
  const signedUrl = 'https://images.example.test/private.jpg?signature=private-signature';

  diagnostics.record('request.received', {
    request_id: 'req_image_capture',
    content: {
      body: {
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            { type: 'image', source: { type: 'url', url: signedUrl } }
          ]
        }]
      }
    }
  });
  diagnostics.record('provider.request.started', {
    request_id: 'req_image_capture',
    content: {
      messages: [{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,' + base64 }
        }]
      }]
    }
  });

  const serialized = JSON.stringify(readJsonl(path.join(directory, 'timeline.jsonl')));
  assert.equal(serialized.includes(base64), false);
  assert.equal(serialized.includes(signedUrl), false);
  assert.match(serialized, /IMAGE DATA REDACTED/);
  assert.match(serialized, /IMAGE URL REDACTED/);
});

test('diagnostics write a correlated timeline and split event categories', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnostics = createDiagnostics({ directory, captureContent: false });

  diagnostics.record('request.received', { request_id: 'req_split', model_profile: 'byv-flash-v1' });
  diagnostics.record('provider.request.started', { request_id: 'req_split', provider_attempt: 1 });
  diagnostics.record('provider.response.completed', { request_id: 'req_split', provider_attempt: 1 });
  diagnostics.record('request.failed', { request_id: 'req_split', level: 'error', error_code: 'PROVIDER_STREAM_ERROR' });

  assert.equal(readJsonl(path.join(directory, 'requests.jsonl')).length, 2);
  assert.equal(readJsonl(path.join(directory, 'responses.jsonl')).length, 1);
  assert.equal(readJsonl(path.join(directory, 'errors.jsonl')).length, 1);
  const timeline = readJsonl(path.join(directory, 'timeline.jsonl'));
  assert.equal(timeline.length, 4);
  assert.ok(timeline.every((entry) => entry.request_id === 'req_split'));
  assert.ok(timeline.every((entry) => typeof entry.timestamp === 'string'));
});

test('diagnostic files rotate when their configured size is reached', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnostics = createDiagnostics({
    directory,
    captureContent: false,
    maxFileBytes: 180,
    rotations: 2
  });

  diagnostics.record('request.received', { request_id: 'req_rotate', detail: 'x'.repeat(100) });
  diagnostics.record('request.received', { request_id: 'req_rotate', detail: 'y'.repeat(100) });
  diagnostics.record('request.received', { request_id: 'req_rotate', detail: 'z'.repeat(100) });

  assert.equal(fs.existsSync(path.join(directory, 'requests.jsonl')), true);
  assert.equal(fs.existsSync(path.join(directory, 'requests.jsonl.1')), true);
  assert.equal(fs.existsSync(path.join(directory, 'requests.jsonl.2')), true);
});
