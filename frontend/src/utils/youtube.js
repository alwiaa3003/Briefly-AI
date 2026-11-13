/** Client-side YouTube link parsing (mirrors backend/src/utils/youtubeUrl.js). */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const PREFIXES = new Set(['embed', 'shorts', 'live', 'v', 'e']);

/** Returns { videoId } or { error } with a user-facing message. */
export function parseYouTubeLink(value) {
  const trimmed = value.trim();
  if (!trimmed) return { error: 'Enter a YouTube link.' };
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: 'Enter a full link starting with https://.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'Enter a full link starting with https://.' };

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (SHORT_HOSTS.has(host)) id = segments[0];
  else if (HOSTS.has(host)) {
    if (segments[0] === 'watch') id = url.searchParams.get('v');
    else if (segments.length >= 2 && PREFIXES.has(segments[0])) id = segments[1];
    else if (segments[0] === 'playlist') return { error: 'Playlists are not supported. Paste a link to a single video.' };
    else if (segments[0]?.startsWith('@') || segments[0] === 'channel') {
      return { error: 'That is a channel link. Paste a link to a single video.' };
    }
  } else {
    return { error: 'This is not a YouTube link.' };
  }
  return id && VIDEO_ID.test(id) ? { videoId: id } : { error: 'This does not look like a valid YouTube video link.' };
}

export function youtubeThumbnail(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** Privacy-enhanced embed; `start` in whole seconds. */
export function youtubeEmbedUrl(videoId, { start = 0, autoplay = false } = {}) {
  const params = new URLSearchParams({ rel: '0', modestbranding: '1' });
  if (start > 0) params.set('start', String(Math.floor(start)));
  if (autoplay) params.set('autoplay', '1');
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params}`;
}

export function youtubeWatchUrl(videoId, start = 0) {
  return `https://www.youtube.com/watch?v=${videoId}${start > 0 ? `&t=${Math.floor(start)}s` : ''}`;
}
