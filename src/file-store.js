'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { ROOT_DIR, uuid } = require('./config');

const DEFAULT_DIRECTORY = path.join(ROOT_DIR, '.byv-files');
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_TOTAL_STORAGE_BYTES = 1024 * 1024 * 1024 * 1024;
const MIN_EXPIRY_SECONDS = 60 * 60;
const MAX_EXPIRY_SECONDS = 90 * 24 * 60 * 60;
const FILE_ID_PATTERN = /^file_[a-f0-9]{24}$/i;
const INVALID_FILENAME = /[<>:"|?*\\/\u0000-\u001f]/;

function validateFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim() ||
      filename.length > 255 || INVALID_FILENAME.test(filename)) {
    throw Object.assign(new Error('File name must be 1–255 characters and cannot contain path separators or reserved characters.'), {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'INVALID_FILE_NAME'
    });
  }
  return filename;
}

function normalizeMimeType(value) {
  const mime = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
  if (!mime || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) {
    return 'application/octet-stream';
  }
  return mime;
}

class LocalFileStore {
  constructor(options = {}) {
    this.directory = path.resolve(options.directory || DEFAULT_DIRECTORY);
    this.maxFileBytes = Number.isSafeInteger(options.maxFileBytes) && options.maxFileBytes > 0
      ? options.maxFileBytes
      : MAX_FILE_BYTES;
    this.maxTotalStorageBytes = Number.isSafeInteger(options.maxTotalStorageBytes) && options.maxTotalStorageBytes > 0
      ? options.maxTotalStorageBytes
      : MAX_TOTAL_STORAGE_BYTES;
  }

  async ensureDirectory() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  metadataPath(id) {
    return path.join(this.directory, id + '.json');
  }

  contentPath(id) {
    return path.join(this.directory, id + '.bin');
  }

  async listMetadata() {
    await this.ensureDirectory();
    const names = await fs.readdir(this.directory);
    const rows = await Promise.all(names
      .filter((name) => /^file_[a-f0-9]{24}\.json$/i.test(name))
      .map(async (name) => {
        try {
          return JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
        } catch {
          return null;
        }
      }));
    return rows.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async create(tempPath, options = {}) {
    await this.ensureDirectory();
    const filename = validateFilename(options.filename);
    const mimeType = normalizeMimeType(options.mimeType);
    const stat = await fs.stat(tempPath);
    if (!stat.isFile() || stat.size > this.maxFileBytes) {
      throw Object.assign(new Error('File exceeds the 500 MB Files API limit.'), {
        statusCode: 413,
        type: 'invalid_request_error',
        code: 'FILE_TOO_LARGE'
      });
    }

    const expiry = options.expiresInSeconds;
    if (expiry !== undefined && expiry !== null &&
        (!Number.isInteger(expiry) || expiry < MIN_EXPIRY_SECONDS || expiry > MAX_EXPIRY_SECONDS)) {
      throw Object.assign(new Error('expires_in_seconds must be between 3600 and 7776000.'), {
        statusCode: 400,
        type: 'invalid_request_error',
        code: 'INVALID_FILE_EXPIRY'
      });
    }

    const existing = await this.listMetadata();
    const total = existing.reduce((sum, item) => sum + (Number(item.size_bytes) || 0), 0);
    if (total + stat.size > this.maxTotalStorageBytes) {
      throw Object.assign(new Error('The local Files API storage limit has been reached.'), {
        statusCode: 400,
        type: 'invalid_request_error',
        code: 'FILE_STORAGE_LIMIT_EXCEEDED'
      });
    }

    const id = uuid('file');
    const createdAt = new Date();
    const expiresAt = expiry ? new Date(createdAt.getTime() + expiry * 1000).toISOString() : null;
    const metadata = {
      id,
      type: 'file',
      filename,
      mime_type: mimeType,
      size_bytes: stat.size,
      created_at: createdAt.toISOString(),
      downloadable: false,
      expires_at: expiresAt
    };

    const target = this.contentPath(id);
    try {
      await fs.rename(tempPath, target);
      await fs.writeFile(this.metadataPath(id), JSON.stringify(metadata), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      await fs.rm(target, { force: true }).catch(() => {});
      throw error;
    }
    return metadata;
  }

  async getMetadata(id) {
    if (typeof id !== 'string' || !FILE_ID_PATTERN.test(id)) return null;
    await this.ensureDirectory();
    try {
      const metadata = JSON.parse(await fs.readFile(this.metadataPath(id), 'utf8'));
      if (metadata.expires_at && Date.parse(metadata.expires_at) <= Date.now()) {
        await this.delete(id);
        return null;
      }
      return metadata;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async read(id) {
    const metadata = await this.getMetadata(id);
    if (!metadata) return null;
    const content = await fs.readFile(this.contentPath(id));
    return { metadata, content };
  }

  async delete(id) {
    if (typeof id !== 'string' || !FILE_ID_PATTERN.test(id)) return false;
    await this.ensureDirectory();
    let existed = false;
    try {
      await fs.unlink(this.metadataPath(id));
      existed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.unlink(this.contentPath(id));
      existed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return existed;
  }

  async list(options = {}) {
    const all = await this.listMetadata();
    const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(1000, options.limit)) : 20;
    const cursor = typeof options.page === 'string' ? options.page : '';
    const start = cursor ? Math.max(0, all.findIndex((item) => item.id === cursor) + 1) : 0;
    const data = all.slice(start, start + limit);
    const hasMore = start + data.length < all.length;
    return {
      data,
      next_page: hasMore && data.length ? data[data.length - 1].id : null
    };
  }
}

function createFileStore(options) {
  return new LocalFileStore(options);
}

module.exports = {
  LocalFileStore,
  createFileStore,
  validateFilename,
  normalizeMimeType,
  FILE_ID_PATTERN,
  MAX_FILE_BYTES,
  MAX_TOTAL_STORAGE_BYTES,
  MIN_EXPIRY_SECONDS,
  MAX_EXPIRY_SECONDS
};
