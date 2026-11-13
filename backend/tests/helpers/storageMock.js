'use strict';

/**
 * In-memory stand-in for src/services/storageService.js. It really consumes
 * the upload stream, so signature/size checks run against streaming behaviour.
 *
 *   jest.mock('../src/services/storageService', () => require('./helpers/storageMock'));
 */
const ApiError = require('../../src/utils/ApiError');

const state = { configured: true, objects: new Map(), deleted: [], aborted: 0, failDelete: false, signed: [] };

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
  async deleteObject(key) {
    if (state.failDelete) throw new Error('storage unavailable');
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
  },
};
