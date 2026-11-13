import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import { TRANSCRIPT, UPLOAD_SOURCE, YOUTUBE_SOURCE } from './videoFixtures';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';
import { summaryToMarkdown } from '../utils/summaryMarkdown';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

beforeAll(() => {
  // jsdom has no media playback; record seeks instead.
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() {
      return this._currentTime || 0;
    },
    set(value) {
      this._currentTime = value;
    },
  });
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});

beforeEach(() => {
  vi.clearAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
  sourceService.getTranscript.mockResolvedValue(TRANSCRIPT);
});

function iframeSrc() {
  return new URL(screen.getByTitle(/YouTube video/).getAttribute('src'));
}

describe('YouTube summary page', () => {
  beforeEach(() => sourceService.getSource.mockResolvedValue(YOUTUBE_SOURCE));

  test('shows metadata, overview, chapters, key moments and the embedded video', async () => {
    renderApp(`/library/${YOUTUBE_SOURCE.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'How Urban Trees Cool Cities' })).toBeInTheDocument();
    expect(screen.getByText('YouTube video')).toBeInTheDocument();
    expect(screen.getByText('Science Channel')).toBeInTheDocument();
    expect(screen.getByText('1 h 5 min')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open on YouTube/ })).toHaveAttribute('href', YOUTUBE_SOURCE.url);

    expect(iframeSrc().origin).toBe('https://www.youtube-nocookie.com');
    expect(iframeSrc().pathname).toBe('/embed/dQw4w9WgXcQ');

    const chapters = screen.getByRole('heading', { name: 'Chapters' }).closest('section');
    expect(within(chapters).getAllByRole('listitem')).toHaveLength(3);
    expect(within(chapters).getByRole('button', { name: 'Play from 1:02:05' })).toBeInTheDocument();
    expect(screen.getByText('The key statistic on canopy cover')).toBeInTheDocument();
    expect(screen.getByText(/YouTube lists captions: creator-provided \(en\); auto-generated \(en, de\)/)).toBeInTheDocument();
  });

  test('clicking a chapter timestamp plays the video from that time', async () => {
    const { user } = renderApp(`/library/${YOUTUBE_SOURCE.id}`);
    await screen.findByRole('heading', { level: 1, name: 'How Urban Trees Cool Cities' });
    expect(iframeSrc().searchParams.get('start')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Play from 1:02:05' }));

    expect(iframeSrc().searchParams.get('start')).toBe('3725');
    expect(iframeSrc().searchParams.get('autoplay')).toBe('1');
  });

  test('transcript viewer: honest origin note, search with highlighting, seek from a line', async () => {
    const { user } = renderApp(`/library/${YOUTUBE_SOURCE.id}`);

    const transcript = await screen.findByRole('list', { name: 'Transcript lines' });
    expect(within(transcript).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText(/not YouTube's captions/)).toBeInTheDocument();
    expect(sourceService.getTranscript).toHaveBeenCalledWith(YOUTUBE_SOURCE.id);

    await user.type(screen.getByLabelText('Search transcript'), 'canopy');
    expect(within(transcript).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('2 matching lines')).toBeInTheDocument();
    expect(transcript.querySelectorAll('mark')).toHaveLength(2);

    await user.click(within(transcript).getByRole('button', { name: 'Play from 2:30' }));
    expect(iframeSrc().searchParams.get('start')).toBe('150');

    await user.clear(screen.getByLabelText('Search transcript'));
    await user.type(screen.getByLabelText('Search transcript'), 'zebra');
    expect(screen.getByText('No lines match “zebra”.')).toBeInTheDocument();
  });

  test('copies the summary as Markdown, including chapters and key moments with timestamps', async () => {
    const { user } = renderApp(`/library/${YOUTUBE_SOURCE.id}`);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

    await user.click(await screen.findByRole('button', { name: 'Copy summary' }));

    const markdown = writeText.mock.calls[0][0];
    expect(markdown).toBe(summaryToMarkdown(YOUTUBE_SOURCE));
    expect(markdown).toContain('- **1:02:05** What cities should do: Recommendations.');
    expect(markdown).toContain('- **2:30** The key statistic on canopy cover');
  });

  test('does not offer a transcript when none exists', async () => {
    sourceService.getSource.mockResolvedValue({ ...YOUTUBE_SOURCE, transcript: { available: false } });
    renderApp(`/library/${YOUTUBE_SOURCE.id}`);

    await screen.findByRole('heading', { name: 'Chapters' });
    expect(screen.queryByRole('heading', { name: 'Transcript' })).not.toBeInTheDocument();
    expect(sourceService.getTranscript).not.toHaveBeenCalled();
  });
});

describe('Uploaded video summary page', () => {
  test('plays the private file from a signed URL and seeks on timestamp clicks', async () => {
    sourceService.getSource.mockResolvedValue(UPLOAD_SOURCE);
    sourceService.getPlayback.mockResolvedValue({ url: 'https://acct.r2.example/videos/x?X-Amz-Signature=abc', expiresAt: '2026-11-10T10:00:00Z' });
    const { user, container } = renderApp(`/library/${UPLOAD_SOURCE.id}`);

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', 'https://acct.r2.example/videos/x?X-Amz-Signature=abc');
    expect(sourceService.getPlayback).toHaveBeenCalledWith(UPLOAD_SOURCE.id);
    expect(screen.getByText('Uploaded video')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open original/ })).not.toBeInTheDocument();
    expect(screen.getByText('Team sync.mp4 · 50.0 MB')).toBeInTheDocument();

    const chapters = screen.getByRole('heading', { name: 'Chapters' }).closest('section');
    await user.click(within(chapters).getByRole('button', { name: 'Play from 1:35' }));
    expect(video.currentTime).toBe(95);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  test('explains when the original file has been removed after the retention period', async () => {
    sourceService.getSource.mockResolvedValue(UPLOAD_SOURCE);
    sourceService.getPlayback.mockRejectedValue(
      apiError(410, 'UPLOAD_EXPIRED', 'The original video file was removed after 7 days. The transcript and summary are still available.')
    );
    renderApp(`/library/${UPLOAD_SOURCE.id}`);

    expect(await screen.findByText(/original video file was removed after 7 days/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chapters' })).toBeInTheDocument();
  });

  test('failed upload whose file is gone asks for a new upload instead of a retry', async () => {
    sourceService.getSource.mockResolvedValue({
      ...UPLOAD_SOURCE,
      status: 'failed',
      summary: null,
      error: { code: 'VIDEO_TOO_LONG', message: 'This video is longer than the 180-minute limit.' },
      upload: { ...UPLOAD_SOURCE.upload, available: false },
    });
    renderApp(`/library/${UPLOAD_SOURCE.id}`);

    expect(await screen.findByText('This video could not be summarized')).toBeInTheDocument();
    expect(screen.getByText('This video is longer than the 180-minute limit.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upload a video' })).toHaveAttribute('href', '/summarize?source=upload');
  });

  test('failed upload with the file still available can be retried', async () => {
    sourceService.getSource.mockResolvedValue({
      ...UPLOAD_SOURCE,
      status: 'failed',
      summary: null,
      error: { code: 'AI_UNAVAILABLE', message: 'The AI service is temporarily unavailable.' },
    });
    sourceService.retrySource.mockResolvedValue({ source: UPLOAD_SOURCE, job: { id: 'j' } });
    const { user } = renderApp(`/library/${UPLOAD_SOURCE.id}`);

    await user.click(await screen.findByRole('button', { name: /Try again/ }));
    expect(sourceService.retrySource).toHaveBeenCalledWith(UPLOAD_SOURCE.id);
  });
});
