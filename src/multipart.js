'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { uuid } = require('./config');

const MIME_BY_EXTENSION = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/plain',
  '.tsv': 'text/plain',
  '.md': 'text/plain',
  '.markdown': 'text/plain',
  '.json': 'text/plain',
  '.html': 'text/plain',
  '.htm': 'text/plain',
  '.xml': 'text/plain',
  '.log': 'text/plain',
  '.js': 'text/plain',
  '.ts': 'text/plain',
  '.py': 'text/plain',
  '.sql': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function parseDisposition(value) {
  const name = /(?:^|;)\s*name="((?:\\.|[^"])*)"/i.exec(value || '');
  const filename = /(?:^|;)\s*filename="((?:\\.|[^"])*)"/i.exec(value || '');
  const decode = (match) => match ? match[1].replace(/\\(.)/g, '$1') : null;
  return { name: decode(name), filename: decode(filename) };
}

function parseHeaders(raw) {
  const headers = {};
  for (const line of raw.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

async function readMultipartFile(req, options = {}) {
  const maxFileBytes = Number.isSafeInteger(options.maxFileBytes) && options.maxFileBytes > 0
    ? options.maxFileBytes
    : 500 * 1024 * 1024;
  const tempDirectory = path.resolve(options.tempDirectory || path.join(process.cwd(), '.byv-files'));
  const contentType = String(req.headers && req.headers['content-type'] || '');
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !boundaryMatch) {
    throw Object.assign(new Error('Files API uploads must use multipart/form-data with a boundary.'), {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'INVALID_MULTIPART_BODY'
    });
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  if (boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw Object.assign(new Error('Invalid multipart boundary.'), {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'INVALID_MULTIPART_BOUNDARY'
    });
  }

  const initialBoundary = Buffer.from('--' + boundary + '\r\n');
  const partBoundary = Buffer.from('\r\n--' + boundary);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const maxBodyBytes = maxFileBytes + 1024 * 1024;
  const contentLength = Number(req.headers && req.headers['content-length']);
  if (Number.isSafeInteger(contentLength) && contentLength > maxBodyBytes) {
    req.destroy();
    throw Object.assign(new Error('File upload exceeds the 500 MB Files API limit.'), {
      statusCode: 413,
      type: 'invalid_request_error',
      code: 'FILE_TOO_LARGE'
    });
  }

  await fs.mkdir(tempDirectory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(tempDirectory, uuid('upload') + '.tmp');
  let fileHandle = null;
  let fileBytes = 0;
  let totalBytes = 0;
  let tempCreated = false;
  let buffer = Buffer.alloc(0);
  let state = 'start';
  let currentPart = null;
  let fileMeta = null;
  let expiresInSeconds;
  let textFieldBytes = 0;
  let parts = 0;

  async function writePart(chunk) {
    if (!chunk.length) return;
    if (currentPart.filename !== null) {
      fileBytes += chunk.length;
      if (fileBytes > maxFileBytes) {
        throw Object.assign(new Error('File upload exceeds the 500 MB Files API limit.'), {
          statusCode: 413,
          type: 'invalid_request_error',
          code: 'FILE_TOO_LARGE'
        });
      }
      let written = 0;
      while (written < chunk.length) {
        const result = await fileHandle.write(chunk, written, chunk.length - written, null);
        if (!result.bytesWritten) throw new Error('Could not write uploaded file data.');
        written += result.bytesWritten;
      }
    } else {
      textFieldBytes += chunk.length;
      if (textFieldBytes > 4096) {
        throw Object.assign(new Error('Multipart metadata fields are too large.'), {
          statusCode: 400,
          type: 'invalid_request_error',
          code: 'MULTIPART_FIELD_TOO_LARGE'
        });
      }
      currentPart.data = Buffer.concat([currentPart.data, chunk]);
    }
  }

  async function finishPart() {
    if (!currentPart) return;
    if (currentPart.filename !== null) {
      await fileHandle.close();
      fileHandle = null;
      if (currentPart.name !== 'file' || fileMeta) {
        throw Object.assign(new Error('Files API upload requires exactly one file field named file.'), {
          statusCode: 400,
          type: 'invalid_request_error',
          code: 'INVALID_FILE_FIELD'
        });
      }
      fileMeta = {
        tempPath,
        filename: currentPart.filename,
        mimeType: (() => {
          const extensionType = MIME_BY_EXTENSION[path.extname(currentPart.filename).toLowerCase()];
          const suppliedType = String(currentPart.mimeType || '').split(';', 1)[0].trim().toLowerCase();
          if (extensionType === 'text/plain' &&
              (!suppliedType || suppliedType === 'application/octet-stream' ||
               suppliedType.startsWith('text/') || suppliedType === 'application/json' ||
               suppliedType === 'application/javascript')) return 'text/plain';
          if (extensionType && (!suppliedType || suppliedType === 'application/octet-stream')) return extensionType;
          return suppliedType || extensionType || 'application/octet-stream';
        })(),
        sizeBytes: fileBytes
      };
    } else if (currentPart.name === 'expires_in_seconds') {
      const value = currentPart.data.toString('utf8').trim();
      if (value) expiresInSeconds = Number(value);
    }
    currentPart = null;
  }

  try {
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        throw Object.assign(new Error('File upload exceeds the 500 MB Files API limit.'), {
          statusCode: 413,
          type: 'invalid_request_error',
          code: 'FILE_TOO_LARGE'
        });
      }
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

      let progressed = true;
      while (progressed) {
        progressed = false;
        if (state === 'start') {
          if (buffer.length < initialBoundary.length) continue;
          if (!buffer.subarray(0, initialBoundary.length).equals(initialBoundary)) {
            throw Object.assign(new Error('Malformed multipart body: opening boundary is missing.'), {
              statusCode: 400,
              type: 'invalid_request_error',
              code: 'INVALID_MULTIPART_BODY'
            });
          }
          buffer = buffer.subarray(initialBoundary.length);
          state = 'headers';
          progressed = true;
        } else if (state === 'headers') {
          const separatorIndex = buffer.indexOf(headerSeparator);
          if (separatorIndex < 0) {
            if (buffer.length > 16384) {
              throw Object.assign(new Error('Multipart part headers are too large.'), {
                statusCode: 400,
                type: 'invalid_request_error',
                code: 'MULTIPART_HEADERS_TOO_LARGE'
              });
            }
            continue;
          }
          const headers = parseHeaders(buffer.subarray(0, separatorIndex).toString('utf8'));
          const disposition = parseDisposition(headers['content-disposition']);
          if (!disposition.name) {
            throw Object.assign(new Error('Multipart parts must include a field name.'), {
              statusCode: 400,
              type: 'invalid_request_error',
              code: 'INVALID_MULTIPART_BODY'
            });
          }
          parts++;
          if (parts > 8) {
            throw Object.assign(new Error('Too many multipart fields.'), {
              statusCode: 400,
              type: 'invalid_request_error',
              code: 'TOO_MANY_MULTIPART_FIELDS'
            });
          }
          currentPart = {
            name: disposition.name,
            filename: disposition.filename,
            mimeType: headers['content-type'] || null,
            data: Buffer.alloc(0)
          };
          if (currentPart.filename !== null) {
            if (currentPart.name !== 'file' || fileMeta || fileHandle) {
              throw Object.assign(new Error('Files API upload requires exactly one file field named file.'), {
                statusCode: 400,
                type: 'invalid_request_error',
                code: 'INVALID_FILE_FIELD'
              });
            }
            fileHandle = await fs.open(tempPath, 'wx', 0o600);
            tempCreated = true;
          }
          buffer = buffer.subarray(separatorIndex + headerSeparator.length);
          state = 'body';
          progressed = true;
        } else if (state === 'body') {
          const boundaryIndex = buffer.indexOf(partBoundary);
          if (boundaryIndex >= 0) {
            await writePart(buffer.subarray(0, boundaryIndex));
            await finishPart();
            buffer = buffer.subarray(boundaryIndex + partBoundary.length);
            state = 'after-boundary';
            progressed = true;
          } else {
            const safeLength = buffer.length - partBoundary.length - 4;
            if (safeLength > 0) {
              await writePart(buffer.subarray(0, safeLength));
              buffer = buffer.subarray(safeLength);
            }
          }
        } else if (state === 'after-boundary') {
          if (buffer.length < 2) continue;
          if (buffer.subarray(0, 2).toString('ascii') === '--') {
            buffer = buffer.subarray(2);
            state = 'done';
            progressed = true;
          } else if (buffer.subarray(0, 2).toString('ascii') === '\r\n') {
            buffer = buffer.subarray(2);
            state = 'headers';
            progressed = true;
          } else {
            throw Object.assign(new Error('Malformed multipart boundary terminator.'), {
              statusCode: 400,
              type: 'invalid_request_error',
              code: 'INVALID_MULTIPART_BODY'
            });
          }
        }
      }
      // Drain any epilogue bytes after the closing boundary before returning.
    }

    if (fileHandle) {
      await fileHandle.close();
      fileHandle = null;
    }
    if (state !== 'done' || !fileMeta) {
      throw Object.assign(new Error('Multipart body did not contain a complete file upload.'), {
        statusCode: 400,
        type: 'invalid_request_error',
        code: 'INCOMPLETE_FILE_UPLOAD'
      });
    }
    if (expiresInSeconds !== undefined && (!Number.isInteger(expiresInSeconds) ||
        expiresInSeconds < 3600 || expiresInSeconds > 7776000)) {
      throw Object.assign(new Error('expires_in_seconds must be between 3600 and 7776000.'), {
        statusCode: 400,
        type: 'invalid_request_error',
        code: 'INVALID_FILE_EXPIRY'
      });
    }
    return { ...fileMeta, expiresInSeconds };
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {});
    if (tempCreated) await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { readMultipartFile, MIME_BY_EXTENSION, parseDisposition };
