import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import { COMPLETED_SOURCE, FAILED_SOURCE, PROCESSING_SOURCE } from './fixtures';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';
import { summaryToMarkdown } from '../utils/summaryMarkdown';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Summary detail page', () => {
  test('shows a loading skeleton, then the full summary', async () => {
    let resolve;
    sourceService.getSource.mockReturnValue(new Promise((r) => (resolve = r)));
    renderApp(`/library/${COMPLETED_SOURCE.id}`);

    expect(await screen.findByRole('status', { name: 'Loading summary' })).toBeInTheDocument();
    resolve(COMPLETED_SOURCE);

    expect(await screen.findByRole('heading', { level: 1, name: 'How Urban Trees Cool Cities' })).toBeInTheDocument();
    // Metadata
    expect(screen.getByText('The Example Gazette')).toBeInTheDocument();
    expect(screen.getByText('By Priya Raman')).toBeInTheDocument();
    expect(screen.getByText('4 min read')).toBeInTheDocument();
    // Overview, detailed sections (paragraphs preserved), takeaways, concepts, arguments
    expect(screen.getByText(/dense canopy are consistently cooler/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'How trees lower temperatures' })).toBeInTheDocument();
    expect(screen.getByText('Leaves block sunlight.')).toBeInTheDocument();
    expect(screen.getByText('Evapotranspiration draws heat from the air.')).toBeInTheDocument();
    const takeaways = screen.getByRole('heading', { name: 'Key takeaways' }).closest('section');
    expect(within(takeaways).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Evapotranspiration', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.getByText('Urban forests are a cost-effective adaptation tool.')).toBeInTheDocument();
    // Source link opens safely in a new tab
    const original = screen.getByRole('link', { name: /Open original/ });
    expect(original).toHaveAttribute('href', COMPLETED_SOURCE.url);
    expect(original).toHaveAttribute('target', '_blank');
    expect(original.getAttribute('rel')).toContain('noopener');
  });

  test('copies the summary as Markdown', async () => {
    sourceService.getSource.mockResolvedValue(COMPLETED_SOURCE);
    const { user } = renderApp(`/library/${COMPLETED_SOURCE.id}`);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

    await user.click(await screen.findByRole('button', { name: 'Copy summary' }));

    expect(writeText).toHaveBeenCalledWith(summaryToMarkdown(COMPLETED_SOURCE));
    expect(writeText.mock.calls[0][0]).toContain('## Key takeaways');
    expect(await screen.findByText('Summary copied')).toBeInTheDocument();
  });

  test('shows processing progress and polls until the summary is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sourceService.getSource
      .mockResolvedValueOnce(PROCESSING_SOURCE)
      .mockResolvedValueOnce({ ...PROCESSING_SOURCE, status: 'summarizing' })
      .mockResolvedValue(COMPLETED_SOURCE);
    renderApp(`/library/${PROCESSING_SOURCE.id}`);

    expect(await screen.findByText('Working on your summary')).toBeInTheDocument();
    expect(screen.getByText(PROCESSING_SOURCE.submittedUrl)).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Reading article');

    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByText('Writing the summary, takeaways and key concepts')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByRole('heading', { level: 1, name: 'How Urban Trees Cool Cities' })).toBeInTheDocument();

    const callsWhenDone = sourceService.getSource.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(sourceService.getSource.mock.calls.length).toBe(callsWhenDone); // polling stopped
  });

  test('tells the user when a retry is in progress', async () => {
    sourceService.getSource.mockResolvedValue({ ...PROCESSING_SOURCE, job: { attempts: 2, maxAttempts: 3 } });
    renderApp(`/library/${PROCESSING_SOURCE.id}`);
    expect(await screen.findByText(/attempt 2 of 3/)).toBeInTheDocument();
  });

  test('shows the failure reason and retries on request', async () => {
    sourceService.getSource.mockResolvedValueOnce(FAILED_SOURCE).mockResolvedValue({ ...FAILED_SOURCE, status: 'queued', error: null });
    sourceService.retrySource.mockResolvedValue({ source: { ...FAILED_SOURCE, status: 'queued' }, job: { id: 'j' } });
    const { user } = renderApp(`/library/${FAILED_SOURCE.id}`);

    expect(await screen.findByText('This article could not be summarized')).toBeInTheDocument();
    expect(screen.getByText(/may require a login or subscription/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy summary' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Try again/ }));

    expect(sourceService.retrySource).toHaveBeenCalledWith(FAILED_SOURCE.id);
    expect(await screen.findByText('Working on your summary')).toBeInTheDocument();
  });

  test('reports retry errors without leaving the page', async () => {
    sourceService.getSource.mockResolvedValue(FAILED_SOURCE);
    sourceService.retrySource.mockRejectedValue(apiError(503, 'QUEUE_UNAVAILABLE', 'Background processing is temporarily unavailable.'));
    const user = userEvent.setup();
    renderApp(`/library/${FAILED_SOURCE.id}`);

    await user.click(await screen.findByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Background processing is temporarily unavailable.')).toBeInTheDocument();
    expect(screen.getByText('This article could not be summarized')).toBeInTheDocument();
  });

  test('shows a not-found state for unknown or foreign summaries', async () => {
    sourceService.getSource.mockRejectedValue(apiError(404, 'SOURCE_NOT_FOUND', 'Summary not found.'));
    renderApp('/library/6650dddddddddddddddddddd');

    expect(await screen.findByText('Summary not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to library' })).toHaveAttribute('href', '/library');
  });

  test('never renders model output as HTML', async () => {
    const hostile = {
      ...COMPLETED_SOURCE,
      summary: { ...COMPLETED_SOURCE.summary, overview: '<img src=x onerror="alert(1)"> plain text overview here' },
    };
    sourceService.getSource.mockResolvedValue(hostile);
    const { container } = renderApp(`/library/${hostile.id}`);

    expect(await screen.findByText(/<img src=x onerror/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
