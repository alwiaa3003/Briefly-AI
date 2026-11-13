import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockRejectedValue(apiError(401, 'NO_SESSION', 'No active session.'));
  // Signing in lands on the dashboard, which loads the (empty) library.
  sourceService.getSourceStats.mockResolvedValue({ total: 0, completed: 0, processing: 0, failed: 0 });
  sourceService.listSources.mockResolvedValue({ items: [], page: 1, limit: 20, total: 0, totalPages: 1 });
});

describe('Login form', () => {
  test('shows required-field errors and does not submit when empty', async () => {
    const { user } = renderApp('/login');
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Email is required.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(authService.login).not.toHaveBeenCalled();
  });

  test('rejects a malformed email', async () => {
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), 'whatever1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(authService.login).not.toHaveBeenCalled();
  });

  test('shows the server error for invalid credentials', async () => {
    authService.login.mockRejectedValue(apiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.'));
    const { user } = renderApp('/login');

    await user.type(await screen.findByLabelText('Email'), TEST_USER.email);
    await user.type(screen.getByLabelText('Password'), 'wrongpass1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(authService.login).toHaveBeenCalledWith({ email: TEST_USER.email, password: 'wrongpass1' });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  test('shows a loading state while signing in', async () => {
    let resolveLogin;
    authService.login.mockReturnValue(new Promise((resolve) => (resolveLogin = resolve)));
    const { user } = renderApp('/login');

    await user.type(await screen.findByLabelText('Email'), TEST_USER.email);
    await user.type(screen.getByLabelText('Password'), 'analytical1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    resolveLogin({ user: TEST_USER, accessToken: 'token' });
    expect(await screen.findByRole('heading', { level: 1, name: 'A space for better thinking.' })).toBeInTheDocument();
  });
});

describe('Register form', () => {
  async function fill(user, { name = 'Ada Lovelace', email = 'ada@example.com', password = 'analytical1', confirm = password } = {}) {
    if (name) await user.type(await screen.findByLabelText('Name'), name);
    if (email) await user.type(screen.getByLabelText('Email'), email);
    if (password) await user.type(screen.getByLabelText('Password'), password);
    if (confirm) await user.type(screen.getByLabelText('Confirm password'), confirm);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
  }

  test('requires every field', async () => {
    const { user } = renderApp('/register');
    await user.click(await screen.findByRole('button', { name: 'Create account' }));

    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByText('Email is required.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    expect(screen.getByText('Please confirm your password.')).toBeInTheDocument();
    expect(authService.register).not.toHaveBeenCalled();
  });

  test('rejects mismatched passwords', async () => {
    const { user } = renderApp('/register');
    await fill(user, { confirm: 'different1' });

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(authService.register).not.toHaveBeenCalled();
  });

  test.each([
    ['short1', 'Password must be at least 8 characters.'],
    ['onlyletters', 'Password must contain at least one number.'],
    ['12345678', 'Password must contain at least one letter.'],
  ])('rejects weak password "%s"', async (password, message) => {
    const { user } = renderApp('/register');
    await fill(user, { password });

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(authService.register).not.toHaveBeenCalled();
  });

  test('shows a duplicate-email error from the server', async () => {
    authService.register.mockRejectedValue(apiError(409, 'EMAIL_IN_USE', 'An account with this email already exists.'));
    const { user } = renderApp('/register');
    await fill(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('An account with this email already exists.');
  });

  test('creates the account and enters the app', async () => {
    authService.register.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
    const { user } = renderApp('/register');
    await fill(user, { name: '  Ada Lovelace  ' });

    expect(authService.register).toHaveBeenCalledWith({ name: 'Ada Lovelace', email: 'ada@example.com', password: 'analytical1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'A space for better thinking.' })).toBeInTheDocument();
    expect(screen.getByText('Account created')).toBeInTheDocument();
  });
});
