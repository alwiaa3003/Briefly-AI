import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER } from './renderApp';
import { COMPLETED_SOURCE } from './fixtures';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';
import * as aiService from '../services/aiService';
import { notesToMarkdown } from '../utils/study';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

const PREFS = { summaryStyle: 'standard', quizDifficulty: 'medium', quizQuestionCount: 10, quizQuestionTypes: ['multiple_choice', 'true_false', 'short_answer'], flashcardCount: 20 };
const ref = { label: 'p. 4', page: 4, section: null, startSeconds: null };
const NOTES = {
  id: 'n1',
  status: 'completed',
  title: 'Urban Trees',
  overview: 'Trees cool cities through shade.',
  keyConcepts: [{ term: 'Canopy', explanation: 'Tree cover over streets.', refs: [ref] }],
  definitions: [],
  keyFacts: [{ text: 'Streets are 2 degrees cooler.', refs: [] }],
  examples: [],
  formulas: [],
  revisionPoints: [{ text: 'Shade matters.', refs: [ref] }],
  externalKnowledge: ['Trees also store carbon.'],
  generatedAt: '2026-11-10T10:00:00.000Z',
};
const QUIZ = {
  id: 'q1',
  status: 'completed',
  title: 'Urban Trees quiz',
  difficulty: 'medium',
  createdAt: '2026-11-10T10:00:00.000Z',
  bestScore: null,
  questions: [
    { id: 'q1', type: 'multiple_choice', question: 'What cools streets?', options: ['Trees', 'Cars', 'Glass'] },
    { id: 'q2', type: 'true_false', question: 'Shade is shared equally.', options: [] },
    { id: 'q3', type: 'short_answer', question: 'Name the cooling process.', options: [] },
  ],
};
const REVIEW = {
  attempt: { id: 'a1', score: 2, total: 3 },
  questions: [
    { ...QUIZ.questions[0], correctOption: 0, explanation: 'Trees give shade.', refs: [ref], response: 0, correct: true },
    { ...QUIZ.questions[1], correctBoolean: false, explanation: 'It is unequal.', refs: [], response: true, correct: false },
    { ...QUIZ.questions[2], acceptedAnswers: ['evapotranspiration'], explanation: 'Leaves release vapour.', refs: [], response: 'evapotranspiration', correct: true },
  ],
};
const DECK = {
  id: 'd1',
  status: 'completed',
  generatedAt: '2026-11-10T10:00:00.000Z',
  cards: [
    { id: 'f1', front: 'What is canopy?', back: 'Tree cover.', refs: [ref], review: { status: 'new', reviews: 0 } },
    { id: 'f2', front: 'What cools air?', back: 'Evapotranspiration.', refs: [], review: { status: 'new', reviews: 0 } },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
  sourceService.getSource.mockResolvedValue(COMPLETED_SOURCE);
  aiService.getPreferences.mockResolvedValue(PREFS);
  aiService.listConversations.mockResolvedValue({ items: [] });
});

afterEach(() => vi.useRealTimers());

const open = (tab) => renderApp(`/library/${COMPLETED_SOURCE.id}${tab ? `?tab=${tab}` : ''}`);

describe('Source workspace', () => {
  test('a completed source shows the workspace tabs with the summary first', async () => {
    const { user } = open();
    const tabs = await screen.findByRole('tablist', { name: 'Source workspace' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Summary', 'Ask AI', 'Study notes', 'Quiz', 'Flashcards']);
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Key takeaways' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Ask AI' }));
    expect(await screen.findByText('Ask about this source')).toBeInTheDocument();
    expect(aiService.listConversations).toHaveBeenCalledWith({ sourceId: COMPLETED_SOURCE.id, limit: 20 });
  });

  test('asking about a source creates a source-scoped conversation', async () => {
    aiService.createConversation.mockResolvedValue({ id: 'c1', scope: 'source', title: 'New conversation' });
    aiService.sendMessage.mockResolvedValue({
      conversation: { id: 'c1', scope: 'source', title: 'Main argument?' },
      messages: [
        { id: 'u', role: 'user', content: 'Main argument?' },
        { id: 'a', role: 'assistant', content: 'Urban forests pay off.', support: 'partial', citations: [], followUps: [] },
      ],
    });
    const { user } = open('ask');
    await user.type(await screen.findByLabelText('Your question'), 'Main argument?{Enter}');
    expect(await screen.findByText('Urban forests pay off.')).toBeInTheDocument();
    expect(aiService.createConversation).toHaveBeenCalledWith({ scope: 'source', sourceId: COMPLETED_SOURCE.id });
    expect(screen.getByText('Partly answered by the source')).toBeInTheDocument();
  });

  test('summary styles are generated on selection without reprocessing', async () => {
    aiService.getSummaryStyle.mockResolvedValue(null);
    aiService.generateSummaryStyle.mockResolvedValue({
      id: 's1',
      status: 'completed',
      style: 'beginner',
      title: 'Trees, simply',
      overview: 'Trees make streets cooler.',
      sections: [{ heading: 'Why', content: 'Shade blocks the sun.' }],
      keyPoints: ['Shade helps.'],
    });
    const { user } = open();
    await user.selectOptions(await screen.findByLabelText('Style'), 'beginner');
    expect(await screen.findByRole('heading', { name: 'Trees, simply' })).toBeInTheDocument();
    expect(aiService.generateSummaryStyle).toHaveBeenCalledWith(COMPLETED_SOURCE.id, 'beginner', { regenerate: false });
    expect(sourceService.retrySource).not.toHaveBeenCalled();
  });
});

describe('Study notes', () => {
  test('generate, poll while generating, then show notes with refs and labelled background', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    aiService.getNotes.mockResolvedValueOnce(null).mockResolvedValue(NOTES);
    aiService.generateNotes.mockResolvedValue({ id: 'n1', status: 'queued' });
    const { user } = open('notes');

    await user.click(await screen.findByRole('button', { name: 'Generate study notes' }));
    expect(await screen.findByText('Writing your study notes…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2600));

    expect(await screen.findByRole('heading', { name: 'Urban Trees' })).toBeInTheDocument();
    expect(screen.getByText('Canopy')).toBeInTheDocument();
    expect(screen.getAllByText('p. 4').length).toBeGreaterThan(0);
    const background = screen.getByRole('region', { name: 'Background knowledge' });
    expect(within(background).getByText(/not from this source/)).toBeInTheDocument();
    expect(within(background).getByText('Trees also store carbon.')).toBeInTheDocument();
  });

  test('copies notes as Markdown and can regenerate', async () => {
    aiService.getNotes.mockResolvedValue(NOTES);
    aiService.generateNotes.mockResolvedValue({ ...NOTES, status: 'queued' });
    const { user } = open('notes');
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(notesToMarkdown(NOTES, 'How Urban Trees Cool Cities'));
    expect(writeText.mock.calls[0][0]).toContain('## Background (not from the source)');
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(aiService.generateNotes).toHaveBeenCalledWith(COMPLETED_SOURCE.id, { regenerate: true });
  });

  test('shows a failed generation with retry', async () => {
    aiService.getNotes.mockResolvedValue({ id: 'n1', status: 'failed', error: { message: 'AI features are not configured on the server.' } });
    open('notes');
    expect(await screen.findByText('AI features are not configured on the server.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('Quiz', () => {
  test('create with options, answer, submit and review', async () => {
    aiService.listQuizzes.mockResolvedValueOnce([]).mockResolvedValue([QUIZ]);
    aiService.createQuiz.mockResolvedValue({ item: QUIZ, reused: false, queued: true });
    aiService.submitQuiz.mockResolvedValue(REVIEW);
    const { user } = open('quiz');

    const count = await screen.findByLabelText('Questions');
    await user.clear(count);
    await user.type(count, '3');
    await user.click(screen.getByRole('button', { name: 'Hard' }));
    await user.click(screen.getByLabelText('Short answer'));
    await user.click(screen.getByRole('button', { name: 'Generate quiz' }));
    expect(aiService.createQuiz).toHaveBeenCalledWith(COMPLETED_SOURCE.id, { count: 3, difficulty: 'hard', types: ['multiple_choice', 'true_false'] });

    // Taking the quiz: no answers are shown before submission.
    expect(await screen.findByText('1. What cools streets?', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Trees give shade.')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Trees'));
    await user.click(screen.getByLabelText('True'));
    await user.type(screen.getByLabelText('Answer to: Name the cooling process.'), 'evapotranspiration');
    expect(screen.getByText('3 of 3 answered')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(aiService.submitQuiz).toHaveBeenCalledWith('q1', { q1: 0, q2: true, q3: 'evapotranspiration' });
    expect(await screen.findByLabelText('Score 2 of 3')).toBeInTheDocument();
    expect(screen.getByText('It is unequal.')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Incorrect')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Retry quiz' }));
    expect(await screen.findByText('0 of 3 answered')).toBeInTheDocument();
  });
});

describe('Flashcards', () => {
  test('flip, navigate, shuffle and track review', async () => {
    aiService.getFlashcards.mockResolvedValue(DECK);
    aiService.reviewFlashcard.mockResolvedValue({
      ...DECK,
      cards: [{ ...DECK.cards[0], review: { status: 'known', reviews: 1 } }, DECK.cards[1]],
    });
    const { user } = open('flashcards');

    expect(await screen.findByText('What is canopy?')).toBeInTheDocument();
    expect(screen.getByText('Card 1 of 2 · 0 known')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show answer' }));
    expect(screen.getByText('Tree cover.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'I knew it' }));
    expect(aiService.reviewFlashcard).toHaveBeenCalledWith('d1', 'f1', 'known');
    expect(await screen.findByText('Card 2 of 2 · 1 known')).toBeInTheDocument();
    expect(screen.getByText('What cools air?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Previous card' }));
    expect(screen.getByText('What is canopy?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Shuffle' }));
    expect(screen.getByText(/Card 1 of 2/)).toBeInTheDocument();
  });

  test('empty state generates with the preferred count', async () => {
    aiService.getFlashcards.mockResolvedValue(null);
    aiService.generateFlashcards.mockResolvedValue({ id: 'd1', status: 'queued', cards: [] });
    const { user } = open('flashcards');
    await user.click(await screen.findByRole('button', { name: 'Generate flashcards' }));
    await waitFor(() => expect(aiService.generateFlashcards).toHaveBeenCalledWith(COMPLETED_SOURCE.id, { count: 20, regenerate: false }));
    expect(await screen.findByText('Making your flashcards…')).toBeInTheDocument();
  });
});

describe('free-tier states', () => {
  test('a study item waiting for quota shows why it is paused', async () => {
    aiService.getNotes.mockResolvedValue({
      id: 'n1',
      status: 'queued',
      error: { code: 'AI_QUOTA_EXHAUSTED', message: 'The free Gemini quota is used up for now. Your study notes is paused and will continue automatically.' },
    });
    open('notes');
    expect(await screen.findByText('Paused: waiting for AI capacity')).toBeInTheDocument();
    expect(screen.getByText(/Your study notes is paused/)).toBeInTheDocument();
  });

  test('stale notes say the source changed', async () => {
    aiService.getNotes.mockResolvedValue({ ...NOTES, stale: true });
    open('notes');
    expect(await screen.findByText(/source has changed since these notes were made/)).toBeInTheDocument();
  });

  test('identical quiz settings reuse the existing quiz and offer fresh questions', async () => {
    aiService.listQuizzes.mockResolvedValueOnce([]).mockResolvedValue([QUIZ]);
    aiService.createQuiz
      .mockResolvedValueOnce({ item: QUIZ, reused: true, queued: false })
      .mockResolvedValueOnce({ item: { ...QUIZ, id: 'q2', status: 'queued', questions: [] }, reused: false, queued: true });
    const { user } = open('quiz');
    await user.click(await screen.findByRole('button', { name: 'Generate quiz' }));
    expect(await screen.findByText(/You already had a quiz with these settings/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Generate new questions' }));
    expect(aiService.createQuiz).toHaveBeenLastCalledWith(COMPLETED_SOURCE.id, expect.objectContaining({ regenerate: true }));
  });

  test('a summary paused for quota shows the reason on the processing page', async () => {
    sourceService.getSource.mockResolvedValue({
      ...COMPLETED_SOURCE,
      status: 'summarizing',
      summary: null,
      job: {
        id: 'j',
        status: 'queued',
        attempts: 1,
        maxAttempts: 3,
        waiting: { reason: { code: 'AI_QUOTA_EXHAUSTED', message: 'Your summary is paused until quota is available.' }, nextAttemptAt: '2026-11-13T12:00:00Z' },
      },
    });
    open();
    expect(await screen.findByText('Paused: waiting for AI capacity')).toBeInTheDocument();
    expect(screen.getByText('Your summary is paused until quota is available.')).toBeInTheDocument();
  });
});

describe('Study workspace', () => {
  beforeEach(() => {
    sourceService.listSources.mockResolvedValue({ items: [{ id: COMPLETED_SOURCE.id, kind: 'article', status: 'completed', title: 'How Urban Trees Cool Cities', createdAt: COMPLETED_SOURCE.createdAt }], page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  test('lists completed sources and opens the chosen tool inline', async () => {
    aiService.getFlashcards.mockResolvedValue(DECK);
    const { user } = renderApp('/study?tool=flashcards');

    expect(await screen.findByRole('heading', { level: 1, name: 'Study workspace' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Flashcards/ })).toHaveAttribute('aria-selected', 'true');
    expect(sourceService.listSources).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));

    await user.click(await screen.findByRole('button', { name: /How Urban Trees Cool Cities/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'How Urban Trees Cool Cities' })).toBeInTheDocument();
    expect(sourceService.getSource).toHaveBeenCalledWith(COMPLETED_SOURCE.id);
    expect(await screen.findByText('What is canopy?')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Read the summary/ })).toHaveAttribute('href', `/library/${COMPLETED_SOURCE.id}`);
  });

  test('switching tools keeps the selected source', async () => {
    aiService.getFlashcards.mockResolvedValue(DECK);
    aiService.getNotes.mockResolvedValue(NOTES);
    const { user } = renderApp(`/study?tool=flashcards&source=${COMPLETED_SOURCE.id}`);

    expect(await screen.findByText('What is canopy?')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Notes/ }));
    expect(await screen.findByText('Trees cool cities through shade.')).toBeInTheDocument();
    expect(aiService.getNotes).toHaveBeenCalledWith(COMPLETED_SOURCE.id);
  });
});
