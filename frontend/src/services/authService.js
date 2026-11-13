import { apiClient } from './apiClient';

/** Each function resolves with the `data` part of the API envelope. */

export async function register({ name, email, password }) {
  const response = await apiClient.post('/auth/register', { name, email, password });
  return response.data.data;
}

export async function login({ email, password }) {
  const response = await apiClient.post('/auth/login', { email, password });
  return response.data.data;
}

let inFlightRefresh = null;

/**
 * Exchanges the refresh cookie for a new access token.
 * Concurrent callers share one request: refresh tokens are single-use, so two
 * parallel refreshes would otherwise invalidate each other.
 */
export function refreshSession() {
  if (!inFlightRefresh) {
    inFlightRefresh = apiClient
      .post('/auth/refresh')
      .then((response) => response.data.data)
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

export async function logout() {
  await apiClient.post('/auth/logout');
}

export async function getCurrentUser() {
  const response = await apiClient.get('/auth/me');
  return response.data.data.user;
}
