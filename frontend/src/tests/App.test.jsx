import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import * as authService from '../services/authService';
import * as systemService from '../services/systemService';
import * as sourceService from '../services/sourceService';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

function signedOut() {
  authService.refreshSession.mockRejectedValue(apiError(401, 'NO_SESSION', 'No active session.'));
}

function signedIn() {
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'access-token' });
}

beforeEach(() => {
  vi.resetAllMocks();
  systemService.getSystemStatus.mockResolvedValue({
    status: 'ok',
    services: { database: { status: 'up' }, redis: { status: 'up' }, processingService: { status: 'up' } },
  });
  // A brand-new account: no sources yet.
  sourceService.getSourceStats.mockResolvedValue({ total: 0, completed: 0, processing: 0, failed: 0 });
  sourceService.listSources.mockResolvedValue({ items: [], page: 1, limit: 20, total: 0, totalPages: 1 });
  sourceService.getUploadConfig.mockResolvedValue({ enabled: false, maxBytes: 524288000, maxDurationMinutes: 180, retentionDays: 7 });
});

describe('Application shell', () => {
  test('renders the login page for visitors without a session', async () => {
    signedOut();
    renderApp('/login');

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/register');
  });

  test('restores an existing session and renders the dashboard', async () => {
    signedIn();
    renderApp('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'A space for better thinking.' })).toBeInTheDocument();
    expect(screen.getByText(/, Ada$/)).toBeInTheDocument();
    // The input area is on the home page itself: every method, starting with an article URL.
    expect(screen.getByRole('heading', { name: 'What would you like to understand today?' })).toBeInTheDocument();
    const methods = screen.getByRole('tablist', { name: 'Source type' });
    for (const name of [/Article/, /YouTube/, /Upload video/, /Document/]) {
      expect(within(methods).getByRole('tab', { name })).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Article URL', { selector: 'input' })).toBeInTheDocument();
    // A new user (no sources, from the API) gets first steps instead of empty statistics.
    expect(await screen.findByRole('heading', { name: /Your library is empty/ })).toBeInTheDocument();
    expect(screen.queryByText(/in your library/)).not.toBeInTheDocument();
  });
});

describe('Protected routes', () => {
  test.each(['/', '/summarize', '/library', '/settings'])('redirects %s to login when signed out', async (path) => {
    signedOut();
    renderApp(path);

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  test('returns to the originally requested page after signing in', async () => {
    signedOut();
    authService.login.mockResolvedValue({ user: TEST_USER, accessToken: 'access-token' });
    const { user } = renderApp('/library');

    await screen.findByRole('heading', { name: 'Welcome back' });
    await user.type(screen.getByLabelText('Email'), TEST_USER.email);
    await user.type(screen.getByLabelText('Password'), 'analytical1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument();
  });

  test('signed-in users visiting /login are sent to the dashboard', async () => {
    signedIn();
    renderApp('/login');

    expect(await screen.findByRole('heading', { level: 1, name: 'A space for better thinking.' })).toBeInTheDocument();
  });
});

describe('Navigation', () => {
  test('the main navigation has exactly Home, Library, Study and Ask AI', async () => {
    signedIn();
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });

    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Home', 'Library', 'Study', 'Ask AI']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/', '/library', '/study', '/ask']);
    // There is no sidebar: Settings and AI usage are not in the main navigation.
    expect(within(nav).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  test('main navigation and the profile menu navigate between pages', async () => {
    signedIn();
    const { user } = renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });

    await user.click(within(nav).getByRole('link', { name: 'Library' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    expect(await screen.findByText('Your library is empty')).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Study' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Study workspace' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByDisplayValue(TEST_USER.email)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'AI usage' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'AI usage' })).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Home' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'A space for better thinking.' })).toBeInTheDocument();
  });

  test('the summarize page is still reachable directly', async () => {
    signedIn();
    renderApp('/summarize');
    expect(await screen.findByRole('heading', { level: 1, name: 'Bring something in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Summarize article/ })).toBeEnabled();
  });

  test('top-bar search opens the library with the query', async () => {
    signedIn();
    const { user } = renderApp('/');

    await user.click(await screen.findByRole('button', { name: 'Search your library' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search your library' }), 'urban trees{Enter}');

    expect(await screen.findByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search library' })).toHaveValue('urban trees');
  });

  test('marks the current page in the main navigation', async () => {
    signedIn();
    renderApp('/library');
    const nav = await screen.findByRole('navigation', { name: 'Main' });

    expect(within(nav).getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  test('summarize tabs switch between article, YouTube and upload inputs', async () => {
    signedIn();
    const { user } = renderApp('/summarize');

    expect(await screen.findByLabelText('Article URL', { selector: 'input' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Summarize article/ })).toBeEnabled();

    await user.click(screen.getByRole('tab', { name: /YouTube/ }));
    expect(screen.getByLabelText('YouTube video URL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Summarize video/ })).toBeEnabled();

    await user.click(screen.getByRole('tab', { name: /Upload/ }));
    expect(await screen.findByText('Drop a video here, or click to browse')).toBeInTheDocument();
    // Storage is not configured in this test: uploads explain the setup requirement and stay disabled.
    expect(screen.getByText("Video uploads aren't set up on this server")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload and summarize/ })).toBeDisabled();
  });

  test('unknown routes show a not-found page inside the app', async () => {
    signedIn();
    renderApp('/nope');

    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  test('signing out returns to the login page', async () => {
    signedIn();
    authService.logout.mockResolvedValue();
    const { user } = renderApp('/');

    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(authService.logout).toHaveBeenCalledTimes(1);
  });
});
