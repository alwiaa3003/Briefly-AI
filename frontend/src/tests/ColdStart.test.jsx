import axios from 'axios';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ServerWakeNotice from '../components/common/ServerWakeNotice';
import { apiClient as sharedClient, __setWakeRetryDelays } from '../services/apiClient';

/**
 * Cold starts on free hosting: the platform answers 502/503/504 (HTML, not our JSON) or not at
 * all while the server wakes. Safe requests retry with bounded backoff; others do not.
 */

let calls;
let apiModule;

function respond(config, status, data, contentType = 'application/json') {
  const res = { data, status, statusText: String(status), headers: { 'content-type': contentType }, config, request: {} };
  if (status >= 400) return Promise.reject(new axios.AxiosError(`status ${status}`, 'ERR_BAD_RESPONSE', config, {}, res));
  return Promise.resolve(res);
}

const platformPage = (config) => respond(config, 503, '<html><body>Service waking up</body></html>', 'text/html');
const networkError = (config) => Promise.reject(new axios.AxiosError('Network Error', 'ERR_NETWORK', config, {}));

/** Loads a fresh apiClient whose adapter answers with `script` in order. */
async function load(script) {
  vi.resetModules();
  calls = [];
  const queue = [...script];
  axios.defaults.adapter = (config) => {
    calls.push(`${config.method} ${config.url}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next(config);
  };
  apiModule = await import('../services/apiClient');
  apiModule.__setWakeRetryDelays([1, 1, 1, 1]);
  return apiModule.apiClient;
}

afterEach(() => {
  delete axios.defaults.adapter;
});

describe('cold-start retries', () => {
  test('a GET waits for the server and succeeds; listeners hear "waking" and then "awake"', async () => {
    const client = await load([platformPage, networkError, (c) => respond(c, 200, { ok: true })]);
    const states = [];
    apiModule.subscribeToServerWake((waking) => states.push(waking));
    const res = await client.get('/sources');
    expect(res.data).toEqual({ ok: true });
    expect(calls).toEqual(['get /sources', 'get /sources', 'get /sources']);
    expect(states).toEqual([false, true, false]);
  });

  test('retries are bounded, and the final error says the server is starting', async () => {
    const client = await load([platformPage]);
    const error = await client.get('/sources').catch((e) => e);
    expect(calls).toHaveLength(5); // first try + 4 retries
    expect(apiModule.isServerStartingError(error)).toBe(true);
    const { getErrorMessage } = await import('../utils/errors');
    expect(getErrorMessage(error)).toBe('Briefly is still starting up. Please try again in a moment.');
  });

  test("Briefly's own 503 (JSON error code) is a real error and is not retried", async () => {
    const client = await load([(c) => respond(c, 503, { error: { code: 'QUEUE_UNAVAILABLE', message: 'Queue down' } })]);
    const error = await client.get('/sources').catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(error.response.data.error.code).toBe('QUEUE_UNAVAILABLE');
    expect(apiModule.isServerStartingError(error)).toBe(false);
  });

  test('non-idempotent requests are never retried blindly', async () => {
    const client = await load([platformPage]);
    await client.post('/articles', { url: 'https://example.com' }).catch(() => {});
    expect(calls).toEqual(['post /articles']);
  });

  test('the session refresh is retried only when the request never reached the API', async () => {
    let client = await load([platformPage, (c) => respond(c, 200, { data: { accessToken: 't' } })]);
    await client.post('/auth/refresh', null, { retryWhileStarting: true });
    expect(calls).toEqual(['post /auth/refresh', 'post /auth/refresh']);

    // A network error or timeout may mean the token was already rotated: do not replay it.
    client = await load([networkError]);
    await client.post('/auth/refresh', null, { retryWhileStarting: true }).catch(() => {});
    expect(calls).toEqual(['post /auth/refresh']);
  });

  test('a cold start during a token refresh does not sign the user out', async () => {
    const client = await load([(c) => respond(c, 401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } })]);
    const onSessionExpired = vi.fn();
    const startingError = Object.assign(new Error('starting'), { serverStarting: true });
    apiModule.configureSessionHandlers({ onRefresh: () => Promise.reject(startingError), onSessionExpired });
    await client.get('/sources').catch(() => {});
    expect(onSessionExpired).not.toHaveBeenCalled();

    const authError = Object.assign(new Error('invalid'), { response: { status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } } });
    apiModule.configureSessionHandlers({ onRefresh: () => Promise.reject(authError), onSessionExpired });
    await client.get('/sources').catch(() => {});
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

describe('waking-up notice', () => {
  test('appears while requests wait for the server and disappears afterwards', async () => {
    // Same module instances as the rendered component (no module reset here).
    let release;
    let call = 0;
    __setWakeRetryDelays([1, 1, 1]);
    sharedClient.defaults.adapter = (config) => {
      call += 1;
      return call === 1 ? platformPage(config) : new Promise((resolve) => (release = resolve));
    };
    const client = sharedClient;
    render(<ServerWakeNotice showAfterMs={0} />);

    let pending;
    await act(async () => {
      pending = client.get('/sources').catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Briefly is waking up');

    await act(async () => {
      release({ data: {}, status: 200, headers: {}, config: {}, request: {} });
      await pending;
    });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    delete sharedClient.defaults.adapter;
  });
});
