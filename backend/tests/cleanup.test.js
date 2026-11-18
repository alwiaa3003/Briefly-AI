'use strict';

jest.mock('../src/services/storageService', () => require('./helpers/storageMock'));

const mongoose = require('mongoose');
const storageMock = require('./helpers/storageMock');
const Upload = require('../src/models/Upload');
const { cleanupExpiredUploads } = require('../src/services/cleanupService');
const { runMaintenanceJob } = require('../src/workers/maintenanceWorker');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

beforeAll(startTestDatabase);
beforeEach(() => storageMock.__reset());
afterEach(clearTestDatabase);
afterAll(stopTestDatabase);

let n = 0;
function makeUpload(expiresInMs, status = 'stored') {
  n += 1;
  return Upload.create({
    user: new mongoose.Types.ObjectId(),
    storageKey: `videos/u/${n}`,
    originalName: `v${n}.mp4`,
    mimeType: 'video/mp4',
    container: 'mp4',
    sizeBytes: 100,
    sha256: String(n).padStart(64, '0'),
    status,
    expiresAt: new Date(Date.now() + expiresInMs),
  });
}

test('deletes expired files from storage and marks them deleted; keeps current ones', async () => {
  const expired = await makeUpload(-60_000);
  const current = await makeUpload(3_600_000);
  const alreadyDeleted = await makeUpload(-60_000, 'deleted');

  const result = await cleanupExpiredUploads();

  expect(result).toEqual({ deleted: 1, failed: 0, purged: 0, skipped: false });
  expect(storageMock.__state.deleted).toEqual([expired.storageKey]);
  expect((await Upload.findById(expired.id)).status).toBe('deleted');
  expect((await Upload.findById(expired.id)).deletedAt).toBeInstanceOf(Date);
  expect((await Upload.findById(current.id)).status).toBe('stored');
  expect((await Upload.findById(alreadyDeleted.id)).deletedAt).toBeNull();
});

test('storage failures leave the record for the next run', async () => {
  const expired = await makeUpload(-60_000);
  storageMock.__state.failDelete = true;

  expect(await cleanupExpiredUploads()).toEqual({ deleted: 0, failed: 1, purged: 0, skipped: false });
  expect((await Upload.findById(expired.id)).status).toBe('stored');

  storageMock.__state.failDelete = false;
  expect((await cleanupExpiredUploads()).deleted).toBe(1);
});

test('does nothing when storage is not configured', async () => {
  await makeUpload(-60_000);
  storageMock.__state.configured = false;
  expect(await cleanupExpiredUploads()).toEqual({ deleted: 0, failed: 0, purged: 0, skipped: true });
});

test('processes in bounded batches', async () => {
  for (let i = 0; i < 5; i += 1) await makeUpload(-60_000 - i);
  expect((await cleanupExpiredUploads({ batchSize: 2 })).deleted).toBe(2);
  expect(await Upload.countDocuments({ status: 'stored' })).toBe(3);
});

test('the maintenance worker routes cleanup jobs', async () => {
  await makeUpload(-60_000);
  expect(await runMaintenanceJob({ name: 'cleanup_uploads' })).toMatchObject({ deleted: 1 });
  expect(await runMaintenanceJob({ name: 'something_else' })).toBeNull();
});
