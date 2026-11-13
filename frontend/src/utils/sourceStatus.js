export const SOURCE_STATUS = {
  queued: { label: 'Queued', badge: 'neutral' },
  extracting: { label: 'Reading article', badge: 'brand' },
  preparing: { label: 'Preparing', badge: 'brand' },
  transcribing: { label: 'Transcribing', badge: 'brand' },
  summarizing: { label: 'Summarizing', badge: 'brand' },
  combining: { label: 'Combining', badge: 'brand' },
  completed: { label: 'Ready', badge: 'success' },
  failed: { label: 'Failed', badge: 'danger' },
};

export const IN_PROGRESS_STATUSES = ['queued', 'extracting', 'preparing', 'transcribing', 'summarizing', 'combining'];

export function isInProgress(status) {
  return IN_PROGRESS_STATUSES.includes(status);
}

export function statusLabel(status) {
  return SOURCE_STATUS[status]?.label ?? 'Unknown';
}

const ARTICLE_STEPS = [
  { id: 'queued', label: 'Queued', description: 'Waiting for a worker' },
  { id: 'extracting', label: 'Reading article', description: 'Fetching the page and extracting the text' },
  { id: 'summarizing', label: 'Summarizing', description: 'Writing the summary, takeaways and key concepts' },
  { id: 'completed', label: 'Ready', description: 'Your summary is ready' },
];

const VIDEO_STEPS = (kind) => [
  { id: 'queued', label: 'Queued', description: 'Waiting for a worker' },
  {
    id: 'preparing',
    label: kind === 'youtube' ? 'Checking the video' : 'Checking the file',
    description: kind === 'youtube' ? 'Reading video details and availability' : 'Reading the duration and audio track',
  },
  { id: 'transcribing', label: 'Transcribing', description: 'Turning the speech into a timed transcript' },
  { id: 'summarizing', label: 'Summarizing', description: 'Writing the summary, chapters and key moments' },
  { id: 'completed', label: 'Ready', description: 'Your summary is ready' },
];

function documentSteps(source) {
  const steps = [
    { id: 'queued', label: 'Queued', description: 'Waiting for a worker' },
    { id: 'extracting', label: 'Reading document', description: 'Extracting text and structure; scanned pages are read with text recognition' },
    { id: 'summarizing', label: 'Summarizing', description: 'Summarizing the document section by section' },
  ];
  if (source?.status === 'combining' || source?.document?.strategy === 'combine') {
    steps.push({ id: 'combining', label: 'Combining', description: 'Merging section notes into one coherent summary' });
  }
  steps.push({ id: 'completed', label: 'Ready', description: 'Your summary is ready' });
  return steps;
}

/** Ordered steps shown while a source is processed. */
export function processingSteps(kind = 'article', source = null) {
  if (kind === 'document') return documentSteps(source);
  return kind === 'youtube' || kind === 'video' ? VIDEO_STEPS(kind) : ARTICLE_STEPS;
}

/** Label for fine-grained progress within a step. */
export function progressLabel(progress) {
  if (!progress || !(progress.total > 1)) return null;
  const current = Math.min(progress.current + 1, progress.total);
  if (progress.stage === 'ocr') return `Scanned page ${current} of ${progress.total}`;
  if (progress.stage === 'chunks') return `Section ${current} of ${progress.total}`;
  return `Part ${current} of ${progress.total}`;
}


export const KIND_LABEL = { article: 'Article', youtube: 'YouTube video', video: 'Uploaded video', document: 'Document' };
