import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import { COMPLETED_SOURCE } from './fixtures';
import * as authService from '../services/authService';
import * as aiService from '../services/aiService';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

const CONVERSATION = {
  id: 'c0ffee000000000000000001',
  scope: 'library',
  source: null,
  title: 'What do trees do?',
  messageCount: 2,
  lastMessageAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
};

const USER_MSG = { id: 'm1', role: 'user', content: 'What do trees do?' };
const ANSWER = {
  id: 'm2',
  role: 'assistant',
  content: 'Trees cool streets through shade.',
  support: 'supported',
  citations: [{ source: COMPLETED_SOURCE.id, sourceTitle: 'How Urban Trees Cool Cities', label: 'p. 4', snippet: 'Trees cool…', chunk: 'k1' }],
  followUps: ['Why does shade matter?'],
};

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
  aiService.listConversations.mockResolvedValue({ items: [], page: 1, limit: 50, total: 0, totalPages: 1 });
  aiService.newRequestId.mockReturnValue('req-test-0001');
});

describe('Ask AI', () => {
  test('is in the main navigation and shows an empty state with suggestions', async () => {
    renderApp('/ask');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Ask AI' })).toHaveAttribute('href', '/ask');
    expect(await screen.findByText('Ask anything about your library')).toBeInTheDocument();
    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'What are the main themes across my library?' })).toBeInTheDocument();
  });

  test('asking creates a library conversation and shows the cited answer', async () => {
    aiService.createConversation.mockResolvedValue({ ...CONVERSATION, messageCount: 0 });
    aiService.sendMessage.mockResolvedValue({ conversation: CONVERSATION, messages: [USER_MSG, ANSWER] });
    const { user } = renderApp('/ask');

    await user.type(await screen.findByLabelText('Your question'), 'What do trees do?{Enter}');

    expect(await screen.findByText('Trees cool streets through shade.')).toBeInTheDocument();
    expect(aiService.createConversation).toHaveBeenCalledWith({ scope: 'library' });
    expect(aiService.sendMessage).toHaveBeenCalledWith(CONVERSATION.id, 'What do trees do?', 'req-test-0001');
    const citation = screen.getByRole('link', { name: /How Urban Trees Cool Cities · p\. 4/ });
    expect(citation).toHaveAttribute('href', `/library/${COMPLETED_SOURCE.id}`);
    expect(screen.getByRole('button', { name: 'Why does shade matter?' })).toBeInTheDocument();
    // The new conversation appears in the history list.
    const history = screen.getByRole('complementary', { name: 'Conversations' });
    expect(await within(history).findByText('What do trees do?')).toBeInTheDocument();
    expect(aiService.getConversation).not.toHaveBeenCalled();
  });

  test('labels answers the source does not support', async () => {
    aiService.listConversations.mockResolvedValue({ items: [CONVERSATION], page: 1, limit: 50, total: 1, totalPages: 1 });
    aiService.getConversation.mockResolvedValue({
      conversation: CONVERSATION,
      messages: [USER_MSG, { ...ANSWER, support: 'not_found', citations: [], followUps: [], content: "Your library doesn't cover that." }],
    });
    renderApp(`/ask/${CONVERSATION.id}`);
    expect(await screen.findByText("Your library doesn't cover that.")).toBeInTheDocument();
    expect(screen.getByText('Not found in the source')).toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  test('a failed question shows the error and keeps the text to retry', async () => {
    aiService.createConversation.mockResolvedValue(CONVERSATION);
    aiService.sendMessage.mockRejectedValue(apiError(503, 'AI_NOT_CONFIGURED', 'AI features are not configured on the server.'));
    const { user } = renderApp('/ask');
    const input = await screen.findByLabelText('Your question');
    await user.type(input, 'Hello?');
    await user.click(screen.getByRole('button', { name: 'Send question' }));

    expect(await screen.findByText('AI features are not configured on the server.')).toBeInTheDocument();
    expect(input).toHaveValue('Hello?');
    expect(screen.queryByText('Hello?', { selector: 'div' })).not.toBeInTheDocument();
  });

  test('conversations can be deleted', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    aiService.listConversations.mockResolvedValue({ items: [CONVERSATION], page: 1, limit: 50, total: 1, totalPages: 1 });
    aiService.deleteConversation.mockResolvedValue();
    const { user } = renderApp('/ask');
    await user.click(await screen.findByRole('button', { name: `Delete conversation ${CONVERSATION.title}` }));
    await waitFor(() => expect(aiService.deleteConversation).toHaveBeenCalledWith(CONVERSATION.id));
    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument();
  });
});

describe('Ask AI when Gemini is unavailable', () => {
  test('quota exhaustion is shown as a pause, not an error, and the question is kept', async () => {
    aiService.createConversation.mockResolvedValue(CONVERSATION);
    aiService.sendMessage.mockRejectedValue(
      apiError(429, 'AI_QUOTA_EXHAUSTED', 'Ask AI cannot answer right now: the free Gemini quota is used up. Please try again later.')
    );
    const { user } = renderApp('/ask');
    const input = await screen.findByLabelText('Your question');
    await user.type(input, 'Why?{Enter}');
    expect(await screen.findByText('AI answers are paused')).toBeInTheDocument();
    expect(screen.getByText(/free Gemini quota is used up/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).toHaveValue('Why?');
  });

  test('each question carries a request id so re-sends are not answered twice', async () => {
    aiService.createConversation.mockResolvedValue(CONVERSATION);
    aiService.newRequestId.mockReturnValueOnce('req-a-00000001');
    aiService.sendMessage.mockResolvedValue({ conversation: CONVERSATION, messages: [USER_MSG, ANSWER] });
    const { user } = renderApp('/ask');
    await user.type(await screen.findByLabelText('Your question'), 'One?{Enter}');
    await screen.findByText('Trees cool streets through shade.');
    expect(aiService.sendMessage).toHaveBeenLastCalledWith(CONVERSATION.id, 'One?', 'req-a-00000001');
  });
});
