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
    const isSessionEndpoint = SESSION_ENDPOINTS.some((path) => original?.url?.startsWith(path));

    if (error.response?.status === 401 && original && !original._retried && !isSessionEndpoint && refreshSessionHandler) {
      original._retried = true;
      try {
        const newToken = await refreshSessionHandler();
        original.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(original);
      } catch {
        sessionExpiredHandler?.();
      }
    }
    return Promise.reject(error);
  }
);
