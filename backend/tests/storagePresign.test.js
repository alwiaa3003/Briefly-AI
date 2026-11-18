'use strict';

/**
 * The real storageService presigner (computed locally with fake credentials; no network).
 * A browser upload must not be able to change the key, size, type or disposition.
 */

let storage;

beforeAll(() => {
  Object.assign(process.env, {
    STORAGE_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
    STORAGE_REGION: 'us-east-005',
    STORAGE_BUCKET: 'test-bucket',
    STORAGE_ACCESS_KEY_ID: 'AKIDEXAMPLEKEYID0000',
    STORAGE_SECRET_ACCESS_KEY: 'example-secret-access-key-for-tests-only',
    STORAGE_FORCE_PATH_STYLE: 'true',
  });
  jest.isolateModules(() => {
    storage = require('../src/services/storageService');
  });
});

afterAll(() => {
  for (const key of ['STORAGE_ENDPOINT', 'STORAGE_REGION', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'STORAGE_FORCE_PATH_STYLE']) {
    delete process.env[key];
  }
});

test('the presigned PUT signs size, type and disposition, for exactly one key', async () => {
  const result = await storage.getSignedUploadUrl('documents/u1/3f2b8c1e-0000-4000-8000-000000000000', {
    contentType: 'application/pdf',
    contentLength: 12345,
    ttlSeconds: 600,
  });
  const url = new URL(result.url);
  expect(url.origin).toBe('https://s3.us-east-005.backblazeb2.com');
  expect(url.pathname).toBe('/test-bucket/documents/u1/3f2b8c1e-0000-4000-8000-000000000000');
  expect(url.searchParams.get('X-Amz-SignedHeaders').split(';').sort()).toEqual(['content-disposition', 'content-length', 'content-type', 'host']);
  expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
  expect(result).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment' } });
});

test('no checksum parameters a browser upload could never match, and no secret in the URL', async () => {
  const { url } = await storage.getSignedUploadUrl('videos/u1/key', { contentType: 'video/mp4', contentLength: 10 });
  expect(url).not.toMatch(/checksum/i);
  expect(url).not.toContain('example-secret-access-key-for-tests-only');
});
