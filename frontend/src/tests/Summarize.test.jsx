import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import { COMPLETED_SOURCE, PROCESSING_SOURCE } from './fixtures';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
  sourceService.getSource.mockResolvedValue(PROCESSING_SOURCE);
});

async function typeUrl(user, url) {
  const input = await screen.findByLabelText('Article URL', { selector: 'input' });
  await user.clear(input);
  if (url) await user.type(input, url);
  return input;
}

describe('Article URL submission', () => {
  test.each([
    ['', 'Enter an article URL.'],
    ['example.com/article', 'Enter a full URL starting with http:// or https://.'],
    ['ftp://example.com/file', 'Only http:// and https:// links are supported.'],
    ['http://localhost:3000/admin', 'Only standard web ports (80 and 443) are allowed.'],
    ['http://192.168.1.4/router', 'Links to local or private network addresses are not allowed.'],
    ['https://user:pw@example.com/', 'URLs containing usernames or passwords are not allowed.'],
  ])('validates %p before submitting', async (url, message) => {
    const { user } = renderApp('/summarize');
    await typeUrl(user, url);
    await user.click(screen.getByRole('button', { name: /Summarize article/ }));

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(sourceService.submitArticle).not.toHaveBeenCalled();
  });

  test('submits a valid URL and opens the summary page', async () => {
    sourceService.submitArticle.mockResolvedValue({ source: PROCESSING_SOURCE, job: { id: 'j' }, duplicate: false });
    const { user } = renderApp('/summarize');

    await typeUrl(user, '  https://gazette.example.com/science/urban-trees  ');
    await user.click(screen.getByRole('button', { name: /Summarize article/ }));

    expect(sourceService.submitArticle).toHaveBeenCalledWith('https://gazette.example.com/science/urban-trees');
    expect(await screen.findByText('Working on your summary')).toBeInTheDocument();
    expect(screen.getByText('Article submitted')).toBeInTheDocument();
    expect(sourceService.getSource).toHaveBeenCalledWith(PROCESSING_SOURCE.id);
  });

  test('prevents duplicate submissions while a request is in flight', async () => {
    let resolve;
    sourceService.submitArticle.mockReturnValue(new Promise((r) => (resolve = r)));
    const { user } = renderApp('/summarize');

    await typeUrl(user, 'https://gazette.example.com/a');
    const button = screen.getByRole('button', { name: /Summarize article/ });
    await user.click(button);

    const busy = screen.getByRole('button', { name: /Submitting/ });
    expect(busy).toBeDisabled();
    expect(screen.getByLabelText('Article URL', { selector: 'input' })).toBeDisabled();
    await user.click(busy);
    expect(sourceService.submitArticle).toHaveBeenCalledTimes(1);

    resolve({ source: PROCESSING_SOURCE, job: null, duplicate: false });
    expect(await screen.findByText('Working on your summary')).toBeInTheDocument();
  });

  test('a duplicate URL opens the existing summary', async () => {
    sourceService.submitArticle.mockResolvedValue({ source: COMPLETED_SOURCE, job: null, duplicate: true });
    sourceService.getSource.mockResolvedValue(COMPLETED_SOURCE);
    const { user } = renderApp('/summarize');

    await typeUrl(user, 'https://gazette.example.com/science/urban-trees');
    await user.click(screen.getByRole('button', { name: /Summarize article/ }));

    expect(await screen.findByText('Already in your library')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'How Urban Trees Cool Cities' })).toBeInTheDocument();
  });

  test('shows server-side URL rejections on the field', async () => {
    sourceService.submitArticle.mockRejectedValue(
      apiError(400, 'UNSAFE_URL', 'Links to local or internal hosts are not allowed.')
    );
    const { user } = renderApp('/summarize');

    const input = await typeUrl(user, 'https://intranet.example.com/page');
    await user.click(screen.getByRole('button', { name: /Summarize article/ }));

    expect(await screen.findByText('Links to local or internal hosts are not allowed.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: /Summarize article/ })).toBeEnabled();
  });

  test('shows other failures (rate limit, outage) as a form error', async () => {
    sourceService.submitArticle.mockRejectedValue(
      apiError(429, 'RATE_LIMITED', 'You have reached the hourly limit for new summaries. Please try again later.')
    );
    const { user } = renderApp('/summarize');

    await typeUrl(user, 'https://gazette.example.com/a');
    await user.click(screen.getByRole('button', { name: /Summarize article/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('hourly limit');
  });
});
