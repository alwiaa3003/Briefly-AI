/** Document API payloads for frontend tests (shapes match backend responses). */

export const PDF_SOURCE = {
  id: '6670bbbbbbbbbbbbbbbbbbbb',
  kind: 'document',
  status: 'completed',
  submittedUrl: null,
  url: null,
  metadata: { title: 'Urban Heat Report', author: 'Example Institute' },
  document: {
    format: 'pdf',
    pageCount: 12,
    pagesProcessed: 12,
    wordCount: 5400,
    author: 'Example Institute',
    created: '2025-03-01',
    ocrPages: [11, 12],
    ocrSkippedPages: [],
    truncated: false,
    warnings: [],
    strategy: 'direct',
    extractedAt: '2026-11-10T09:00:20.000Z',
  },
  upload: { originalName: 'urban-heat.pdf', container: 'pdf', sizeBytes: 2 * 1024 * 1024, available: true },
  transcript: { available: false },
  error: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  completedAt: '2026-11-10T09:01:00.000Z',
  job: { id: 'j1', status: 'completed', attempts: 1, maxAttempts: 3 },
  summary: {
    id: 'ds1',
    title: 'Urban Heat Report',
    overview: 'The report explains how urban trees cool cities and documents unequal canopy between districts.',
    sections: [{ heading: 'How trees cool cities', content: 'Shade and evapotranspiration lower temperatures.' }],
    sectionBreakdown: [
      { title: '1. Introduction', summary: 'Why urban heat matters.', pages: [1, 2], section: null },
      { title: '2. Findings', summary: 'Canopy differs sharply by income.', pages: [5], section: null },
    ],
    keyTakeaways: ['Trees cool streets.', 'Canopy is unequal.', 'Maintenance needs funding.'],
    concepts: [{ term: 'Evapotranspiration', explanation: 'Water released by leaves that cools the air.' }],
    facts: [{ statement: 'Canopy is 31% in wealthy districts and 12% elsewhere.', pages: [5, 6], section: null }],
    mainArguments: ['Cities should protect mature trees.'],
    references: {
      keyTakeaways: [{ pages: [2] }, { pages: [5] }, { pages: [] }],
      mainArguments: [{ pages: [9] }],
      concepts: [{ pages: [3] }],
    },
    inputTruncated: false,
    createdAt: '2026-11-10T09:01:00.000Z',
  },
};

export const DOCX_SOURCE = {
  ...PDF_SOURCE,
  id: '6670cccccccccccccccccccc',
  metadata: { title: 'Quarterly Review' },
  document: { ...PDF_SOURCE.document, format: 'docx', pageCount: null, pagesProcessed: null, ocrPages: [] },
  upload: { originalName: 'review.docx', container: 'docx', sizeBytes: 40000, available: true },
  summary: {
    ...PDF_SOURCE.summary,
    title: 'Quarterly Review',
    sectionBreakdown: [{ title: 'Outlook', summary: 'Growth slows to 8 percent.', pages: [], section: 'Outlook' }],
    facts: [],
    references: { keyTakeaways: [{ pages: [], section: 'Summary' }, { pages: [] }, { pages: [] }], mainArguments: [], concepts: [] },
  },
};

export const PDF_TEXT = {
  parts: [
    { index: 0, page: 1, headingPath: [], blocks: [{ kind: 'heading', level: 1, text: 'Urban Heat Report' }, { kind: 'paragraph', text: 'Intro text.' }], ocr: false },
    { index: 1, page: 2, headingPath: ['Urban Heat Report'], blocks: [{ kind: 'table', text: 'City | Canopy\nA | 31%' }], ocr: false },
    { index: 2, page: 3, headingPath: ['Urban Heat Report'], blocks: [{ kind: 'paragraph', text: 'Scanned page text.' }], ocr: true },
  ],
  page: 1,
  limit: 50,
  total: 3,
  totalPages: 1,
};

export const DOCX_TEXT = {
  parts: [
    { index: 0, page: null, headingPath: [], blocks: [{ kind: 'heading', level: 1, text: 'Summary' }, { kind: 'paragraph', text: 'Revenue grew.' }], ocr: false },
    { index: 1, page: null, headingPath: ['Outlook'], blocks: [{ kind: 'paragraph', text: 'Growth slows to 8 percent.' }], ocr: false },
  ],
  page: 1,
  limit: 50,
  total: 2,
  totalPages: 1,
};
