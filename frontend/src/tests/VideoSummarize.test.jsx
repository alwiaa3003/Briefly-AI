import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import { TRANSCRIBING_SOURCE, UPLOAD_SOURCE } from './videoFixtures';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

const ENABLED = { enabled: true, maxBytes: 100 * 1024 * 1024, maxDurationMinutes: 180, retentionDays: 7 };

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
  sourceService.getSource.mockResolvedValue(TRANSCRIBING_SOURCE);
  sourceService.getUploadConfig.mockResolvedValue(ENABLED);
});

function videoFile(name = 'Team sync.mp4', type = 'video/mp4', size = 2048) {
  const file = new File([new Uint8Array(16)], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('YouTube tab', () => {
  test.each([
    ['', 'Enter a YouTube link.'],
    ['youtube.com/watch?v=dQw4w9WgXcQ', 'Enter a full link starting with https://.'],
    ['https://vimeo.com/12345', 'This is not a YouTube link.'],
    ['https://www.youtube.com/playlist?list=PL1', 'Playlists are not supported. Paste a link to a single video.'],
    ['https://www.youtube.com/@channel', 'That is a channel link. Paste a link to a single video.'],
    ['https://www.youtube.com/watch?v=short', 'This does not look like a valid YouTube video link.'],
  ])('validates %p', async (url, message) => {
    const { user } = renderApp('/summarize?source=youtube');
    const input = await screen.findByLabelText('YouTube video URL');
    if (url) await user.type(input, url);
    await user.click(screen.getByRole('button', { name: /Summarize video/ }));

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(sourceService.submitYouTube).not.toHaveBeenCalled();
  });

  test('previews a valid link from its video id', async () => {
    const { user } = renderApp('/summarize?source=youtube');
    await user.type(await screen.findByLabelText('YouTube video URL'), 'https://youtu.be/dQw4w9WgXcQ?t=5');

    const thumbnail = screen.getByAltText('Video thumbnail');
    expect(thumbnail).toHaveAttribute('src', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(screen.getByText('ID dQw4w9WgXcQ')).toBeInTheDocument();
  });

  test('submits and opens the processing page with transcription progress', async () => {
    sourceService.submitYouTube.mockResolvedValue({ source: TRANSCRIBING_SOURCE, job: { id: 'j' }, duplicate: false });
    const { user } = renderApp('/summarize?source=youtube');

    await user.type(await screen.findByLabelText('YouTube video URL'), 'https://www.youtube.com/shorts/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: /Summarize video/ }));

    expect(sourceService.submitYouTube).toHaveBeenCalledWith('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    expect(await screen.findByText('Working on your summary')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Transcribing');
    expect(screen.getByRole('progressbar', { name: 'Transcription progress' })).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText('Part 3 of 7')).toBeInTheDocument();
  });

  test('shows server-side rejections on the field', async () => {
    sourceService.submitYouTube.mockRejectedValue(apiError(400, 'INVALID_YOUTUBE_URL', 'Enter a valid YouTube video link.'));
    const { user } = renderApp('/summarize?source=youtube');

    await user.type(await screen.findByLabelText('YouTube video URL'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: /Summarize video/ }));

    expect(await screen.findByText('Enter a valid YouTube video link.')).toBeInTheDocument();
  });
});

describe('Upload tab', () => {
  test('explains the setup requirement when storage is not configured', async () => {
    sourceService.getUploadConfig.mockResolvedValue({ ...ENABLED, enabled: false });
    renderApp('/summarize?source=upload');

    expect(await screen.findByText("Video uploads aren't set up on this server")).toBeInTheDocument();
    expect(screen.getByLabelText('Choose a video file')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Upload and summarize/ })).toBeDisabled();
  });

  test.each([
    ['notes.pdf', 'application/pdf', 1000, 'Choose an MP4, MOV, WEBM or MKV video file.'],
    ['clip.avi', 'video/x-msvideo', 1000, 'Choose an MP4, MOV, WEBM or MKV video file.'],
    ['photo.mp4', 'image/png', 1000, 'This file does not look like a video.'],
    ['empty.mp4', 'video/mp4', 0, 'The file is empty.'],
    ['huge.mp4', 'video/mp4', 200 * 1024 * 1024, 'The file is 200.0 MB; the limit is 100.0 MB.'],
  ])('rejects %s before uploading', async (name, type, size, message) => {
    renderApp('/summarize?source=upload');
    await screen.findByLabelText('Choose a video file');
    // Dropped files bypass the input's accept filter, so validation must catch them.
    const dropzone = screen.getByText('Drop a video here, or click to browse').closest('label');
    fireEvent.drop(dropzone, { dataTransfer: { files: [videoFile(name, type, size)] } });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload and summarize/ })).toBeDisabled();
    expect(sourceService.uploadVideo).not.toHaveBeenCalled();
  });

  test('uploads with progress, then opens the summary page', async () => {
    let finish;
    sourceService.uploadVideo.mockImplementation((file, { onProgress }) => {
      onProgress(0.42);
      return new Promise((resolve) => (finish = resolve));
    });
    sourceService.getSource.mockResolvedValue({ ...UPLOAD_SOURCE, status: 'preparing', summary: null, transcript: { available: false } });
    const { user } = renderApp('/summarize?source=upload');

    await user.upload(await screen.findByLabelText('Choose a video file'), videoFile());
    expect(screen.getByText('Team sync.mp4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Upload and summarize/ }));

    expect(await screen.findByRole('progressbar', { name: 'Upload progress' })).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('Uploading… 42%')).toBeInTheDocument();
    expect(sourceService.uploadVideo.mock.calls[0][0].name).toBe('Team sync.mp4');

    finish({ source: UPLOAD_SOURCE, job: { id: 'j' }, duplicate: false });
    expect(await screen.findByText('Video uploaded')).toBeInTheDocument();
    expect(await screen.findByText('Checking the file')).toBeInTheDocument();
  });

  test('can cancel an upload in progress', async () => {
    sourceService.uploadVideo.mockImplementation(
      (file, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })));
        })
    );
    const { user } = renderApp('/summarize?source=upload');

    await user.upload(await screen.findByLabelText('Choose a video file'), videoFile());
    await user.click(screen.getByRole('button', { name: /Upload and summarize/ }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Upload cancelled')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Upload and summarize/ })).toBeEnabled());
  });

  test('shows server-side file rejections next to the file', async () => {
    sourceService.uploadVideo.mockRejectedValue(
      apiError(415, 'UNSUPPORTED_VIDEO_TYPE', 'The file content is not a valid MP4, MOV, WEBM or MKV video.')
    );
    const { user } = renderApp('/summarize?source=upload');

    await user.upload(await screen.findByLabelText('Choose a video file'), videoFile('renamed.mp4'));
    await user.click(screen.getByRole('button', { name: /Upload and summarize/ }));

    expect(await screen.findByText('The file content is not a valid MP4, MOV, WEBM or MKV video.')).toBeInTheDocument();
  });
});
