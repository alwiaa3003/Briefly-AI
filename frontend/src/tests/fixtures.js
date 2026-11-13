/** Realistic API payloads for frontend tests (shapes match backend responses). */

export const COMPLETED_SOURCE = {
  id: '6650aaaaaaaaaaaaaaaaaaaa',
  kind: 'article',
  status: 'completed',
  submittedUrl: 'https://gazette.example.com/science/urban-trees',
  url: 'https://gazette.example.com/science/urban-trees',
  canonicalUrl: 'https://gazette.example.com/science/urban-trees',
  metadata: {
    title: 'How Urban Trees Cool Cities',
    author: 'Priya Raman',
    publishedAt: '2025-06-14',
    siteName: 'The Example Gazette',
    wordCount: 920,
  },
  contentTruncated: false,
  error: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  completedAt: '2026-11-10T09:00:40.000Z',
  job: { id: 'job1', status: 'completed', attempts: 1, maxAttempts: 3 },
  summary: {
    id: 'sum1',
    title: 'How Urban Trees Cool Cities',
    overview: 'Neighbourhoods with dense canopy are consistently cooler. The benefit is unevenly shared.',
    sections: [
      { heading: 'How trees lower temperatures', content: 'Leaves block sunlight.\n\nEvapotranspiration draws heat from the air.' },
      { heading: 'Unequal access to shade', content: 'Lower-income districts have less canopy.' },
    ],
    keyTakeaways: ['Canopy cools streets.', 'Shade is unequal.', 'Young trees take a decade.'],
    concepts: [{ term: 'Evapotranspiration', explanation: 'Water released by leaves, which cools the air.' }],
    mainArguments: ['Urban forests are a cost-effective adaptation tool.'],
    inputTruncated: false,
    createdAt: '2026-11-10T09:00:40.000Z',
  },
};

export const PROCESSING_SOURCE = {
  ...COMPLETED_SOURCE,
  id: '6650bbbbbbbbbbbbbbbbbbbb',
  status: 'extracting',
  metadata: {},
  summary: null,
  completedAt: null,
  job: { id: 'job2', status: 'active', attempts: 1, maxAttempts: 3 },
};

export const FAILED_SOURCE = {
  ...PROCESSING_SOURCE,
  id: '6650cccccccccccccccccccc',
  status: 'failed',
  error: { code: 'ARTICLE_ACCESS_DENIED', message: 'The website refused access to this page. It may require a login or subscription.' },
  job: { id: 'job3', status: 'failed', attempts: 1, maxAttempts: 3 },
};

export function listItem(source, overrides = {}) {
  return {
    id: source.id,
    kind: 'article',
    status: source.status,
    url: source.url,
    title: source.summary?.title || source.metadata?.title || null,
    siteName: source.metadata?.siteName || null,
    overview: source.summary?.overview || null,
    error: source.error,
    createdAt: source.createdAt,
    ...overrides,
  };
}
