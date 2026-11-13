'use strict';

const ApiError = require('./ApiError');

/**
 * Accepts the YouTube link formats people actually paste and extracts the
 * 11-character video id. Mirrors processing-service/app/extractors/youtube.py.
 *
 *   https://www.youtube.com/watch?v=ID  (also m., music.)
 *   https://youtu.be/ID
 *   https://www.youtube.com/shorts/ID | /embed/ID | /live/ID | /v/ID
 *   https://www.youtube-nocookie.com/embed/ID
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const PATH_PREFIXES = new Set(['embed', 'shorts', 'live', 'v', 'e']);

function invalid(message = 'Enter a valid YouTube video link, such as https://www.youtube.com/watch?v=…') {
  return ApiError.badRequest(message, 'INVALID_YOUTUBE_URL');
}

/** @returns {{ videoId: string, url: string, normalizedUrl: string }} */
function parseYouTubeUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw invalid();
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw invalid();
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw invalid();

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let candidate = null;

  if (SHORT_HOSTS.has(host)) {
    candidate = segments[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === 'watch') candidate = url.searchParams.get('v');
    else if (segments.length >= 2 && PATH_PREFIXES.has(segments[0])) candidate = segments[1];
    else if (segments[0] === 'playlist') throw invalid('Playlists are not supported. Paste a link to a single video.');
    else if (segments[0]?.startsWith('@') || segments[0] === 'channel') {
      throw invalid('That is a channel link. Paste a link to a single video.');
    }
  } else {
    throw invalid('This is not a YouTube link.');
  }

  if (!candidate || !VIDEO_ID.test(candidate)) throw invalid();
  return {
    videoId: candidate,
    url: `https://www.youtube.com/watch?v=${candidate}`,
    normalizedUrl: `youtube:${candidate}`,
  };
}

module.exports = { parseYouTubeUrl, VIDEO_ID };
