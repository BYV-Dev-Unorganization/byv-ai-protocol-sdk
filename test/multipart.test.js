'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { readMultipartFile } = require('../src/multipart');

function requestFor(body, boundary, splitSize = 7) {
  const chunks = [];
  for (let offset = 0; offset < body.length; offset += splitSize) {
    chunks.push(body.subarray(offset, Math.min(body.length, offset + splitSize)));
  }
  const request = Readable.from(chunks);
  request.headers = {
    'content-type': 'multipart/form-data; boundary="' + boundary + '"',
    'content-length': String(body.length)
  };
  return request;
}

test('streams a multipart file upload to disk across split boundaries', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byv-multipart-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const boundary = 'byv-test-boundary-123';
  const data = Buffer.from('%PDF-1.7 test payload');
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="expires_in_seconds"\r\n\r\n3600\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="report.pdf"\r\n' +
      'Content-Type: application/pdf\r\n\r\n'),
    data,
    Buffer.from('\r\n--' + boundary + '--\r\n')
  ]);

  const upload = await readMultipartFile(requestFor(body, boundary), {
    tempDirectory: directory,
    maxFileBytes: 100
  });
  assert.equal(upload.filename, 'report.pdf');
  assert.equal(upload.mimeType, 'application/pdf');
  assert.equal(upload.sizeBytes, data.length);
  assert.equal(upload.expiresInSeconds, 3600);
  assert.deepEqual(await fs.readFile(upload.tempPath), data);
});

test('infers supported text file MIME types and rejects oversized uploads', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byv-multipart-limits-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const boundary = 'byv-small-boundary';
  const data = Buffer.from('a,b\n1,2');
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="sheet.csv"\r\n' +
      'Content-Type: text/csv\r\n\r\n'),
    data,
    Buffer.from('\r\n--' + boundary + '--\r\n')
  ]);
  const upload = await readMultipartFile(requestFor(body, boundary, 3), {
    tempDirectory: directory,
    maxFileBytes: 100
  });
  assert.equal(upload.mimeType, 'text/plain');
  await fs.rm(upload.tempPath, { force: true });

  await assert.rejects(
    readMultipartFile(requestFor(body, boundary, 3), { tempDirectory: directory, maxFileBytes: 2 }),
    (error) => error.code === 'FILE_TOO_LARGE' && error.statusCode === 413
  );
});

test('rejects multipart requests that omit the file field', async () => {
  const boundary = 'byv-no-file';
  const body = Buffer.from('--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="expires_in_seconds"\r\n\r\n3600\r\n' +
    '--' + boundary + '--\r\n');
  await assert.rejects(
    readMultipartFile(requestFor(body, boundary), { tempDirectory: os.tmpdir() }),
    (error) => error.code === 'INCOMPLETE_FILE_UPLOAD' && error.statusCode === 400
  );
});
