import axios from 'axios';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Direct uploads through the real sourceService and apiClient, with a fake HTTP adapter
 * (no network): what goes to the API, what goes to storage, and with which headers.
 */

const STORAGE_URL = 'https://s3.example-storage.test/bucket/documents/u1/key?X-Amz-Signature=abc';

function response(config, status, data) {
  const res = { data, status, statusText: String(status), headers: {}, config, request: {} };
  if (status >= 400) {
    const error = new axios.AxiosError(`Request failed with status ${status}`, 'ERR_BAD_RESPONSE', config, {}, res);
    return Promise.reject(error);
  }
  return Promise.resolve(res);
}

let calls;
let routes;
let sourceService;

async function load() {
  vi.resetModules();
  calls = [];
  axios.defaults.adapter = (config) => {
    const url = config.baseURL && !/^https?:/.test(config.url) ? `${config.baseURL}${config.url}` : config.url;
    calls.push({ method: config.method, url, headers: { ...config.headers }, withCredentials: config.withCredentials, data: config.data });
    if (config.onUploadProgress && config.method === 'put') config.onUploadProgress({ loaded: 50, total: 100 });
    for (const [match, handler] of routes) {
      if (match(config.method, url)) return handler(config);
    }
    return response(config, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
  };
  sourceService = await import('../services/sourceService');
}

const on = (method, test) => (m, url) => m === method && test(url);
const startOk = (overrides = {}) => [
  on('post', (u) => u === '/api/documents/uploads/direct'),
  (config) =>
    response(config, 201, {
      data: {
        uploadId: overrides.uploadId || '6650f0c2a1b2c3d4e5f60718',
        upload: { method: 'PUT', url: overrides.url || STORAGE_URL, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment' } },
      },
    }),
];
const putOk = [on('put', (u) => u.startsWith('https://s3.example-storage.test/')), (config) => response(config, 200, '')];
const completeOk = [
  on('post', (u) => /\/api\/documents\/uploads\/direct\/[a-f0-9]+\/complete$/.test(u)),
  (config) => response(config, 202, { data: { source: { id: 's1', kind: 'document' }, job: { id: 'j1' }, duplicate: false } }),
];
const cancelOk = [on('delete', (u) => u.startsWith('/api/documents/uploads/direct/')), (config) => response(config, 204, '')];

const file = () => new File(['%PDF-1.7 test'], 'Report.pdf', { type: 'application/pdf' });

beforeEach(() => {
  routes = [];
});

afterEach(() => {
  delete axios.defaults.adapter;
});

describe('direct uploads', () => {
  test('start -> PUT to storage -> complete; the file never goes to the API', async () => {
    routes = [startOk(), putOk, completeOk];
    await load();
    const progress = [];
    const result = await sourceService.uploadDocument(file(), { onProgress: (p) => progress.push(p) });

    expect(result).toMatchObject({ source: { id: 's1' }, duplicate: false });
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      'post /api/documents/uploads/direct',
      'put https://s3.example-storage.test/bucket/documents/u1/key',
      'post /api/documents/uploads/direct/6650f0c2a1b2c3d4e5f60718/complete',
    ]);
    expect(JSON.parse(calls[0].data)).toEqual({ fileName: 'Report.pdf', sizeBytes: file().size, mimeType: 'application/pdf' });
    expect(progress).toEqual([0.5]);

    const put = calls[1];
    expect(put.data).toBeInstanceOf(File); // the bytes go to storage only
    expect(put.headers['Content-Type']).toBe('application/pdf');
    expect(put.headers['Content-Disposition']).toBe('attachment');
    expect(put.headers.Authorization).toBeUndefined(); // no API token sent to the storage host
    expect(put.withCredentials).toBe(false); // no cookies either
  });

  test('an expired upload URL is renewed once, and the stale reservation released', async () => {
    let puts = 0;
    let starts = 0;
    routes = [
      [on('post', (u) => u === '/api/documents/uploads/direct'), (config) => {
        starts += 1;
        return startOk({ uploadId: starts === 1 ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbbbbbbbbb' })[1](config);
      }],
      [on('put', (u) => u.startsWith('https://s3.example-storage.test/')), (config) => {
        puts += 1;
        return puts === 1 ? response(config, 403, '<Error><Code>AccessDenied</Code></Error>') : response(config, 200, '');
      }],
      cancelOk,
      completeOk,
    ];
    await load();
    await sourceService.uploadDocument(file());
    expect(starts).toBe(2);
    expect(calls.filter((c) => c.method === 'delete').map((c) => c.url)).toEqual(['/api/documents/uploads/direct/aaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(calls.at(-1).url).toBe('/api/documents/uploads/direct/bbbbbbbbbbbbbbbbbbbbbbbb/complete');
  });

  test('a failed transfer releases the reservation and explains what happened', async () => {
    routes = [
      startOk(),
      [on('put', () => true), (config) => Promise.reject(new axios.AxiosError('Network Error', 'ERR_NETWORK', config, {}))],
      cancelOk,
    ];
    await load();
    const { getErrorMessage } = await import('../utils/errors');
    const error = await sourceService.uploadDocument(file()).catch((e) => e);
    expect(getErrorMessage(error)).toBe('The file could not be sent to storage. Check your connection and try again.');
    expect(calls.some((c) => c.method === 'delete')).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
  });

  test('cancelling stops the transfer and releases the reservation', async () => {
    const controller = new AbortController();
    routes = [
      startOk(),
      [on('put', () => true), (config) => {
        controller.abort();
        return Promise.reject(new axios.CanceledError('canceled', 'ERR_CANCELED', config));
      }],
      cancelOk,
    ];
    await load();
    const error = await sourceService.uploadDocument(file(), { signal: controller.signal }).catch((e) => e);
    expect(axios.isCancel(error) || error.code === 'ERR_CANCELED').toBe(true);
    expect(calls.some((c) => c.method === 'delete')).toBe(true);
  });

  test('servers without direct uploads still get the multipart upload', async () => {
    routes = [[on('post', (u) => u === '/api/documents/uploads'), (config) => response(config, 202, { data: { source: { id: 's2' } } })]];
    await load();
    const result = await sourceService.uploadDocument(file(), { method: 'multipart' });
    expect(result.source.id).toBe('s2');
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toBeInstanceOf(FormData);
  });
});
