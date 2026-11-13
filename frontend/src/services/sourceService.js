import { apiClient } from './apiClient';

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
 * POST /api/videos/uploads (multipart). The browser streams the file; progress
 * is reported as a fraction 0..1. Pass an AbortSignal to cancel.
 */
export async function uploadVideo(file, { onProgress, signal } = {}) {
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

/** POST /api/documents/uploads (multipart). Progress is reported as a fraction 0..1. */
export async function uploadDocument(file, { onProgress, signal } = {}) {
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
