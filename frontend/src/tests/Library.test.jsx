import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import { COMPLETED_SOURCE, FAILED_SOURCE, PROCESSING_SOURCE, listItem } from './fixtures';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';
import { formatShortDate } from '../utils/format';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

const ITEMS = [listItem(COMPLETED_SOURCE), listItem(FAILED_SOURCE), listItem(PROCESSING_SOURCE)];

function page(items, extra = {}) {
  return { items, page: 1, limit: 20, total: items.length, totalPages: 1, ...extra };
}

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
  sourceService.listSources.mockResolvedValue(page(ITEMS));
  sourceService.getSourceStats.mockResolvedValue({ total: 3, completed: 1, processing: 1, failed: 1 });
});

describe('Library', () => {
  test('lists summaries with title, date, status and links to details', async () => {
    renderApp('/library');

    const link = await screen.findByRole('link', { name: /How Urban Trees Cool Cities/ });
    expect(link).toHaveAttribute('href', `/library/${COMPLETED_SOURCE.id}`);
    // Finished items show no status badge (only states that need attention do).
    expect(screen.queryByText('Ready', { selector: 'span' })).not.toBeInTheDocument();
    expect(screen.getByText('Failed', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Reading article')).toBeInTheDocument();
    expect(screen.getByText(/dense canopy are consistently cooler/)).toBeInTheDocument();
    expect(screen.getByText(/may require a login/)).toBeInTheDocument();
    expect(screen.getAllByText(formatShortDate(COMPLETED_SOURCE.createdAt)).length).toBeGreaterThan(0);
  });

  test('searches (debounced) and filters by status', async () => {
    const { user } = renderApp('/library');
    await screen.findByRole('link', { name: /How Urban Trees Cool Cities/ });

    await user.type(screen.getByLabelText('Search library'), 'trees');
    await waitFor(() =>
      expect(sourceService.listSources).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'trees', page: 1 }))
    );

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'failed');
    await waitFor(() =>
      expect(sourceService.listSources).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'trees', status: 'failed' }))
    );
  });

  test('shows an empty state for a new user', async () => {
    sourceService.listSources.mockResolvedValue(page([]));
    renderApp('/library');

    expect(await screen.findByText('Your library is empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Summarize something' })).toHaveAttribute('href', '/summarize');
  });

  test('shows a no-results state with a way to clear filters', async () => {
    const { user } = renderApp('/library');
    await screen.findByRole('link', { name: /How Urban Trees Cool Cities/ });
    sourceService.listSources.mockResolvedValue(page([]));

    await user.type(screen.getByLabelText('Search library'), 'zzz');
    expect(await screen.findByText('No matching summaries')).toBeInTheDocument();

    sourceService.listSources.mockResolvedValue(page(ITEMS));
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('link', { name: /How Urban Trees Cool Cities/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Search library')).toHaveValue('');
  });

  test('the Documents filter shows real document summaries', async () => {
    const { user } = renderApp('/library');
    await screen.findByRole('link', { name: /How Urban Trees Cool Cities/ });
    sourceService.listSources.mockResolvedValue(
      page([
        { id: '6670aaaaaaaaaaaaaaaaaaaa', kind: 'document', status: 'completed', title: 'Annual Report', format: 'pdf', pageCount: 42, overview: 'A short overview of the report.', createdAt: COMPLETED_SOURCE.createdAt },
      ])
    );

    await user.click(screen.getByRole('button', { name: 'Documents' }));

    await waitFor(() => expect(sourceService.listSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'document' })));
    expect(await screen.findByRole('link', { name: /Annual Report/ })).toHaveAttribute('href', '/library/6670aaaaaaaaaaaaaaaaaaaa');
    expect(screen.getByText('PDF · 42 pages')).toBeInTheDocument();
  });

  test('filters by video kinds and shows video details in rows', async () => {
    sourceService.listSources.mockResolvedValue(
      page([
        {
          id: '6660aaaaaaaaaaaaaaaaaaaa',
          kind: 'youtube',
          status: 'transcribing',
          title: 'A long lecture',
          author: 'Science Channel',
          thumbnailUrl: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
          durationSeconds: 5400,
          progress: { current: 3, total: 9 },
          createdAt: COMPLETED_SOURCE.createdAt,
        },
      ])
    );
    const { user, container } = renderApp('/library');

    expect(await screen.findByRole('link', { name: /A long lecture/ })).toBeInTheDocument();
    expect(screen.getByText('Science Channel')).toBeInTheDocument();
    expect(screen.getByText('1 h 30 min')).toBeInTheDocument();
    expect(screen.getByText('part 4 of 9')).toBeInTheDocument();
    expect(container.querySelector('img[src="https://i.ytimg.com/vi/x/hqdefault.jpg"]')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'YouTube' }));
    await waitFor(() => expect(sourceService.listSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'youtube' })));
    await user.click(screen.getByRole('button', { name: 'Videos' }));
    await waitFor(() => expect(sourceService.listSources).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'video' })));
  });

  test('shows a retryable error state when loading fails', async () => {
    sourceService.listSources.mockRejectedValueOnce(apiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
    const { user } = renderApp('/library');

    expect(await screen.findByText('Could not load your library')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /How Urban Trees Cool Cities/ })).toBeInTheDocument();
  });

  test('paginates', async () => {
    sourceService.listSources.mockResolvedValue(page(ITEMS, { total: 45, totalPages: 3 }));
    const { user } = renderApp('/library');

    expect(await screen.findByText(/Page 1 of 3/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(sourceService.listSources).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });
});

describe('Dashboard with real data', () => {
  test('shows activity and recent summaries from the API', async () => {
    renderApp('/');

    expect(await screen.findByRole('link', { name: /How Urban Trees Cool Cities/ })).toBeInTheDocument();
    expect(sourceService.listSources).toHaveBeenCalledWith({ limit: 6 });
    expect(screen.getByText('1 summary in your library · 1 in progress · 1 need attention')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Study notes/ })).toHaveAttribute('href', '/study?tool=notes');
  });

  test('shows an error state with retry if data cannot be loaded', async () => {
    sourceService.getSourceStats.mockRejectedValueOnce(apiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
    const { user } = renderApp('/');

    expect(await screen.findByText('Could not load your recent reading')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /How Urban Trees Cool Cities/ })).toBeInTheDocument();
  });
});

describe('Library sorting and search links', () => {
  const SORTABLE = [
    listItem(COMPLETED_SOURCE, { id: 's-b', title: 'Beta notes', createdAt: '2026-11-03T10:00:00.000Z' }),
    listItem(COMPLETED_SOURCE, { id: 's-a', title: 'Alpha essay', createdAt: '2026-11-01T10:00:00.000Z' }),
    listItem(COMPLETED_SOURCE, { id: 's-c', title: 'Gamma lecture', createdAt: '2026-11-02T10:00:00.000Z' }),
  ];
  const titles = () =>
    screen
      .getAllByRole('link')
      .filter((link) => /^\/library\/s-/.test(link.getAttribute('href')))
      .map((link) => link.getAttribute('href').replace('/library/', ''));

  test('sorts newest first (API order), oldest first and by title', async () => {
    sourceService.listSources.mockResolvedValue(page(SORTABLE));
    const { user } = renderApp('/library');
    await screen.findByRole('link', { name: /Beta notes/ });
    expect(titles()).toEqual(['s-b', 's-a', 's-c']);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'oldest');
    expect(titles()).toEqual(['s-a', 's-c', 's-b']);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'title');
    expect(titles()).toEqual(['s-a', 's-b', 's-c']);
    // Single page: no caveat needed.
    expect(screen.queryByText(/sorted within this page/)).not.toBeInTheDocument();
  });

  test('says when a non-default order only applies to the current page', async () => {
    sourceService.listSources.mockResolvedValue(page(SORTABLE, { total: 45, totalPages: 3 }));
    const { user } = renderApp('/library');
    await screen.findByRole('link', { name: /Beta notes/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'title');
    expect(screen.getByText(/sorted within this page/)).toBeInTheDocument();
  });

  test('opens with the search from the URL (top-bar search)', async () => {
    renderApp('/library?q=urban');
    expect(await screen.findByRole('searchbox', { name: 'Search library' })).toHaveValue('urban');
    await waitFor(() => expect(sourceService.listSources).toHaveBeenCalledWith(expect.objectContaining({ search: 'urban' })));
  });
});
