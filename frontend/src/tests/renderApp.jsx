import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import { ToastProvider } from '../context/ToastContext';

/** Renders the full application (real routes, providers and pages) at a given URL. */
export function renderApp(initialPath = '/') {
  const user = userEvent.setup();
  const result = render(
    <MemoryRouter initialEntries={[initialPath]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>
  );
  return { user, ...result };
}

export const TEST_USER = {
  id: '507f1f77bcf86cd799439011',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
};

export function apiError(status, code, message, details) {
  const error = new Error(message);
  error.response = { status, data: { success: false, error: { code, message, ...(details && { details }) } } };
  return error;
}
