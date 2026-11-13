import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUp, BookOpenText, CircleHelp, MessageSquareText } from 'lucide-react';
import Badge from '../common/Badge';
import Markdown from '../common/Markdown';
import Button from '../common/Button';
import Notice from '../common/Notice';
import Skeleton from '../common/Skeleton';
import Spinner from '../common/Spinner';
import * as aiService from '../../services/aiService';
import { cn } from '../../utils/cn';
import { getErrorMessage } from '../../utils/errors';

export const MAX_QUESTION_CHARS = 2000;
// Temporary limits (provider quota, Briefly's budget, rate limits): not an error with the question.
const WAIT_CODES = new Set(['AI_QUOTA_EXHAUSTED', 'AI_BUDGET_EXHAUSTED', 'AI_RATE_LIMITED', 'AI_PACED', 'AI_BUSY', 'ANSWER_IN_PROGRESS']);

const SUPPORT = {
  partial: { variant: 'warning', label: 'Partly answered by the source' },
  not_found: { variant: 'neutral', label: 'Not found in the source' },
};

function Citations({ citations, showTitles }) {
  if (!citations?.length) return null;
  return (
    <div className="mt-4">
      <p className="eyebrow mb-2">Sources</p>
      <ol className="flex flex-wrap gap-1.5">
        {citations.map((c, i) => (
          <li key={`${c.chunk || c.source}-${i}`}>
            <Link
              to={`/library/${c.source}`}
              title={c.snippet || undefined}
              className="inline-flex max-w-[18rem] items-center gap-1.5 rounded border border-stone-200 bg-white px-2 py-1 text-xs text-stone-600 transition-colors hover:border-stone-300 hover:text-stone-900"
            >
              <span className="font-semibold tabular-nums text-stone-500">{i + 1}</span>
              <span className="truncate">
                {showTitles && c.sourceTitle ? c.sourceTitle : null}
                {showTitles && c.sourceTitle && c.label ? ' · ' : null}
                {c.label || (!showTitles || !c.sourceTitle ? 'Passage' : null)}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Message({ message, showTitles, onFollowUp, disabled }) {
  if (message.role === 'user') {
    return (
      <div className="border-t border-stone-200 pt-6 first:border-t-0 first:pt-0">
        <p className="eyebrow mb-1.5">You asked</p>
        <div
          className={cn(
            'whitespace-pre-wrap border-l-2 border-brand-400 pl-4 text-[1rem] font-medium leading-relaxed text-stone-900',
            message.pending && 'opacity-60'
          )}
        >
          {message.content}
        </div>
      </div>
    );
  }
  const support = SUPPORT[message.support];
  return (
    <div>
      <p className="eyebrow mb-2 flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />
        Briefly
      </p>
      <div className="min-w-0">
        {support && (
          <Badge variant={support.variant} className="mb-2">
            {message.support === 'not_found' ? <CircleHelp className="h-3 w-3" aria-hidden="true" /> : null}
            {support.label}
          </Badge>
        )}
        <Markdown text={message.content} className="font-serif text-[1.0625rem] leading-[1.75] text-stone-800" />
        <Citations citations={message.citations} showTitles={showTitles} />
        {message.followUps?.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {message.followUps.map((q) => (
              <button
                key={q}
                type="button"
                disabled={disabled}
                onClick={() => onFollowUp(q)}
                className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-600 transition-colors hover:border-stone-300 hover:text-stone-900 disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A chat thread. When `conversationId` is null the conversation is created on
 * the first question via `onCreate()` (so empty conversations are never saved).
 */
export default function ChatPanel({ conversationId, onCreate, onUpdated, scope, suggestions = [], placeholder, className }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [loadError, setLoadError] = useState(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const activeId = useRef(conversationId);
  const endRef = useRef(null);
  const skipLoad = useRef(false);

  const load = useCallback(async () => {
    if (!conversationId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await aiService.getConversation(conversationId);
      if (activeId.current === conversationId) {
        setMessages(result.messages);
        setLoadError(null);
      }
    } catch (err) {
      if (activeId.current === conversationId) setLoadError(err);
    } finally {
      if (activeId.current === conversationId) setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    activeId.current = conversationId;
    setError(null);
    // A conversation created by this panel already has its messages in state.
    if (skipLoad.current) {
      skipLoad.current = false;
      return;
    }
    load();
  }, [conversationId, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, sending]);

  async function ask(text) {
    const content = text.trim();
    if (!content || sending) return;
    setError(null);
    setSending(true);
    setInput('');
    const requestId = aiService.newRequestId();
    const pending = { id: `pending-${requestId}`, role: 'user', content, pending: true };
    setMessages((current) => [...current, pending]);
    try {
      let id = conversationId;
      if (!id) {
        const created = await onCreate();
        id = created.id;
        skipLoad.current = true;
        activeId.current = id;
      }
      const result = await aiService.sendMessage(id, content, requestId);
      setMessages((current) => [...current.filter((m) => m.id !== pending.id), ...result.messages]);
      onUpdated?.(result.conversation);
    } catch (err) {
      setMessages((current) => current.filter((m) => m.id !== pending.id));
      setInput(content);
      setError(err);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      ask(input);
    }
  }

  const errorCode = error?.response?.data?.error?.code;
  const showTitles = scope === 'library';

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-1 py-5" aria-live="polite">
        {loading ? (
          <div className="space-y-4" aria-label="Loading conversation" role="status">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-24 w-5/6" />
          </div>
        ) : loadError ? (
          <Notice variant="error" title="Could not load this conversation">
            {getErrorMessage(loadError)}{' '}
            <button type="button" className="font-medium underline" onClick={load}>
              Try again
            </button>
          </Notice>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-stone-200 bg-white">
              {scope === 'library' ? (
                <BookOpenText className="h-5 w-5 text-stone-400" aria-hidden="true" />
              ) : (
                <MessageSquareText className="h-5 w-5 text-stone-400" aria-hidden="true" />
              )}
            </div>
            <h3 className="font-serif text-xl font-medium text-stone-900">
              {scope === 'library' ? 'Ask anything about your library' : 'Ask about this source'}
            </h3>
            <p className="mt-1.5 max-w-sm text-sm text-stone-500">
              Answers come only from your saved content, with links to the passages they are based on. If the
              content does not cover a question, you will be told.
            </p>
            {suggestions.length > 0 && (
              <div className="mt-5 flex max-w-lg flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => ask(s)}
                    className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-600 shadow-sm hover:border-brand-300 hover:text-brand-800"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} message={m} showTitles={showTitles} onFollowUp={ask} disabled={sending} />)
        )}
        {sending && (
          <div className="flex items-center gap-2 px-1 text-sm text-stone-500" role="status">
            <Spinner size="sm" className="text-stone-500" />
            Searching your content and writing an answer…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <Notice
          variant={errorCode === 'SOURCE_NOT_INDEXED' || WAIT_CODES.has(errorCode) ? 'info' : 'error'}
          title={
            errorCode === 'SOURCE_NOT_INDEXED'
              ? 'Preparing this source'
              : WAIT_CODES.has(errorCode)
              ? 'AI answers are paused'
              : 'Your question could not be answered'
          }
          className="mb-3"
        >
          {getErrorMessage(error)}
        </Notice>
      )}

      <form
        className="flex items-end gap-2 rounded-lg border border-stone-300/80 bg-white p-2 pl-3.5 shadow-card transition-colors focus-within:border-stone-400 focus-within:ring-2 focus-within:ring-brand-400/20"
        onSubmit={(event) => {
          event.preventDefault();
          ask(input);
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          Your question
        </label>
        <textarea
          id="chat-input"
          rows={1}
          value={input}
          maxLength={MAX_QUESTION_CHARS}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Ask a question…'}
          className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-stone-900 placeholder:text-placeholder focus:outline-none"
          disabled={loading || Boolean(loadError)}
        />
        <Button type="submit" size="sm" aria-label="Send question" disabled={!input.trim() || sending || loading} className="h-9 w-9 px-0">
          <ArrowUp className="h-4 w-4" aria-hidden="true" />
        </Button>
      </form>
      <p className="mt-2 px-1 text-2xs text-stone-500">Enter to send · Shift+Enter for a new line · AI answers can be wrong, check the cited passages.</p>
    </div>
  );
}
