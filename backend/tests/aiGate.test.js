'use strict';

/**
 * Quota-aware request manager (in-memory store; Redis semantics are covered by the infra test).
 * Each test loads the gate with its own low limits in an isolated module registry.
 */

function loadGate(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = String(v);
  }
  let modules;
  jest.isolateModules(() => {
    const gate = require('../src/services/ai/aiGate');
    const { ProcessingServiceError } = require('../src/services/processingClient');
    gate.__reset();
    gate.setModelLoader(async () => ({ generation_model: 'gen-model', embedding_model: 'emb-model', configured: true }));
    modules = { gate, ProcessingServiceError };
  });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return modules;
}

const GEN = { kind: 'generation', operation: 'summarize' };
const ok = (requests = 1, data = { model: 'gen-model', usage: { input_tokens: 100, output_tokens: 20 } }) =>
  jest.fn(async () => ({ data, requests }));

describe('budgets', () => {
  test('app-wide daily generation budget stops calls before Gemini is contacted', async () => {
    const { gate } = loadGate({ AI_APP_DAILY_GENERATION_LIMIT: 2 });
    const fn = ok();
    await gate.withAiCall(GEN, fn);
    await gate.withAiCall(GEN, fn);
    const error = await gate.withAiCall(GEN, fn).catch((e) => e);
    expect(error).toMatchObject({ name: 'AiGateError', code: 'AI_BUDGET_EXHAUSTED', scope: 'app_daily', retryable: true });
    expect(error.retryAfterMs).toBeGreaterThan(0);
    expect(error.retryAfterMs).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('per-user budget: one user reaching the limit does not block another', async () => {
    const { gate } = loadGate({ AI_USER_DAILY_GENERATION_LIMIT: 1 });
    const fn = ok();
    await gate.runWithAiContext({ userId: 'alice', feature: 'chat' }, () => gate.withAiCall(GEN, fn));
    const blocked = await gate.runWithAiContext({ userId: 'alice', feature: 'chat' }, () => gate.withAiCall(GEN, fn)).catch((e) => e);
    expect(blocked).toMatchObject({ code: 'AI_BUDGET_EXHAUSTED', scope: 'user_daily' });
    await expect(gate.runWithAiContext({ userId: 'bob', feature: 'chat' }, () => gate.withAiCall(GEN, fn))).resolves.toBeTruthy();
  });

  test('feature budgets are separate (study exhausted, summaries still allowed)', async () => {
    const { gate } = loadGate({ AI_APP_DAILY_STUDY_LIMIT: 1 });
    const fn = ok();
    await gate.runWithAiContext({ feature: 'quiz' }, () => gate.withAiCall(GEN, fn));
    const error = await gate.runWithAiContext({ feature: 'flashcards' }, () => gate.withAiCall(GEN, fn)).catch((e) => e);
    expect(error).toMatchObject({ code: 'AI_BUDGET_EXHAUSTED', scope: 'feature_daily' });
    await expect(gate.runWithAiContext({ feature: 'summary' }, () => gate.withAiCall(GEN, fn))).resolves.toBeTruthy();
  });

  test('embedding budget is independent of generation', async () => {
    const { gate } = loadGate({ AI_APP_DAILY_EMBEDDING_LIMIT: 1 });
    const fn = ok(1, { model: 'emb-model' });
    await gate.withAiCall({ kind: 'embedding', operation: 'embed' }, fn);
    await expect(gate.withAiCall({ kind: 'embedding', operation: 'embed' }, fn)).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
    await expect(gate.withAiCall(GEN, ok())).resolves.toBeTruthy();
  });

  test('per-minute pacing returns a short retry delay', async () => {
    const { gate } = loadGate({ AI_GENERATION_RPM: 1 });
    await gate.withAiCall(GEN, ok());
    const error = await gate.withAiCall(GEN, ok()).catch((e) => e);
    expect(error).toMatchObject({ code: 'AI_PACED', scope: 'minute' });
    expect(error.retryAfterMs).toBeLessThanOrEqual(61000);
  });

  test('concurrent callers never overshoot a budget (atomic reservations)', async () => {
    const { gate } = loadGate({ AI_APP_DAILY_GENERATION_LIMIT: 3 });
    const fn = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { data: {}, requests: 1 };
    });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => gate.withAiCall(GEN, fn)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'AI_BUDGET_EXHAUSTED')).toBe(true);
  });

  test('concurrency limit: excess calls get AI_BUSY and the budget reservation is released', async () => {
    const { gate } = loadGate({ AI_MAX_CONCURRENT_GENERATIONS: 1, AI_APP_DAILY_GENERATION_LIMIT: 5 });
    let release;
    const slow = jest.fn(() => new Promise((r) => (release = () => r({ data: {}, requests: 1 }))));
    const first = gate.withAiCall(GEN, slow);
    await new Promise((r) => setTimeout(r, 10));
    await expect(gate.withAiCall(GEN, ok())).rejects.toMatchObject({ code: 'AI_BUSY' });
    release();
    await first;
    const usage = await gate.getUsageOverview();
    expect(usage.app.generation.used).toBe(1);
    await expect(gate.withAiCall(GEN, ok())).resolves.toBeTruthy();
  });

  test('records the real number of Gemini requests and tokens per feature and model', async () => {
    const { gate } = loadGate({ AI_APP_DAILY_GENERATION_LIMIT: 10 });
    await gate.runWithAiContext({ feature: 'summary', userId: 'u1' }, () => gate.withAiCall(GEN, ok(3)));
    const usage = await gate.getUsageOverview('u1');
    expect(usage.app.generation).toEqual({ used: 3, limit: 10, remaining: 7 });
    expect(usage.app.byFeature.summary).toEqual({ generation: 3, embedding: 0 });
    expect(usage.app.byModel['gen-model']).toEqual({ summarize: 3 });
    expect(usage.app.tokens).toEqual({ input: 100, output: 20 });
    expect(usage.user.generation.used).toBe(3);
    expect(usage.note).toMatch(/Briefly's own limits/);
  });
});

describe('provider limits', () => {
  test('daily quota exhaustion blocks further calls until the provider retry delay passes', async () => {
    const { gate, ProcessingServiceError } = loadGate();
    const quota = new ProcessingServiceError('used up', {
      code: 'AI_QUOTA_EXHAUSTED',
      retryable: true,
      meta: { scope: 'daily', retry_after_seconds: 28853, model: 'gen-model' },
      geminiRequests: 1,
    });
    const failing = jest.fn(async () => {
      throw quota;
    });
    await expect(gate.withAiCall(GEN, failing)).rejects.toBe(quota);
    expect(quota.retryAfterMs).toBe(28853000);

    const next = jest.fn();
    const blocked = await gate.withAiCall(GEN, next).catch((e) => e);
    expect(next).not.toHaveBeenCalled();
    expect(blocked).toMatchObject({ name: 'AiGateError', code: 'AI_QUOTA_EXHAUSTED', scope: 'daily' });
    expect(blocked.retryAfterMs).toBeGreaterThan(28800000);

    const overview = await gate.getUsageOverview();
    expect(overview.provider.generation).toMatchObject({ state: 'quota_exhausted', model: 'gen-model', untilSource: 'provider' });
    // Embeddings are a separate quota and stay available.
    await expect(gate.withAiCall({ kind: 'embedding', operation: 'embed' }, ok(1, { model: 'emb-model' }))).resolves.toBeTruthy();
  });

  test('a 429 without a retry delay uses the configured fallback and says it is an estimate', async () => {
    const { gate, ProcessingServiceError } = loadGate({ AI_RATE_LIMIT_FALLBACK_SECONDS: 45 });
    const limited = new ProcessingServiceError('busy', { code: 'AI_RATE_LIMITED', retryable: true, meta: { scope: 'unknown' } });
    await expect(gate.withAiCall(GEN, async () => Promise.reject(limited))).rejects.toBe(limited);
    expect(limited.retryAfterMs).toBe(45000);
    const overview = await gate.getUsageOverview();
    expect(overview.provider.generation).toMatchObject({ state: 'rate_limited', untilSource: 'estimate' });
  });

  test('a block recorded for another model is ignored after the model is changed', async () => {
    const { gate, ProcessingServiceError } = loadGate();
    const quota = new ProcessingServiceError('x', { code: 'AI_QUOTA_EXHAUSTED', retryable: true, meta: { scope: 'daily', retry_after_seconds: 600, model: 'old-model' } });
    await gate.withAiCall(GEN, async () => Promise.reject(quota)).catch(() => null);
    await expect(gate.withAiCall(GEN, ok())).rejects.toMatchObject({ code: 'AI_QUOTA_EXHAUSTED' });
    // The processing service now reports a different model.
    await gate.getModels();
    await expect(gate.withAiCall(GEN, ok())).resolves.toBeTruthy();
  });

  test('unavailable model / invalid key: not retryable, and calls pause instead of failing one by one', async () => {
    const { gate, ProcessingServiceError } = loadGate();
    const unavailable = new ProcessingServiceError('no model', { code: 'AI_MODEL_UNAVAILABLE', retryable: false, meta: { model: 'gen-model' } });
    await expect(gate.withAiCall(GEN, async () => Promise.reject(unavailable))).rejects.toBe(unavailable);
    const next = jest.fn();
    const error = await gate.withAiCall(GEN, next).catch((e) => e);
    expect(error).toMatchObject({ code: 'AI_MODEL_UNAVAILABLE', retryable: false });
    expect(next).not.toHaveBeenCalled();
    expect((await gate.getUsageOverview()).provider.generation.state).toBe('unavailable');
  });

  test('assertAvailable fails fast without reserving budget', async () => {
    const { gate, ProcessingServiceError } = loadGate({ AI_APP_DAILY_GENERATION_LIMIT: 5 });
    await expect(gate.assertAvailable('generation')).resolves.toBeUndefined();
    const limited = new ProcessingServiceError('x', { code: 'AI_RATE_LIMITED', retryable: true, meta: { retry_after_seconds: 30 } });
    await gate.withAiCall(GEN, async () => Promise.reject(limited)).catch(() => null);
    await expect(gate.assertAvailable('generation')).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });
    expect((await gate.getUsageOverview()).app.generation.used).toBe(1);
  });
});

describe('time helpers', () => {
  test('budget day and reset are computed in the configured time zone', () => {
    const { gate } = loadGate({ AI_BUDGET_TIMEZONE: 'America/Los_Angeles' });
    const date = new Date('2026-11-13T07:30:00Z'); // 23:30 the previous day in Los Angeles (PST)
    expect(gate.budgetDay(date)).toBe('2026-11-12');
    expect(gate.msUntilBudgetReset(date)).toBe(30 * 60 * 1000);
  });

  test('invalid time zones are rejected at startup', () => {
    process.env.AI_BUDGET_TIMEZONE = 'Mars/Olympus';
    try {
      expect(() => jest.isolateModules(() => require('../src/config/env'))).toThrow(/AI_BUDGET_TIMEZONE/);
    } finally {
      delete process.env.AI_BUDGET_TIMEZONE;
    }
  });
});
