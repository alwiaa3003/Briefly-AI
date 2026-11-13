'use strict';

/** storageService.deleteObject removes every version (versioned buckets such as Backblaze B2). S3 calls are mocked. */

function loadStorage() {
  const env = {
    STORAGE_ENDPOINT: 'https://s3.example-region.example.com',
    STORAGE_REGION: 'example-region',
    STORAGE_BUCKET: 'unit-bucket',
    STORAGE_ACCESS_KEY_ID: 'unit-access-key',
    STORAGE_SECRET_ACCESS_KEY: 'unit-secret-key-not-real',
    STORAGE_FORCE_PATH_STYLE: 'true',
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  let modules;
  jest.isolateModules(() => {
    const sdk = require('@aws-sdk/client-s3');
    const send = jest.spyOn(sdk.S3Client.prototype, 'send');
    modules = { storage: require('../src/services/storageService'), sdk, send };
  });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return modules;
}

afterEach(() => jest.restoreAllMocks());

test('deletes the object, then every remaining version and delete marker of exactly that key', async () => {
  const { storage, sdk, send } = loadStorage();
  send.mockImplementation(async (command) => {
    if (command instanceof sdk.ListObjectVersionsCommand) {
      return {
        Versions: [
          { Key: 'documents/u1/abc', VersionId: 'v1' },
          { Key: 'documents/u1/abc-other', VersionId: 'v9' },
        ],
        DeleteMarkers: [{ Key: 'documents/u1/abc', VersionId: 'm1' }],
      };
    }
    return {};
  });
  await storage.deleteObject('documents/u1/abc');
  const deletes = send.mock.calls.map(([c]) => c).filter((c) => c instanceof sdk.DeleteObjectCommand).map((c) => c.input);
  expect(deletes).toEqual([
    { Bucket: 'unit-bucket', Key: 'documents/u1/abc' },
    { Bucket: 'unit-bucket', Key: 'documents/u1/abc', VersionId: 'v1' },
    { Bucket: 'unit-bucket', Key: 'documents/u1/abc', VersionId: 'm1' },
  ]);
  const listing = send.mock.calls.map(([c]) => c).find((c) => c instanceof sdk.ListObjectVersionsCommand);
  expect(listing.input).toEqual({ Bucket: 'unit-bucket', Prefix: 'documents/u1/abc' });
});

test('providers without version listing still get a plain delete', async () => {
  const { storage, sdk, send } = loadStorage();
  send.mockImplementation(async (command) => {
    if (command instanceof sdk.ListObjectVersionsCommand) throw Object.assign(new Error('not implemented'), { name: 'NotImplemented' });
    return {};
  });
  await expect(storage.deleteObject('videos/u1/x')).resolves.toBeUndefined();
  expect(send.mock.calls.filter(([c]) => c instanceof sdk.DeleteObjectCommand)).toHaveLength(1);
});

test('a failing primary delete is reported (so callers can retry)', async () => {
  const { storage, send } = loadStorage();
  send.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
  await expect(storage.deleteObject('videos/u1/x')).rejects.toThrow('denied');
});
