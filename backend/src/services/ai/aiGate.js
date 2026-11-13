'use strict';

/**
 * Central manager for every Gemini request (generation and embeddings).
 *
 * Before a call it checks, in this order:
 *   1. provider state  - Gemini recently answered 429 for this model: wait instead of calling
 *   2. Briefly budgets - per-minute pacing, app-wide daily budget (total and per feature group),
 *                        per-user daily budget; reserved atomically, so concurrent callers can't overshoot
 *   3. concurrency     - a bounded number of simultaneous calls per kind (shared lease)
 * After the call it records the real number of Gemini requests (reported by the
 * processing service), tokens, and the outcome. A Gemini 429 blocks further calls
 * to that model until the provider's retry delay has passed.
 *
 * These are Briefly's own protective limits. Google's quotas are separate, set per
 * project and visible only in Google AI Studio; Briefly never claims to know them.
 */

const { AsyncLocalStorage } = require('async_hooks');
const config = require('../../config/env');
const { isSharedRedisReady, getSharedRedisConnection } = require('../../config/redis');
const { RedisStore, MemoryStore, newId } = require('./gateStore');
const logger = require('../../utils/logger');

const KINDS = Object.freeze({ GENERATION: 'generation', EMBEDDING: 'embedding' });
// Features as shown in the usage overview, and the budget group each one draws from.
const BUDGET_GROUP = Object.freeze({
  summary: 'summary',
  chat: 'chat',
  notes: 'study',
  quiz: 'study',
  flashcards: 'study',
  style: 'study',
  study: 'study',
});
const PROVIDER_LIMIT_CODES = new Set(['AI_QUOTA_EXHAUSTED', 'AI_RATE_LIMITED']);
// Permanent configuration problems: calls stop for a while instead of failing one by one.
const CONFIG_ERROR_CODES = new Set(['AI_MODEL_UNAVAILABLE', 'AI_CONFIGURATION_ERROR', 'AI_NOT_CONFIGURED']);
const CONFIG_BLOCK_MS = 10 * 60 * 1000;
const BLOCK_MESSAGES = {
  AI_QUOTA_EXHAUSTED: 'The free Gemini quota for this model is used up for now.',
  AI_RATE_LIMITED: 'Gemini is rate-limiting requests right now.',
  AI_MODEL_UNAVAILABLE: 'The AI model configured on the server is not available. An administrator needs to check GEMINI_MODEL.',
  AI_CONFIGURATION_ERROR: 'AI features are not available right now because of a server configuration problem.',
  AI_NOT_CONFIGURED: 'AI features are not configured on the server.',
};
const DAY_TTL_SECONDS = 3 * 24 * 3600;
const LEASE_TTL_MS = 10 * 60 * 1000;

class AiGateError extends Error {
  constructor(code, message, { retryAfterMs, scope, kind, model } = {}) {
    super(message);
    this.name = 'AiGateError';
    this.code = code;
    this.retryable = true;
    this.retryAfterMs = Math.max(0, Math.round(retryAfterMs || 0));
    this.scope = scope || null;
    this.kind = kind || null;
    this.model = model || null;
  }
}

/* ------------------------------ context ------------------------------ */

const context = new AsyncLocalStorage();
/** Runs fn with { feature, userId, waitForSlotMs } attached to every AI call it makes. */
function runWithAiContext(ctx, fn) {
  return context.run({ ...(context.getStore() || {}), ...ctx }, fn);
}
const currentContext = () => context.getStore() || {};

/* ------------------------------ store ------------------------------ */

const memoryStore = new MemoryStore();
let redisStore = null;
let storeOverride = null;
// Set by the worker process: budgets must come from the shared Redis store, never a per-process fallback.
let sharedStoreRequired = false;
let fallbackWarned = false;

/**
 * Makes the shared Redis store mandatory for this process (workers call this at startup).
 * An explicit AI_GATE_STORE=memory is still honoured: that is a deliberate single-process choice.
 */
function requireSharedStore(required = true) {
  sharedStoreRequired = Boolean(required);
}

function sharedRedisStore() {
  if (!redisStore) redisStore = new RedisStore(getSharedRedisConnection());
  return redisStore;
}

function getStore() {
  if (storeOverride) return storeOverride;
  const mode = config.ai.store;
  if (mode === 'memory') return memoryStore;
  // Workers and production servers: the shared budget is the only authority. While Redis is not
  // ready, AI calls wait (retryable, deferrable) instead of silently counting in process memory.
  if (sharedStoreRequired || (mode === 'auto' && config.isProduction)) {
    if (isSharedRedisReady()) return sharedRedisStore();
    throw new AiGateError('AI_BUDGET_UNAVAILABLE', "Briefly can't check its AI usage budget right now. Please try again shortly.", {
      retryAfterMs: 15000,
      scope: 'budget_store',
    });
  }
  if (config.isTest) return memoryStore;
  if (isSharedRedisReady() || mode === 'redis') return sharedRedisStore();
  if (!fallbackWarned) {
    fallbackWarned = true;
    logger.warn('Redis is not ready: AI budgets are counted in this process only until it connects (development mode).');
  }
  return memoryStore; // Development API without Redis: limits still apply within this process.
}

/* ------------------------------ time ------------------------------ */

function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.ai.budgetTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

/** Budget day (YYYY-MM-DD) in AI_BUDGET_TIMEZONE. */
function budgetDay(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Milliseconds until the next budget-day boundary (approximate across DST changes). */
function msUntilBudgetReset(date = new Date()) {
  const p = zonedParts(date);
  const elapsed = (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 + date.getMilliseconds();
  return Math.max(1000, 24 * 3600 * 1000 - elapsed);
}

const minuteSlot = (now = Date.now()) => Math.floor(now / 60000);

/* ------------------------------ models ------------------------------ */

let modelLoader = null;
let modelCache = { at: 0, value: null };
const MODEL_TTL_MS = 5 * 60 * 1000;

function setModelLoader(loader) {
  modelLoader = loader;
  modelCache = { at: 0, value: null };
}

/** Models configured in the processing service (cached; 'unknown' when it can't be reached). */
async function getModels() {
  if (modelCache.value && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.value;
  let value = null;
  try {
    value = modelLoader ? await modelLoader() : null;
  } catch {
    value = null;
  }
  const models = {
    generation: value?.generation_model || 'unknown',
    transcription: value?.transcription_model || value?.generation_model || 'unknown',
    ocr: value?.ocr_model || value?.generation_model || 'unknown',
    embedding: value?.embedding_model || 'unknown',
    apiVersion: value?.api_version || null,
    configured: value ? Boolean(value.configured) : null,
  };
  // Failures are cached briefly so an unreachable service doesn't add latency.
  modelCache = { at: value ? Date.now() : Date.now() - MODEL_TTL_MS + 30000, value: models };
  if (value) {
    learned.generation = models.generation;
    learned.transcription = models.transcription;
    learned.ocr = models.ocr;
    learned.embedding = models.embedding;
  }
  return models;
}

// Models learned from responses (every AI result and quota error names its model), so the hot path
// never needs an extra request. getModels() (usage overview) refreshes them from the processing service.
const learned = { generation: null, transcription: null, ocr: null, embedding: null };
function slotFor(kind, operation) {
  if (kind === KINDS.EMBEDDING) return 'embedding';
  if (operation === 'transcribe') return 'transcription';
  if (operation === 'ocr') return 'ocr';
  return 'generation';
}
function learn(kind, operation, model) {
  if (typeof model === 'string' && model) learned[slotFor(kind, operation)] = model;
}

/* ------------------------------ keys ------------------------------ */

const usageKey = (day) => `usage:${day}`;
const userUsageKey = (day, userId) => `usage:${day}:user:${userId}`;
const minuteKey = (kind, slot) => `minute:${kind}:${slot}`;
const blockKey = (kind) => `block:${kind}`;
const leaseKey = (kind) => `lease:${kind}`;
const statusKey = (kind) => `status:${kind}`;

/* ------------------------------ messages ------------------------------ */

function humanDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (ms < 90 * 1000) return 'about a minute';
  if (minutes < 90) return `about ${minutes} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
}

function budgetError(scope, kind, retryAfterMs) {
  if (scope === 'minute') {
    return new AiGateError('AI_PACED', 'Briefly is pacing AI requests to stay within the free tier.', { retryAfterMs, scope, kind });
  }
  const who = scope === 'user_daily' ? 'Your daily AI limit in Briefly' : "Briefly's daily AI budget";
  const what = scope === 'feature_daily' ? ' for this feature' : '';
  return new AiGateError('AI_BUDGET_EXHAUSTED', `${who}${what} has been reached. It resets in ${humanDuration(retryAfterMs)}.`, {
    retryAfterMs,
    scope,
    kind,
  });
}

/* ------------------------------ the gate ------------------------------ */

function countersFor(kind, feature, userId, day, slot) {
  const ai = config.ai;
  const counters = [];
  const scopes = [];
  if (kind === KINDS.GENERATION) {
    counters.push({ key: minuteKey(kind, slot), field: 'n', limit: ai.generationPerMinute });
    scopes.push('minute');
    counters.push({ key: usageKey(day), field: 'generation', limit: ai.appDailyGenerationLimit });
    scopes.push('app_daily');
    const group = BUDGET_GROUP[feature];
    if (group && ai.featureDailyGenerationLimits[group]) {
      counters.push({ key: usageKey(day), field: `generation:${group}`, limit: ai.featureDailyGenerationLimits[group] });
      scopes.push('feature_daily');
    }
    if (userId) {
      counters.push({ key: userUsageKey(day, userId), field: 'generation', limit: ai.userDailyGenerationLimit });
      scopes.push('user_daily');
    }
  } else {
    counters.push({ key: minuteKey(kind, slot), field: 'n', limit: ai.embeddingPerMinute });
    scopes.push('minute');
    counters.push({ key: usageKey(day), field: 'embedding', limit: ai.appDailyEmbeddingLimit });
    scopes.push('app_daily');
    if (userId) {
      counters.push({ key: userUsageKey(day, userId), field: 'embedding', limit: ai.userDailyEmbeddingLimit });
      scopes.push('user_daily');
    }
  }
  return { counters, scopes };
}

async function waitForLease(store, kind, limit, id, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await store.acquire(leaseKey(kind), limit, LEASE_TTL_MS, id)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Wraps one call to the processing service that uses Gemini.
 * `fn` must resolve to { data, requests } (requests = Gemini requests actually made) and,
 * on failure, throw an error that may carry `geminiRequests`, `code`, `retryAfterSeconds`, `quotaScope`, `model`.
 */
async function withAiCall({ kind, operation }, fn) {
  const ctx = currentContext();
  const feature = ctx.feature || 'other';
  const userId = ctx.userId ? String(ctx.userId) : null;
  const store = getStore();
  const model = learned[slotFor(kind, operation)] || 'unknown';

  // 1. Provider told us to wait: don't spend a request. A block for a model that is no longer
  //    configured (the administrator switched models) is ignored.
  const block = await store.getValue(blockKey(kind));
  if (block && (!block.model || model === 'unknown' || block.model === model)) {
    const retryAfterMs = Math.max(1000, block.until - Date.now());
    const gateError = new AiGateError(block.code, BLOCK_MESSAGES[block.code] || 'AI is unavailable right now.', {
      retryAfterMs,
      scope: block.scope,
      kind,
      model,
    });
    if (CONFIG_ERROR_CODES.has(block.code)) gateError.retryable = false;
    throw gateError;
  }

  // 2. Briefly's budgets (one request reserved up front).
  const day = budgetDay();
  const slot = minuteSlot();
  const { counters, scopes } = countersFor(kind, feature, userId, day, slot);
  const failed = await store.reserve(counters, DAY_TTL_SECONDS);
  if (failed >= 0) {
    const scope = scopes[failed];
    const retryAfterMs = scope === 'minute' ? (slot + 1) * 60000 - Date.now() + 250 : msUntilBudgetReset();
    throw budgetError(scope, kind, retryAfterMs);
  }

  // 3. Concurrency.
  const leaseId = newId();
  const limit = kind === KINDS.GENERATION ? config.ai.maxConcurrentGenerations : config.ai.maxConcurrentEmbeddings;
  if (!(await waitForLease(store, kind, limit, leaseId, ctx.waitForSlotMs || 0))) {
    await store.add(counters.map((c) => ({ key: c.key, field: c.field, amount: -1 })), DAY_TTL_SECONDS);
    throw new AiGateError('AI_BUSY', 'Other AI requests are in progress.', { retryAfterMs: 15000, scope: 'concurrency', kind, model });
  }

  let requests = 1;
  let outcome = 'ok';
  let error = null;
  let tokens = null;
  try {
    const result = await fn();
    requests = Number.isInteger(result.requests) ? result.requests : 1;
    tokens = result.data?.usage || null;
    learn(kind, operation, result.data?.model);
    return result.data;
  } catch (err) {
    error = err;
    requests = Number.isInteger(err.geminiRequests) ? err.geminiRequests : err.code?.startsWith?.('AI_') ? 1 : 0;
    outcome = err.code || 'error';
    learn(kind, operation, err.model);
    if (PROVIDER_LIMIT_CODES.has(err.code)) {
      const fallback = err.code === 'AI_QUOTA_EXHAUSTED' ? config.ai.quotaFallbackSeconds : config.ai.rateLimitFallbackSeconds;
      const seconds = Number.isFinite(err.retryAfterSeconds) && err.retryAfterSeconds > 0 ? err.retryAfterSeconds : fallback;
      // An unknown model is stored as null: the block then applies to whatever model is configured.
      const blockedModel = err.model || (model !== 'unknown' ? model : null);
      await store.setValue(
        blockKey(kind),
        {
          code: err.code,
          scope: err.quotaScope || (err.code === 'AI_QUOTA_EXHAUSTED' ? 'daily' : 'unknown'),
          until: Date.now() + seconds * 1000,
          providerDelay: Number.isFinite(err.retryAfterSeconds),
          model: blockedModel,
        },
        seconds * 1000
      );
      err.retryAfterMs = seconds * 1000;
      logger.warn('Gemini limit reached; pausing calls to this model', {
        code: err.code,
        kind,
        model: blockedModel,
        scope: err.quotaScope,
        seconds,
      });
    }
    if (CONFIG_ERROR_CODES.has(err.code)) {
      await store.setValue(
        blockKey(kind),
        { code: err.code, scope: 'configuration', until: Date.now() + CONFIG_BLOCK_MS, model: err.model || (model !== 'unknown' ? model : null) },
        CONFIG_BLOCK_MS
      );
    }
    throw err;
  } finally {
    await store.release(leaseKey(kind), leaseId).catch(() => {});
    await recordUsage(store, { kind, operation, feature, userId, model, day, slot, counters, requests, tokens, outcome, error }).catch((e) =>
      logger.warn('Could not record AI usage', { error: { message: e.message } })
    );
  }
}

async function recordUsage(store, { kind, operation, feature, userId, day, counters, requests, tokens, outcome }) {
  const model = learned[slotFor(kind, operation)] || 'unknown';
  const delta = requests - 1;
  const entries = delta ? counters.map((c) => ({ key: c.key, field: c.field, amount: delta })) : [];
  const inTok = Number(tokens?.input_tokens) || 0;
  const outTok = Number(tokens?.output_tokens) || 0;
  entries.push(
    { key: usageKey(day), field: `feature:${feature}:${kind}`, amount: requests },
    { key: usageKey(day), field: `model:${model}:${operation}`, amount: requests },
    { key: usageKey(day), field: `calls:${outcome === 'ok' ? 'ok' : 'failed'}`, amount: 1 }
  );
  if (inTok) entries.push({ key: usageKey(day), field: 'tokens:input', amount: inTok });
  if (outTok) entries.push({ key: usageKey(day), field: 'tokens:output', amount: outTok });
  if (userId) entries.push({ key: userUsageKey(day, userId), field: `feature:${feature}:${kind}`, amount: requests });
  await store.add(entries, DAY_TTL_SECONDS);
  if (outcome === 'ok' || PROVIDER_LIMIT_CODES.has(outcome) || ['AI_MODEL_UNAVAILABLE', 'AI_CONFIGURATION_ERROR', 'AI_NOT_CONFIGURED'].includes(outcome)) {
    await store.setValue(statusKey(kind), { outcome, model, at: Date.now() }, DAY_TTL_SECONDS * 1000);
  }
}

/**
 * Throws the same AiGateError a call would get if Gemini is currently blocked for this kind
 * (quota / rate limit / configuration), without reserving budget. Used to fail fast before
 * doing preparatory work (e.g. embedding a question that could not be answered anyway).
 */
async function assertAvailable(kind, operation = 'answer') {
  const model = learned[slotFor(kind, operation)] || 'unknown';
  const block = await getStore().getValue(blockKey(kind));
  if (block && (!block.model || model === 'unknown' || block.model === model)) {
    const gateError = new AiGateError(block.code, BLOCK_MESSAGES[block.code] || 'AI is unavailable right now.', {
      retryAfterMs: Math.max(1000, block.until - Date.now()),
      scope: block.scope,
      kind,
      model,
    });
    if (CONFIG_ERROR_CODES.has(block.code)) gateError.retryable = false;
    throw gateError;
  }
}

/* ------------------------------ overview ------------------------------ */

function parseFeatures(hash, prefix = 'feature:') {
  const out = {};
  for (const [field, value] of Object.entries(hash)) {
    if (!field.startsWith(prefix)) continue;
    const [, feature, kind] = field.split(':');
    out[feature] = out[feature] || { generation: 0, embedding: 0 };
    out[feature][kind] = (out[feature][kind] || 0) + value;
  }
  return out;
}

async function providerState(store, kind, model) {
  const raw = await store.getValue(blockKey(kind));
  const block = raw && (!raw.model || raw.model === model || model === 'unknown') ? raw : null;
  if (block && CONFIG_ERROR_CODES.has(block.code)) {
    return { state: 'unavailable', model, reason: block.code, until: new Date(block.until).toISOString() };
  }
  if (block) {
    return {
      state: block.code === 'AI_QUOTA_EXHAUSTED' ? 'quota_exhausted' : 'rate_limited',
      model,
      until: new Date(block.until).toISOString(),
      untilSource: block.providerDelay ? 'provider' : 'estimate',
    };
  }
  const last = await store.getValue(statusKey(kind));
  if (last && ['AI_MODEL_UNAVAILABLE', 'AI_CONFIGURATION_ERROR', 'AI_NOT_CONFIGURED'].includes(last.outcome) && last.model === model) {
    return { state: 'unavailable', model, reason: last.outcome, at: new Date(last.at).toISOString() };
  }
  return { state: last ? 'available' : 'unknown', model, lastSuccessAt: last?.outcome === 'ok' ? new Date(last.at).toISOString() : null };
}

async function getUsageOverview(userId) {
  const store = getStore();
  const day = budgetDay();
  const [app, user, models] = await Promise.all([
    store.getHash(usageKey(day)),
    userId ? store.getHash(userUsageKey(day, String(userId))) : {},
    getModels(),
  ]);
  const ai = config.ai;
  const used = (h, f) => Math.max(0, h[f] || 0);
  const budget = (usedValue, limit) => ({ used: usedValue, limit, remaining: Math.max(0, limit - usedValue) });
  const byModel = {};
  for (const [field, value] of Object.entries(app)) {
    if (!field.startsWith('model:')) continue;
    const parts = field.split(':');
    const operation = parts.pop();
    const model = parts.slice(1).join(':');
    byModel[model] = byModel[model] || {};
    byModel[model][operation] = value;
  }
  return {
    day,
    timeZone: ai.budgetTimeZone,
    resetsInSeconds: Math.round(msUntilBudgetReset() / 1000),
    note: "These are Briefly's own limits. Google's free-tier quotas are separate and can only be checked in Google AI Studio.",
    app: {
      generation: budget(used(app, 'generation'), ai.appDailyGenerationLimit),
      embedding: budget(used(app, 'embedding'), ai.appDailyEmbeddingLimit),
      features: Object.fromEntries(
        Object.entries(ai.featureDailyGenerationLimits).map(([group, limit]) => [group, budget(used(app, `generation:${group}`), limit)])
      ),
      byFeature: parseFeatures(app),
      byModel,
      tokens: { input: used(app, 'tokens:input'), output: used(app, 'tokens:output') },
      calls: { ok: used(app, 'calls:ok'), failed: used(app, 'calls:failed') },
    },
    user: {
      generation: budget(used(user, 'generation'), ai.userDailyGenerationLimit),
      embedding: budget(used(user, 'embedding'), ai.userDailyEmbeddingLimit),
      byFeature: parseFeatures(user),
    },
    limits: {
      generationPerMinute: ai.generationPerMinute,
      embeddingPerMinute: ai.embeddingPerMinute,
      maxConcurrentGenerations: ai.maxConcurrentGenerations,
    },
    provider: {
      generation: await providerState(store, KINDS.GENERATION, models.generation),
      embedding: await providerState(store, KINDS.EMBEDDING, models.embedding),
    },
    models: { generation: models.generation, transcription: models.transcription, ocr: models.ocr, embedding: models.embedding },
  };
}

/** Per-conversation lock against duplicate submissions (double clicks). */
async function acquireLock(name, ttlMs) {
  return getStore().setIfAbsent(`lock:${name}`, ttlMs);
}
async function releaseLock(name) {
  await getStore().del(`lock:${name}`);
}

/* ------------------------------ testing hooks ------------------------------ */

function __setStore(store) {
  storeOverride = store;
}
function __reset() {
  memoryStore.reset();
  storeOverride = null;
  sharedStoreRequired = false;
  fallbackWarned = false;
  modelCache = { at: 0, value: null };
  for (const k of Object.keys(learned)) learned[k] = null;
}

module.exports = {
  KINDS,
  AiGateError,
  PROVIDER_LIMIT_CODES,
  CONFIG_ERROR_CODES,
  runWithAiContext,
  currentContext,
  withAiCall,
  assertAvailable,
  getUsageOverview,
  getModels,
  setModelLoader,
  budgetDay,
  msUntilBudgetReset,
  humanDuration,
  acquireLock,
  releaseLock,
  getStore,
  requireSharedStore,
  __setStore,
  __reset,
};
