import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import * as authService from '../services/authService';
import { configureSessionHandlers, setAccessToken } from '../services/apiClient';

export const AuthContext = createContext(null);

/**
 * status:
 *   'loading'          restoring a session from the refresh cookie on first load
 *   'authenticated'    user is signed in
 *   'unauthenticated'  no valid session
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
    authService
      .refreshSession()
      .then((session) => !cancelled && applySession(session))
      .catch(() => !cancelled && clearSession());
    return () => {
      cancelled = true;
    };
  }, [applySession, clearSession]);

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
    }),
    [state, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
