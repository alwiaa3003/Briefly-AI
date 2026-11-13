import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER } from './renderApp';
import * as authService from '../services/authService';
import * as aiService from '../services/aiService';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

const USAGE = {
  day: '2026-11-13',
  timeZone: 'America/Los_Angeles',
  note: "These are Briefly's own limits. Google's free-tier quotas are separate and can only be checked in Google AI Studio.",
  app: {
    generation: { used: 12, limit: 15, remaining: 3 },
    embedding: { used: 40, limit: 500, remaining: 460 },
    features: {
      summary: { used: 5, limit: 10, remaining: 5 },
      chat: { used: 6, limit: 8, remaining: 2 },
      study: { used: 1, limit: 6, remaining: 5 },
    },
    byFeature: {
      summary: { generation: 5, embedding: 0 },
      chat: { generation: 6, embedding: 6 },
      indexing: { generation: 0, embedding: 30 },
    },
    byModel: {},
    tokens: { input: 1000, output: 200 },
    calls: { ok: 10, failed: 2 },
  },
  user: { generation: { used: 4, limit: 10, remaining: 6 }, embedding: { used: 3, limit: 200, remaining: 197 }, byFeature: {} },
  provider: {
    generation: { state: 'quota_exhausted', model: 'gemini-2.5-flash', until: '2026-11-14T08:00:00.000Z', untilSource: 'provider' },
    embedding: { state: 'available', model: 'gemini-embedding-001' },
  },
  models: {},
};

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
  aiService.getUsage.mockResolvedValue(USAGE);
  aiService.getPreferences.mockResolvedValue({
    summaryStyle: 'standard',
    quizDifficulty: 'medium',
    quizQuestionCount: 10,
    quizQuestionTypes: ['true_false'],
    flashcardCount: 20,
  });
});

describe('AI usage page', () => {
  test('shows Gemini status, Briefly budgets, per-feature usage and the AI Studio link', async () => {
    renderApp('/usage');
    expect(await screen.findByRole('heading', { level: 1, name: 'AI usage' })).toBeInTheDocument();
    const status = await screen.findByRole('region', { name: 'Gemini status' });
    expect(within(status).getByText('Free quota used up')).toBeInTheDocument();
    expect(within(status).getByText(/Gemini asked to wait until/)).toBeInTheDocument();
    expect(within(status).getByText('Available')).toBeInTheDocument();

    expect(screen.getByRole('progressbar', { name: 'AI generations used' })).toHaveAttribute('aria-valuenow', '12');
    expect(screen.getByText('12 / 15')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Your AI generations used' })).toHaveAttribute('aria-valuenow', '4');

    const table = screen.getByRole('region', { name: 'Requests by feature' });
    expect(within(table).getByText('Ask AI')).toBeInTheDocument();
    expect(within(table).getByText('Search indexing')).toBeInTheDocument();

    expect(screen.getByText(/can only be checked in Google AI Studio/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open AI Studio quotas/ })).toHaveAttribute('href', 'https://aistudio.google.com/rate-limit');
  });

  test('a usage failure shows an error, and Settings links to the usage page', async () => {
    aiService.getUsage.mockRejectedValue(new Error('down'));
    const { user } = renderApp('/settings');
    expect(await screen.findByText('Study preferences')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /AI usage/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'AI usage' })).toBeInTheDocument();
    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
  });

  test('is reached from the profile menu and marked active in the account navigation', async () => {
    const { user } = renderApp('/settings');
    // Not part of the main navigation: it lives with the account pages.
    const main = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(main).queryByRole('link', { name: /AI usage/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'AI usage' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'AI usage' })).toBeInTheDocument();

    const account = screen.getByRole('navigation', { name: 'Account pages' });
    expect(within(account).getByRole('link', { name: 'AI usage' })).toHaveAttribute('aria-current', 'page');
    expect(within(account).getByRole('link', { name: 'Account' })).not.toHaveAttribute('aria-current');
  });
});
