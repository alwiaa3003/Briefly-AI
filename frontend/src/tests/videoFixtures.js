/** Video API payloads for frontend tests (shapes match backend responses). */

const BASE_SUMMARY = {
  id: 'vsum1',
  title: 'How Urban Trees Cool Cities',
  overview: 'The talk explains how trees cool streets and why canopy is unevenly shared between districts.',
  sections: [{ heading: 'How trees cool streets', content: 'Shade and evapotranspiration lower temperatures.' }],
  keyTakeaways: ['Trees cool streets.', 'Canopy is unequal.', 'Protect mature trees.'],
  concepts: [{ term: 'Canopy', explanation: 'Tree cover over streets.' }],
  mainArguments: ['Cities should fund maintenance.'],
  chapters: [
    { title: 'Introduction', startSeconds: 0, endSeconds: 95, summary: 'The topic is introduced.' },
    { title: 'Unequal shade', startSeconds: 95, endSeconds: 3725, summary: 'Canopy differs between districts.' },
    { title: 'What cities should do', startSeconds: 3725, endSeconds: 3900, summary: 'Recommendations.' },
  ],
  keyMoments: [{ seconds: 150, description: 'The key statistic on canopy cover' }],
  inputTruncated: false,
  createdAt: '2026-11-10T09:05:00.000Z',
};

export const YOUTUBE_SOURCE = {
  id: '6660aaaaaaaaaaaaaaaaaaaa',
  kind: 'youtube',
  status: 'completed',
  submittedUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  metadata: { title: 'How Urban Trees Cool Cities', author: 'Science Channel', siteName: 'YouTube' },
  video: {
    platform: 'youtube',
    videoId: 'dQw4w9WgXcQ',
    channelTitle: 'Science Channel',
    thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    durationSeconds: 3900,
    publishedAt: '2025-03-01T10:00:00Z',
    captions: { available: true, manualLanguages: ['en'], autoLanguages: ['en', 'de'] },
  },
  upload: null,
  transcript: { available: true, wordCount: 1234, language: 'en', provider: 'gemini', hasSpeakerLabels: true },
  progress: null,
  error: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  completedAt: '2026-11-10T09:05:00.000Z',
  job: { id: 'j1', status: 'completed', attempts: 1, maxAttempts: 3 },
  summary: BASE_SUMMARY,
};

export const UPLOAD_SOURCE = {
  ...YOUTUBE_SOURCE,
  id: '6660bbbbbbbbbbbbbbbbbbbb',
  kind: 'video',
  submittedUrl: null,
  url: null,
  metadata: { title: 'Team sync' },
  video: { platform: 'upload', durationSeconds: 1800 },
  upload: { originalName: 'Team sync.mp4', container: 'mp4', sizeBytes: 52428800, durationSeconds: 1800, available: true },
  summary: { ...BASE_SUMMARY, title: 'Team sync' },
};

export const TRANSCRIPT = {
  id: 't1',
  origin: 'youtube_video',
  provider: 'gemini',
  language: 'en',
  wordCount: 30,
  hasSpeakerLabels: true,
  segments: [
    { start: 0, end: 12, text: 'Welcome. Today we look at urban trees.', speaker: 'Speaker 1' },
    { start: 95, end: 140, text: 'Lower-income districts have far less canopy.', speaker: null },
    { start: 150, end: 170, text: 'Canopy cover differs by thirty percent.', speaker: 'Speaker 2' },
  ],
};

export const TRANSCRIBING_SOURCE = {
  ...YOUTUBE_SOURCE,
  id: '6660cccccccccccccccccccc',
  status: 'transcribing',
  summary: null,
  completedAt: null,
  transcript: { available: false },
  progress: { current: 2, total: 7 },
  job: { id: 'j2', status: 'active', attempts: 1, maxAttempts: 3 },
};
