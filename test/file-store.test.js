'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFileStore } = require('../src/file-store');

test('stores Files API metadata and content with generated file IDs', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byv-files-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createFileStore({ directory });
  const tempPath = path.join(directory, 'upload.tmp');
  await fs.writeFile(tempPath, Buffer.from('%PDF-1.7 test'));

  const metadata = await store.create(tempPath, {
    filename: 'report.pdf',
    mimeType: 'application/pdf'
  });
  assert.match(metadata.id, /^file_[a-f0-9]{24}$/);
  assert.equal(metadata.type, 'file');
  assert.equal(metadata.filename, 'report.pdf');
  assert.equal(metadata.mime_type, 'application/pdf');
  assert.equal(metadata.size_bytes, 13);
  assert.equal(metadata.downloadable, false);
  assert.equal(metadata.expires_at, null);

  const stored = await store.read(metadata.id);
  assert.equal(stored.metadata.id, metadata.id);
  assert.equal(stored.content.toString('utf8'), '%PDF-1.7 test');
  assert.deepEqual((await store.list()).data.map((item) => item.id), [metadata.id]);

  assert.equal(await store.delete(metadata.id), true);
  assert.equal(await store.getMetadata(metadata.id), null);
  assert.equal(await store.delete(metadata.id), false);
});

test('validates file names, expiry, and individual upload size', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byv-files-limits-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createFileStore({ directory, maxFileBytes: 4 });
  const tempPath = path.join(directory, 'upload.tmp');
  await fs.writeFile(tempPath, '12345');

  await assert.rejects(store.create(tempPath, {
    filename: 'too-large.txt',
    mimeType: 'text/plain'
  }), (error) => error.code === 'FILE_TOO_LARGE' && error.statusCode === 413);

  await fs.writeFile(tempPath, '1234');
  await assert.rejects(store.create(tempPath, {
    filename: '../secret.txt',
    mimeType: 'text/plain'
  }), (error) => error.code === 'INVALID_FILE_NAME' && error.statusCode === 400);

  await assert.rejects(store.create(tempPath, {
    filename: 'normal.txt',
    mimeType: 'text/plain',
    expiresInSeconds: 30
  }), (error) => error.code === 'INVALID_FILE_EXPIRY' && error.statusCode === 400);
});
