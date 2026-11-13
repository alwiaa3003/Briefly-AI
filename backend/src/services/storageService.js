'use strict';

/**
 * S3-compatible object storage (Cloudflare R2, AWS S3, MinIO, ...).
 *
 * - Objects are private. Nothing is ever made public; access is only via
 *   short-lived presigned GET URLs generated for the owner (playback) or for
 *   the processing service (transcription).
 * - Uploads are streamed with multipart upload, so memory use stays at
 *   about partSize x queueSize regardless of file size.
 * - Credentials come only from configuration and never leave this module.
 */

const { S3Client, DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 2;

let client = null;

function isStorageConfigured() {
  const { endpoint, bucket, accessKeyId, secretAccessKey } = config.storage;
  return Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
}

function storageNotConfiguredError() {
  return ApiError.serviceUnavailable(
    'Video uploads are not available: object storage has not been configured on the server. ' +
      'An administrator must set STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and ' +
      'STORAGE_SECRET_ACCESS_KEY (see README, "Video uploads").',
    'STORAGE_NOT_CONFIGURED'
  );
}

function getClient() {
  if (!isStorageConfigured()) throw storageNotConfiguredError();
  if (!client) {
    client = new S3Client({
      endpoint: config.storage.endpoint,
      region: config.storage.region,
      forcePathStyle: config.storage.forcePathStyle,
      credentials: {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
      },
    });
  }
  return client;
}

/**
 * Streams `body` to storage. Returns { promise, abort }.
 * The object is private; ContentDisposition=attachment prevents rendering if it is ever opened directly.
 */
function uploadStream({ key, body, contentType }) {
  const upload = new Upload({
    client: getClient(),
    params: {
      Bucket: config.storage.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentDisposition: 'attachment',
    },
    partSize: PART_SIZE,
    queueSize: QUEUE_SIZE,
    leavePartsOnError: false,
  });
  return { promise: upload.done(), abort: () => upload.abort().catch(() => {}) };
}

/** RFC 6266 Content-Disposition with a safe ASCII fallback and a UTF-8 filename*. */
function contentDisposition(type, filename) {
  if (!filename) return type;
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Short-lived presigned GET URL. `inline` lets a <video> element or the browser's PDF viewer display it. */
async function getSignedDownloadUrl(
  key,
  { ttlSeconds = config.storage.signedUrlTtlSeconds, contentType, inline = false, filename } = {}
) {
  const command = new GetObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
    ...(contentType && { ResponseContentType: contentType }),
    ResponseContentDisposition: contentDisposition(inline ? 'inline' : 'attachment', filename),
  });
  const url = await getSignedUrl(getClient(), command, { expiresIn: ttlSeconds });
  return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
}

/**
 * Deletes an object permanently.
 *
 * On buckets that keep file versions (Backblaze B2's default "keep all versions",
 * versioned S3 buckets) a plain DeleteObject only adds a delete marker and the
 * data stays stored. Every remaining version and delete marker of exactly this
 * key is therefore removed too. Providers without versioning support (e.g. R2,
 * unversioned S3) answer the version listing with an error or nothing, which is fine.
 */
async function deleteObject(key) {
  const client = getClient();
  const bucket = config.storage.bucket;
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  let listing;
  try {
    listing = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
  } catch (error) {
    logger.debug('Version listing unavailable; plain delete only', { code: error.name });
    return;
  }
  const versions = [...(listing.Versions || []), ...(listing.DeleteMarkers || [])].filter((v) => v.Key === key && v.VersionId);
  for (const version of versions) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: version.VersionId }));
  }
}

module.exports = { contentDisposition, isStorageConfigured, storageNotConfiguredError, uploadStream, getSignedDownloadUrl, deleteObject };
