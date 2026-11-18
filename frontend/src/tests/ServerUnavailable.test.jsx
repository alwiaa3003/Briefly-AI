import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

/** What apiClient rejects with after its cold-start retries are used up. */
function serverStarting() {
  return Object.assign(new Error('Service Unavailable'), { serverStarting: true });
}

beforeEach(() => {
  vi.resetAllMocks();
  sourceService.getSourceStats.mockResolvedValue({ total: 0, completed: 0, processing: 0, failed: 0 });
  sourceService.listSources.mockResolvedValue({ items: [], page: 1, limit: 20, total: 0, totalPages: 1 });
  sourceService.getUploadConfig.mockResolvedValue({ enabled: false, maxBytes: 524288000, maxDurationMinutes: 180, retentionDays: 7 });
});

describe('a server that is still starting', () => {
  test('is not treated as a sign-out; "Try again" restores the session', async () => {
    authService.refreshSession.mockRejectedValueOnce(serverStarting()).mockResolvedValue({ user: TEST_USER, accessToken: 't' });
    const { user } = renderApp('/library');

    expect(await screen.findByRole('heading', { name: 'Briefly is still starting' })).toBeInTheDocument();
    expect(screen.getByText(/You are still signed in/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome back' })).not.toBeInTheDocument(); // not the login page

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    expect(authService.refreshSession).toHaveBeenCalledTimes(2);
  });

  test('a real "no session" answer still goes to the login page', async () => {
    authService.refreshSession.mockRejectedValue(apiError(401, 'NO_SESSION', 'No active session.'));
    renderApp('/library');
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });
});
