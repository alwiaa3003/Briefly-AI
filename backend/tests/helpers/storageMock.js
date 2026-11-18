'use strict';

/**
 * In-memory stand-in for src/services/storageService.js. It really consumes
 * the upload stream, so signature/size checks run against streaming behaviour.
 *
 *   jest.mock('../src/services/storageService', () => require('./helpers/storageMock'));
 */
const { Readable } = require('stream');
const ApiError = require('../../src/utils/ApiError');

const state = {
  configured: true,
  objects: new Map(),
  deleted: [],
  aborted: 0,
  failDelete: false,
  signed: [],
  presigned: [],
  reads: [],
  failHead: false,
  // Direct-upload copy step
  copies: [],
  failCopy: false,
  copyTransform: null, // (data) => data written to the destination (simulates a bad copy)
  failDeleteKeys: new Set(),
  failHeadKeys: new Set(),
  failReadKeys: new Set(),
};

module.exports = {
  isStorageConfigured: () => state.configured,
  storageNotConfiguredError: () =>
    ApiError.serviceUnavailable('Video uploads are not available: object storage has not been configured.', 'STORAGE_NOT_CONFIGURED'),
  uploadStream({ key, body, contentType }) {
    let aborted = false;
    const promise = (async () => {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      if (aborted) throw new Error('aborted');
      state.objects.set(key, { data: Buffer.concat(chunks), contentType });
    })();
    return {
      promise,
      abort: () => {
        aborted = true;
        state.aborted += 1;
      },
    };
  },
  async getSignedDownloadUrl(key, options = {}) {
    state.signed.push({ key, ...options });
    return {
      url: `https://acct.r2.cloudflarestorage.com/bucket/${key}?X-Amz-Signature=test${state.signed.length}`,
      expiresAt: new Date(Date.now() + (options.ttlSeconds || 900) * 1000),
    };
  },
  /* Direct uploads: presigned PUT, then the server reads the object back. */
  async getSignedUploadUrl(key, { contentType, contentLength, ttlSeconds = 900 }) {
    state.presigned.push({ key, contentType, contentLength, ttlSeconds });
    return {
      url: `https://s3.example-storage.test/bucket/${key}?X-Amz-SignedHeaders=content-disposition%3Bcontent-length%3Bcontent-type%3Bhost&X-Amz-Signature=up${state.presigned.length}`,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Disposition': 'attachment' },
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  },
  async headObject(key) {
    if (state.failHead || state.failHeadKeys.has(key)) throw Object.assign(new Error('storage unavailable'), { name: 'ServiceUnavailable' });
    const object = state.objects.get(key);
    return object ? { sizeBytes: object.data.length, contentType: object.contentType } : null;
  },
  async getObjectStream(key) {
    state.reads.push(key);
    if (state.failReadKeys.has(key)) throw Object.assign(new Error('read failed'), { name: 'ServiceUnavailable' });
    const object = state.objects.get(key);
    if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    return Readable.from([object.data]);
  },
  async copyObject(sourceKey, destinationKey) {
    if (state.failCopy) throw Object.assign(new Error('copy failed'), { name: 'InternalError' });
    const object = state.objects.get(sourceKey);
    if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    const data = state.copyTransform ? state.copyTransform(object.data) : Buffer.from(object.data);
    state.objects.set(destinationKey, { data, contentType: object.contentType });
    state.copies.push({ from: sourceKey, to: destinationKey });
  },
  /** Simulates the browser PUT to a presigned URL. */
  __put(key, data, contentType = 'application/octet-stream') {
    state.objects.set(key, { data, contentType });
  },
  async deleteObject(key) {
    if (state.failDelete || state.failDeleteKeys.has(key)) throw new Error('storage unavailable');
    state.deleted.push(key);
    state.objects.delete(key);
  },
  __state: state,
  __reset() {
    state.configured = true;
    state.objects.clear();
    state.deleted.length = 0;
    state.signed.length = 0;
    state.aborted = 0;
    state.failDelete = false;
    state.presigned.length = 0;
    state.reads.length = 0;
    state.failHead = false;
    state.copies.length = 0;
    state.failCopy = false;
    state.copyTransform = null;
    state.failDeleteKeys.clear();
    state.failHeadKeys.clear();
    state.failReadKeys.clear();
  },
};
