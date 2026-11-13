import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import { COMPLETED_SOURCE, listItem } from './fixtures';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';
import * as aiService from '../services/aiService';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

const RESULT = {
  query: 'how trees cool cities',
  mode: 'hybrid',
  results: [
    {
      source: { id: COMPLETED_SOURCE.id, kind: 'document', title: 'Urban Heat Report', createdAt: '2026-11-01T10:00:00.000Z', siteName: null },
      overview: 'Overview',
      matches: [{ snippet: 'Urban trees cool streets by two degrees.', label: 'p. 4', page: 4 }],
      titleMatch: false,
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
  sourceService.listSources.mockResolvedValue({ items: [listItem(COMPLETED_SOURCE)], page: 1, limit: 20, total: 1, totalPages: 1 });
  aiService.getPreferences.mockResolvedValue({ summaryStyle: 'standard' });
});

describe('Smart search', () => {
  test('searches by meaning with type and date filters and links to results', async () => {
    aiService.searchLibrary.mockResolvedValue(RESULT);
    const { user } = renderApp('/library');
    await user.click(await screen.findByRole('button', { name: 'Smart search' }));
    expect(screen.getByText('Search by meaning')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Documents' }));
    await user.type(screen.getByLabelText('From date'), '2026-01-01');
    await user.type(screen.getByLabelText('Smart search'), 'how trees cool cities');

    const link = await screen.findByRole('link', { name: /Urban Heat Report/ }, { timeout: 2000 });
    expect(link).toHaveAttribute('href', `/library/${COMPLETED_SOURCE.id}`);
    expect(screen.getByText('Urban trees cool streets by two degrees.')).toBeInTheDocument();
    expect(screen.getByText('p. 4')).toBeInTheDocument();
    await waitFor(() =>
      expect(aiService.searchLibrary).toHaveBeenLastCalledWith({ q: 'how trees cool cities', kind: 'document', from: '2026-01-01', to: undefined, limit: 15 })
    );
  });

  test('says when only keyword matching was possible', async () => {
    aiService.searchLibrary.mockResolvedValue({ ...RESULT, mode: 'keyword' });
    const { user } = renderApp('/library');
    await user.click(await screen.findByRole('button', { name: 'Smart search' }));
    await user.type(screen.getByLabelText('Smart search'), 'trees');
    expect(await screen.findByText(/keyword matches only/, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  test('no matches and errors', async () => {
    aiService.searchLibrary.mockResolvedValueOnce({ ...RESULT, results: [] }).mockRejectedValue(apiError(429, 'RATE_LIMITED', 'Too many searches.'));
    const { user } = renderApp('/library');
    await user.click(await screen.findByRole('button', { name: 'Smart search' }));
    await user.type(screen.getByLabelText('Smart search'), 'zzz');
    expect(await screen.findByText('No matches', {}, { timeout: 2000 })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Smart search'), 'q');
    expect(await screen.findByText('Too many searches.', {}, { timeout: 2000 })).toBeInTheDocument();
  });
});

describe('Study preferences', () => {
  test('loads and saves defaults in Settings', async () => {
    aiService.getPreferences.mockResolvedValue({
      summaryStyle: 'standard',
      quizDifficulty: 'medium',
      quizQuestionCount: 10,
      quizQuestionTypes: ['multiple_choice', 'true_false', 'short_answer'],
      flashcardCount: 20,
    });
    aiService.updatePreferences.mockImplementation(async (changes) => changes);
    const { user } = renderApp('/settings');
    await user.selectOptions(await screen.findByLabelText('Default summary style'), 'exam_revision');
    await user.selectOptions(screen.getByLabelText('Quiz difficulty'), 'hard');
    await user.click(screen.getByLabelText('True / false'));
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));
    expect(aiService.updatePreferences).toHaveBeenCalledWith({
      summaryStyle: 'exam_revision',
      quizDifficulty: 'hard',
      quizQuestionCount: 10,
      quizQuestionTypes: ['multiple_choice', 'short_answer'],
      flashcardCount: 20,
    });
    expect(await screen.findByText('Preferences saved')).toBeInTheDocument();
  });
});
