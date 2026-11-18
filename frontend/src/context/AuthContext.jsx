import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import * as authService from '../services/authService';
import { configureSessionHandlers, isServerStartingError, setAccessToken } from '../services/apiClient';

export const AuthContext = createContext(null);

/**
 * status:
 *   'loading'          restoring a session from the refresh cookie on first load
 *   'authenticated'    user is signed in
 *   'unauthenticated'  no valid session
 *   'unavailable'      the server could not be reached (e.g. still starting); not a sign-out
 */
export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null });

  const applySession = useCallback(({ user, accessToken }) => {
    setAccessToken(accessToken);
    setState({ status: 'authenticated', user });
  }, []);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setState({ status: 'unauthenticated', user: null });
  }, []);

  /** Restores the session from the refresh cookie. A server that is still starting is not a sign-out. */
  const restoreSession = useCallback(
    (isCancelled = () => false) =>
      authService
        .refreshSession()
        .then((session) => !isCancelled() && applySession(session))
        .catch((error) => {
          if (isCancelled()) return;
          if (isServerStartingError(error)) setState({ status: 'unavailable', user: null });
          else clearSession();
        }),
    [applySession, clearSession]
  );

  const retryConnection = useCallback(() => {
    setState({ status: 'loading', user: null });
    return restoreSession();
  }, [restoreSession]);

  useEffect(() => {
    configureSessionHandlers({
      onRefresh: async () => {
        const session = await authService.refreshSession();
        applySession(session);
        return session.accessToken;
      },
      onSessionExpired: clearSession,
    });

    let cancelled = false;
    restoreSession(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [applySession, clearSession, restoreSession]);

  const login = useCallback(
    async (credentials) => {
      const session = await authService.login(credentials);
      applySession(session);
      return session.user;
    },
    [applySession]
  );

  const register = useCallback(
    async (details) => {
      const session = await authService.register(details);
      applySession(session);
      return session.user;
    },
    [applySession]
  );

  const logout = useCallback(async () => {
    try {
      await authService.logout();
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo(
    () => ({
      user: state.user,
      status: state.status,
      isAuthenticated: state.status === 'authenticated',
      login,
      register,
      logout,
      retryConnection,
    }),
    [state, login, register, logout, retryConnection]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
