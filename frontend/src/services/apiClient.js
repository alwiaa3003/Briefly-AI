import axios from 'axios';

/**
 * Shared axios instance.
 *
 * - The access token lives only in this module's memory (never localStorage),
 *   so it disappears when the tab closes and cannot be read by other scripts
 *   from storage.
 * - The refresh token is an httpOnly cookie the browser sends automatically to
 *   /api/auth/*; JavaScript never sees it.
 * - On a 401 from a protected endpoint, the request is retried once after a
 *   silent session refresh.
 * - Cold starts: on free hosting the server sleeps when idle. While it starts, the
 *   platform answers with its own 502/503/504 page (not our JSON) or holds the
 *   connection. Safe requests are retried with bounded exponential backoff and
 *   subscribers (ServerWakeNotice) are told the server is waking up.
 */

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 15000,
  headers: { Accept: 'application/json' },
});

let accessToken = null;
let refreshSessionHandler = null;
let sessionExpiredHandler = null;

// Endpoints whose 401s mean "wrong credentials / no session", not "token expired".
const SESSION_ENDPOINTS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

export function setAccessToken(token) {
  accessToken = token || null;
}

export function getAccessToken() {
  return accessToken;
}

/** Wired up by AuthProvider. */
export function configureSessionHandlers({ onRefresh, onSessionExpired }) {
  refreshSessionHandler = onRefresh;
  sessionExpiredHandler = onSessionExpired;
}

/* ------------------------------ cold starts ------------------------------ */

// About 90 s in total: a sleeping free instance takes roughly a minute to start.
let wakeRetryDelaysMs = [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000, 15000];
const SAFE_METHODS = new Set(['get', 'head', 'options']);
const PLATFORM_STATUSES = new Set([502, 503, 504]);
const wakeListeners = new Set();
let wakingRequests = 0;

/** Test hook: shorter delays. */
export function __setWakeRetryDelays(delays) {
  wakeRetryDelaysMs = delays;
}

/** Subscribe to "the server is waking up" (true while any request is waiting for it). */
export function subscribeToServerWake(listener) {
  wakeListeners.add(listener);
  listener(wakingRequests > 0);
  return () => wakeListeners.delete(listener);
}

function changeWaking(delta) {
  const before = wakingRequests > 0;
  wakingRequests = Math.max(0, wakingRequests + delta);
  const after = wakingRequests > 0;
  if (before !== after) wakeListeners.forEach((listener) => listener(after));
}

/** A 502/503/504 that did not come from Briefly's API (ours always carry a JSON error code). */
function isPlatformResponse(error) {
  const response = error?.response;
  if (!response || !PLATFORM_STATUSES.has(response.status)) return false;
  return !(response.data && typeof response.data === 'object' && response.data.error?.code);
}

function isNoResponse(error) {
  return !error?.response && Boolean(error?.request) && error?.code !== 'ERR_CANCELED';
}

/**
 * Whether `error` looks like the server is (re)starting rather than a real failure.
 * Exported so callers (AuthContext) never mistake a cold start for a signed-out user.
 */
export function isServerStartingError(error) {
  if (!error || axios.isCancel(error)) return false;
  return Boolean(error.serverStarting) || isPlatformResponse(error) || isNoResponse(error);
}

/**
 * Safe methods are retried on a platform page, a network error or a timeout. A non-idempotent
 * request may opt in with `retryWhileStarting: true`; it is then retried only on a platform page,
 * which means the request never reached the API (so it cannot have been applied twice).
 */
function retryable(config, error) {
  const method = String(config.method || 'get').toLowerCase();
  if (SAFE_METHODS.has(method)) return isPlatformResponse(error) || isNoResponse(error);
  return config.retryWhileStarting === true && isPlatformResponse(error);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new axios.CanceledError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new axios.CanceledError());
      },
      { once: true }
    );
  });
}

async function retryWhileStarting(original, firstError) {
  original._wakeRetrying = true;
  changeWaking(1);
  let lastError = firstError;
  try {
    for (const ms of wakeRetryDelaysMs) {
      await delay(ms, original.signal);
      try {
        return await apiClient.request(original);
      } catch (error) {
        lastError = error;
        if (!retryable(original, error)) throw error;
      }
    }
    throw Object.assign(lastError, { serverStarting: true });
  } finally {
    changeWaking(-1);
  }
}

/* ------------------------------ interceptors ------------------------------ */

apiClient.interceptors.request.use((config) => {
  if (accessToken && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;

    if (original && !original._wakeRetrying && retryable(original, error)) {
      return retryWhileStarting(original, error);
    }

    const isSessionEndpoint = SESSION_ENDPOINTS.some((path) => original?.url?.startsWith(path));
    if (error.response?.status === 401 && original && !original._retried && !isSessionEndpoint && refreshSessionHandler) {
      original._retried = true;
      try {
        const newToken = await refreshSessionHandler();
        original.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(original);
      } catch (refreshError) {
        // A server that is still starting is not a signed-out user.
        if (!isServerStartingError(refreshError)) sessionExpiredHandler?.();
      }
    }
    return Promise.reject(error);
  }
);
