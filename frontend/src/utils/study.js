/** Labels and helpers shared by the Ask AI and study-tool screens. */

export const SUMMARY_STYLES = [
  { id: 'standard', label: 'Standard', description: 'The original summary' },
  { id: 'concise', label: 'Concise', description: 'Only the essentials' },
  { id: 'detailed', label: 'Detailed', description: 'All major points and evidence' },
  { id: 'bullet_points', label: 'Bullet points', description: 'Crisp lists, no prose' },
  { id: 'academic', label: 'Academic', description: 'Formal and precise' },
  { id: 'beginner', label: 'Beginner friendly', description: 'Plain language, terms explained' },
  { id: 'technical', label: 'Technical', description: 'Mechanisms, numbers and methods' },
  { id: 'exam_revision', label: 'Exam revision', description: 'What to remember' },
];

export const DIFFICULTIES = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
];

export const QUESTION_TYPES = [
  { id: 'multiple_choice', label: 'Multiple choice' },
  { id: 'true_false', label: 'True / false' },
  { id: 'short_answer', label: 'Short answer' },
];

export const isGenerating = (item) => item && (item.status === 'queued' || item.status === 'generating');

/** "p. 4", "12:30", "Methods" — whatever location a reference has. */
export function refLabel(ref) {
  if (!ref) return '';
  return ref.label || (ref.page ? `p. ${ref.page}` : ref.section || '');
}

const list = (title, items, render) =>
  items?.length ? [`## ${title}`, '', ...items.map(render), ''] : [];
const withRefs = (text, refs) => {
  const labels = (refs || []).map(refLabel).filter(Boolean);
  return labels.length ? `${text} (${labels.join(', ')})` : text;
};

/** Study notes as Markdown (copy / export). */
export function notesToMarkdown(notes, sourceTitle) {
  return [
    `# ${notes.title || sourceTitle || 'Study notes'}`,
    '',
    notes.overview || '',
    '',
    ...list('Key concepts', notes.keyConcepts, (t) => `- **${t.term}**: ${withRefs(t.explanation, t.refs)}`),
    ...list('Definitions', notes.definitions, (t) => `- **${t.term}**: ${withRefs(t.explanation, t.refs)}`),
    ...list('Key facts', notes.keyFacts, (i) => `- ${withRefs(i.text, i.refs)}`),
    ...list('Examples', notes.examples, (i) => `- ${withRefs(i.text, i.refs)}`),
    ...list('Formulas and technical details', notes.formulas, (i) => `- ${withRefs(i.text, i.refs)}`),
    ...list('Revision points', notes.revisionPoints, (i) => `- ${withRefs(i.text, i.refs)}`),
    ...list('Background (not from the source)', notes.externalKnowledge, (t) => `- ${t}`),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function styledSummaryToMarkdown(item) {
  return [
    `# ${item.title}`,
    '',
    item.overview,
    '',
    ...(item.sections || []).flatMap((s) => [`## ${s.heading}`, '', s.content, '']),
    ...list('Key points', item.keyPoints, (p) => `- ${p}`),
  ]
    .join('\n')
    .trim();
}

/** Triggers a browser download of a text file. */
export function downloadText(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slugify(value) {
  return (
    String(value || 'notes')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'notes'
  );
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
