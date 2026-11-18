import axios from 'axios';
import { apiClient } from './apiClient';

/*
 * Direct uploads: the file goes from the browser straight to object storage with a short-lived
 * presigned URL from the API, then the API verifies it. File bytes never pass through the API.
 *
 * The storage request uses a separate axios instance: no API base URL, no cookies and no
 * Authorization header ever go to the storage host.
 */
const storageClient = axios.create({ withCredentials: false, timeout: 0 });

function storageError(error, message) {
  return Object.assign(error, { userMessage: message });
}

/** Storage answered 403: the presigned URL expired (or was otherwise refused). */
function isRefusedByStorage(error) {
  return error?.response?.status === 403;
}

function putFile(target, file, { onProgress, signal }) {
  return storageClient.put(target.url, file, {
    headers: target.headers,
    signal,
    // Send the File as is (no JSON transform); the browser sets Content-Length from it.
    transformRequest: [(data) => data],
    onUploadProgress: (event) => {
      if (onProgress && event.total) onProgress(Math.min(1, event.loaded / event.total));
    },
  });
}

/**
 * start (API) -> PUT (storage) -> complete (API). Resolves like the old multipart upload:
 * { source, job, duplicate }. An expired URL is renewed once; a cancelled or failed transfer
 * releases the reservation so nothing is left behind.
 */
async function uploadDirect(base, file, { onProgress, signal } = {}) {
  const start = () =>
    apiClient
      .post(`${base}/uploads/direct`, { fileName: file.name, sizeBytes: file.size, mimeType: file.type || '' }, { signal })
      .then((response) => response.data.data);
  const release = (id) => apiClient.delete(`${base}/uploads/direct/${encodeURIComponent(id)}`).catch(() => {});

  let started = await start();
  try {
    try {
      await putFile(started.upload, file, { onProgress, signal });
    } catch (error) {
      if (signal?.aborted || !isRefusedByStorage(error)) throw error;
      // The link expired (for example the tab waited too long): get a fresh one, once.
      await release(started.uploadId);
      started = await start();
      await putFile(started.upload, file, { onProgress, signal });
    }
  } catch (error) {
    await release(started.uploadId);
    if (signal?.aborted || axios.isCancel(error)) throw error;
    throw storageError(
      error,
      isRefusedByStorage(error)
        ? 'The upload link was refused or has expired. Please try again.'
        : 'The file could not be sent to storage. Check your connection and try again.'
    );
  }

  // The API re-reads the file to verify it (type, size, fingerprint); large files take a moment.
  const response = await apiClient.post(`${base}/uploads/direct/${encodeURIComponent(started.uploadId)}/complete`, null, {
    signal,
    timeout: 0,
  });
  return response.data.data;
}

/** POST /api/articles — resolves with { source, job, duplicate }. */
export async function submitArticle(url) {
  const response = await apiClient.post('/articles', { url });
  return response.data.data;
}

/** GET /api/sources — resolves with { items, page, limit, total, totalPages }. */
export async function listSources({ search, kind, status, page, limit } = {}) {
  const params = {};
  if (search) params.search = search;
  if (kind) params.kind = kind;
  if (status) params.status = status;
  if (page) params.page = page;
  if (limit) params.limit = limit;
  const response = await apiClient.get('/sources', { params });
  return response.data.data;
}

/** GET /api/sources/stats — resolves with { total, completed, processing, failed }. */
export async function getSourceStats() {
  const response = await apiClient.get('/sources/stats');
  return response.data.data.stats;
}

/** GET /api/sources/:id — source with metadata, summary and job status. */
export async function getSource(id) {
  const response = await apiClient.get(`/sources/${encodeURIComponent(id)}`);
  return response.data.data.source;
}

/** POST /api/sources/:id/retry — re-queues a failed summary. */
export async function retrySource(id) {
  const response = await apiClient.post(`/sources/${encodeURIComponent(id)}/retry`);
  return response.data.data;
}

/* ------------------------------ Videos ------------------------------ */

/** POST /api/videos/youtube — resolves with { source, job, duplicate }. */
export async function submitYouTube(url) {
  const response = await apiClient.post('/videos/youtube', { url });
  return response.data.data;
}

/** GET /api/videos/uploads/config — { enabled, maxBytes, maxDurationMinutes, retentionDays, ... } */
export async function getUploadConfig() {
  const response = await apiClient.get('/videos/uploads/config');
  return response.data.data.uploads;
}

/**
 * Uploads a video: directly to object storage when the server offers it (uploadMethod 'direct'),
 * otherwise through the API (multipart). Progress is a fraction 0..1; pass an AbortSignal to cancel.
 */
export async function uploadVideo(file, { onProgress, signal, method = 'direct' } = {}) {
  if (method === 'direct') return uploadDirect('/videos', file, { onProgress, signal });
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await apiClient.post('/videos/uploads', form, {
    signal,
    timeout: 0, // large files can take a while; the user can cancel
    onUploadProgress: (event) => {
      if (onProgress && event.total) onProgress(Math.min(1, event.loaded / event.total));
    },
  });
  return response.data.data;
}

/** GET /api/sources/:id/transcript */
export async function getTranscript(id) {
  const response = await apiClient.get(`/sources/${encodeURIComponent(id)}/transcript`);
  return response.data.data.transcript;
}

/** GET /api/sources/:id/playback — short-lived signed URL for an uploaded video. */
export async function getPlayback(id) {
  const response = await apiClient.get(`/sources/${encodeURIComponent(id)}/playback`);
  return response.data.data.playback;
}

/* ----------------------------- Documents ----------------------------- */

/** GET /api/documents/uploads/config */
export async function getDocumentUploadConfig() {
  const response = await apiClient.get('/documents/uploads/config');
  return response.data.data.uploads;
}

/** Uploads a document (PDF, DOCX, TXT): directly to storage, or multipart through the API. */
export async function uploadDocument(file, { onProgress, signal, method = 'direct' } = {}) {
  if (method === 'direct') return uploadDirect('/documents', file, { onProgress, signal });
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await apiClient.post('/documents/uploads', form, {
    signal,
    timeout: 0,
    onUploadProgress: (event) => {
      if (onProgress && event.total) onProgress(Math.min(1, event.loaded / event.total));
    },
  });
  return response.data.data;
}

/** GET /api/sources/:id/original — signed URL for the original file (inline for PDFs unless download). */
export async function getOriginal(id, { download = false } = {}) {
  const response = await apiClient.get(`/sources/${encodeURIComponent(id)}/original`, {
    params: download ? { download: '1' } : undefined,
  });
  return response.data.data.original;
}

/** GET /api/sources/:id/document-text — extracted text with page / section references. */
export async function getDocumentText(id, { page = 1, limit = 50 } = {}) {
  const response = await apiClient.get(`/sources/${encodeURIComponent(id)}/document-text`, { params: { page, limit } });
  return response.data.data;
}
