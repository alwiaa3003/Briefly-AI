'use strict';

const { parseYouTubeUrl } = require('../src/utils/youtubeUrl');
const { detectContainer, containersCompatible, sanitizeFilename, containerFromFilename, mimeAllowed, titleFromFilename } =
  require('../src/utils/videoFile');
const bytes = require('./helpers/videoBytes');

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeUrl', () => {
  test.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL1`,
    `http://m.youtube.com/watch?feature=share&v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc&t=10`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}?start=5`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
  ])('accepts %s', (url) => {
    expect(parseYouTubeUrl(url)).toEqual({
      videoId: ID,
      url: `https://www.youtube.com/watch?v=${ID}`,
      normalizedUrl: `youtube:${ID}`,
    });
  });

  test.each([
    ['', /valid YouTube video link/],
    ['not a url', /valid YouTube video link/],
    ['https://www.youtube.com/', /valid YouTube video link/],
    ['https://www.youtube.com/watch?v=short', /valid YouTube video link/],
    ['https://www.youtube.com/playlist?list=PL123', /Playlists are not supported/],
    ['https://www.youtube.com/@somechannel', /channel link/],
    [`https://vimeo.com/${ID}`, /not a YouTube link/],
    [`https://youtube.com.evil.example/watch?v=${ID}`, /not a YouTube link/],
    [`ftp://youtube.com/watch?v=${ID}`, /valid YouTube video link/],
    [`https://user:pw@www.youtube.com/watch?v=${ID}`, /valid YouTube video link/],
  ])('rejects %p', (url, message) => {
    expect(() => parseYouTubeUrl(url)).toThrow(expect.objectContaining({ code: 'INVALID_YOUTUBE_URL', statusCode: 400 }));
    expect(() => parseYouTubeUrl(url)).toThrow(message);
  });
});

describe('video file validation', () => {
  test.each([
    ['mp4', bytes.mp4(), 'mp4'],
    ['mov', bytes.mov(), 'mov'],
    ['webm', bytes.webm(), 'webm'],
    ['mkv', bytes.mkv(), 'mkv'],
  ])('detects %s by signature', (_name, buffer, expected) => {
    expect(detectContainer(buffer)).toBe(expected);
  });

  test.each([
    ['PNG image', bytes.png()],
    ['M4A audio', bytes.m4a()],
    ['HTML/script', bytes.html()],
    ['HLS playlist', bytes.m3u8()],
    ['too short', Buffer.from([0, 0, 0])],
    ['not a buffer', 'ftypisom'],
  ])('rejects %s', (_name, buffer) => {
    expect(detectContainer(buffer)).toBeNull();
  });

  test('mp4/mov are interchangeable, other containers are not', () => {
    expect(containersCompatible('mp4', 'mov')).toBe(true);
    expect(containersCompatible('mov', 'mp4')).toBe(true);
    expect(containersCompatible('webm', 'mkv')).toBe(false);
    expect(containersCompatible('mp4', 'webm')).toBe(false);
  });

  test.each([
    ['../../etc/passwd.mp4', 'passwd.mp4'],
    ['C:\\Users\\me\\Videos\\talk.mov', 'talk.mov'],
    ['bad<name>:"|?*.webm', 'bad_name_.webm'],
    ['line\nbreak\u0000.mkv', 'line_break_.mkv'],
    ['', 'video'],
  ])('sanitizes filename %p', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  test('container and MIME allowlists', () => {
    expect(containerFromFilename('Talk.MP4')).toBe('mp4');
    expect(containerFromFilename('clip.m4v')).toBe('mp4');
    expect(containerFromFilename('notes.pdf')).toBeNull();
    expect(containerFromFilename('video.mp4.exe')).toBeNull();
    expect(mimeAllowed('mp4', 'video/mp4')).toBe(true);
    expect(mimeAllowed('mkv', 'application/octet-stream')).toBe(true);
    expect(mimeAllowed('mp4', 'image/png')).toBe(false);
    expect(mimeAllowed('webm', 'video/mp4')).toBe(false);
  });

  test('titles are derived from filenames', () => {
    expect(titleFromFilename('team_sync-2025-03.mp4')).toBe('team sync 2025 03');
  });
});
