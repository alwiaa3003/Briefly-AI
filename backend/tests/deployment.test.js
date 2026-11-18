'use strict';

/**
 * Single-service deployment: Express serves the built frontend next to the API, the health
 * check, the separate refresh rate limit behind a proxy, and the BullMQ / maintenance tuning.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

function makeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefly-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("app")');
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return dir;
}

describe('Express serves the frontend and the API from one origin', () => {
  const { createApp } = require('../src/app');
  const dist = makeDist();
  const app = createApp({ frontendDistDir: dist });
  afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

  test('the app shell is served at / and for client-side routes, never cached', async () => {
    for (const route of ['/', '/library/6650f0c2a1b2c3d4e5f60718', '/study?tool=notes', '/settings']) {
      const res = await request(app).get(route);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.text).toContain('<div id="root">');
    }
  });

  test('hashed assets are cached long-term; other static files are revalidated', async () => {
    const asset = await request(app).get('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(app).get('/favicon.svg')).headers['cache-control']).toBe('no-cache');
  });

  test('API routes are never swallowed by the SPA fallback', async () => {
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.data.status).toBe('ok');

    const missing = await request(app).get('/api/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/json/);
    expect(missing.body.error.code).toBe('ROUTE_NOT_FOUND');

    const protectedRoute = await request(app).get('/api/sources');
    expect(protectedRoute.status).toBe(401);
  });

  test('missing files and non-GET requests are 404s, not the app shell', async () => {
    expect((await request(app).get('/assets/missing.js')).status).toBe(404);
    expect((await request(app).get('/robots.txt')).status).toBe(404);
    expect((await request(app).post('/library')).status).toBe(404);
  });

  test('pages get a Content-Security-Policy limited to the hosts the UI uses', async () => {
    const csp = (await request(app).get('/')).headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('https://www.youtube-nocookie.com');
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test('the storage origin is allowed for uploads, playback and the PDF viewer', () => {
    jest.isolateModules(() => {
      process.env.STORAGE_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com';
      process.env.STORAGE_BUCKET = 'my-bucket';
      process.env.STORAGE_FORCE_PATH_STYLE = 'true';
      const { storageOrigins } = require('../src/frontend');
      expect(storageOrigins()).toEqual(['https://s3.us-east-005.backblazeb2.com']);
    });
    delete process.env.STORAGE_ENDPOINT;
    delete process.env.STORAGE_BUCKET;
    delete process.env.STORAGE_FORCE_PATH_STYLE;
  });

  test('a missing build fails at startup with a clear message', () => {
    expect(() => createApp({ frontendDistDir: path.join(os.tmpdir(), 'no-such-dist-dir') })).toThrow(/Build the frontend first/);
  });

  test('without FRONTEND_DIST_DIR (development) only the API is served', async () => {
    const apiOnly = createApp({ frontendDistDir: '' });
    expect((await request(apiOnly).get('/')).status).toBe(404);
    expect((await request(apiOnly).get('/api/health')).status).toBe(200);
  });
});

describe('health check for the platform', () => {
  const { createApp } = require('../src/app');
  const app = createApp({ frontendDistDir: '' });

  test('/api/health stays 200 while Redis and the database are unreachable, and reveals nothing internal', async () => {
    // Unit tests run with Redis and MongoDB pointed at closed ports.
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['service', 'status', 'timestamp', 'uptimeSeconds']);
    expect(JSON.stringify(res.body)).not.toMatch(/redis|mongo|127\.0\.0\.1|secret/i);
  });

  test('/api/health/ready still reports dependencies separately (503 when one is down)', async () => {
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.data.services.redis.status).toBe('down');
  });
});

describe('session refresh has its own rate limit (per client IP behind a proxy)', () => {
  let app;
  let db;

  beforeAll(async () => {
    process.env.AUTH_RATE_LIMIT_MAX = '3';
    process.env.AUTH_REFRESH_RATE_LIMIT_MAX = '5';
    process.env.TRUST_PROXY = '1';
    jest.isolateModules(() => {
      db = require('./helpers/db');
      app = require('../src/app').createApp({ frontendDistDir: '' });
    });
    await db.startTestDatabase();
  });

  afterAll(async () => {
    process.env.AUTH_RATE_LIMIT_MAX = '1000';
    delete process.env.AUTH_REFRESH_RATE_LIMIT_MAX;
    delete process.env.TRUST_PROXY;
    await db.stopTestDatabase();
  });

  const fromClient = (ip) => ({ 'X-Forwarded-For': ip });

  test('reloads (refreshes) never use up the login budget, and each budget still applies', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).post('/api/auth/refresh').set(fromClient(ip))).status).toBe(401); // no cookie
    }
    expect((await request(app).post('/api/auth/refresh').set(fromClient(ip))).status).toBe(429);

    // Login is unaffected by the refreshes above...
    const login = () => request(app).post('/api/auth/login').set(fromClient(ip)).send({ email: 'nobody@example.com', password: 'wrongpass1' });
    for (let i = 0; i < 3; i += 1) expect((await login()).status).toBe(401);
    // ...and still limited on its own.
    expect((await login()).status).toBe(429);
  });

  test('behind the proxy, limits are counted per real client IP', async () => {
    const other = await request(app).post('/api/auth/refresh').set(fromClient('198.51.100.7'));
    expect(other.status).toBe(401); // not 429: a different client has its own budget
  });
});

describe('BullMQ worker tuning (Upstash free tier)', () => {
  test('the processing worker idles longer between polls and keeps its reliability settings', () => {
    let options;
    jest.isolateModules(() => {
      jest.doMock('bullmq', () => ({
        Worker: jest.fn().mockImplementation((_name, _processor, opts) => {
          options = opts;
          return { on: jest.fn(), close: jest.fn() };
        }),
      }));
      jest.doMock('../src/config/redis', () => ({ createRedisConnection: () => ({ quit: jest.fn() }) }));
      process.env.WORKER_CONCURRENCY = '1';
      const { createProcessingWorker } = require('../src/workers/processingWorker');
      createProcessingWorker();
    });
    delete process.env.WORKER_CONCURRENCY;
    expect(options).toMatchObject({ concurrency: 1, drainDelay: 60, stalledInterval: 120000, maxStalledCount: 2 });
    expect(typeof options.settings.backoffStrategy).toBe('function');
  });

  test('tuning is configurable through the environment', () => {
    let options;
    jest.isolateModules(() => {
      jest.doMock('bullmq', () => ({
        Worker: jest.fn().mockImplementation((_n, _p, opts) => {
          options = opts;
          return { on: jest.fn(), close: jest.fn() };
        }),
      }));
      jest.doMock('../src/config/redis', () => ({ createRedisConnection: () => ({ quit: jest.fn() }) }));
      process.env.WORKER_DRAIN_DELAY_SECONDS = '30';
      process.env.WORKER_STALLED_INTERVAL_MS = '60000';
      require('../src/workers/processingWorker').createProcessingWorker();
    });
    delete process.env.WORKER_DRAIN_DELAY_SECONDS;
    delete process.env.WORKER_STALLED_INTERVAL_MS;
    expect(options).toMatchObject({ drainDelay: 30, stalledInterval: 60000 });
  });
});

describe('maintenance (expired-upload cleanup) without a polling queue', () => {
  test('a run happens only when the shared lock is free, at most once per interval', async () => {
    const cleanup = jest.fn().mockResolvedValue({ deleted: 0, failed: 0 });
    let runScheduledCleanup;
    jest.isolateModules(() => {
      jest.doMock('../src/services/cleanupService', () => ({ cleanupExpiredUploads: cleanup }));
      ({ runScheduledCleanup } = require('../src/workers/maintenanceWorker'));
    });
    const lock = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('redis down'));

    expect(await runScheduledCleanup({ intervalMs: 3600000, acquireLock: lock })).toEqual({ deleted: 0, failed: 0 });
    expect(await runScheduledCleanup({ intervalMs: 3600000, acquireLock: lock })).toEqual({ skipped: true, reason: 'recently_run' });
    expect(await runScheduledCleanup({ intervalMs: 3600000, acquireLock: lock })).toEqual({ skipped: true, reason: 'lock_unavailable' });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith('maintenance:cleanup-expired-uploads', 3540000);
  });

  test('startup removes the old BullMQ schedule and runs cleanup on a timer', async () => {
    jest.useFakeTimers();
    const removeJobScheduler = jest.fn().mockResolvedValue(true);
    const cleanup = jest.fn().mockResolvedValue({ deleted: 1, failed: 0 });
    let startMaintenance;
    jest.isolateModules(() => {
      jest.doMock('bullmq', () => ({ Queue: jest.fn().mockImplementation(() => ({ removeJobScheduler, close: jest.fn().mockResolvedValue() })) }));
      jest.doMock('../src/config/redis', () => ({ createRedisConnection: () => ({ quit: jest.fn().mockResolvedValue() }) }));
      jest.doMock('../src/services/cleanupService', () => ({ cleanupExpiredUploads: cleanup }));
      jest.doMock('../src/services/ai/aiGate', () => ({ acquireLock: jest.fn().mockResolvedValue(true) }));
      ({ startMaintenance } = require('../src/workers/maintenanceWorker'));
    });
    try {
      const maintenance = await startMaintenance({ intervalMs: 60000, firstRunDelayMs: 1000 });
      expect(removeJobScheduler).toHaveBeenCalledWith('cleanup-expired-uploads');
      expect(cleanup).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      expect(cleanup).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60000);
      expect(cleanup).toHaveBeenCalledTimes(2);
      await maintenance.close();
      await jest.advanceTimersByTimeAsync(120000);
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
