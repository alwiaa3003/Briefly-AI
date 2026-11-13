import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FileText, Library, MessageSquarePlus, Trash2 } from 'lucide-react';
import Button from '../components/common/Button';
import Skeleton from '../components/common/Skeleton';
import ChatPanel from '../components/ai/ChatPanel';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import * as aiService from '../services/aiService';
import { cn } from '../utils/cn';
import { getErrorMessage } from '../utils/errors';
import { formatShortDate } from '../utils/format';

const SUGGESTIONS = [
  'What are the main themes across my library?',
  'Which of my sources mention climate?',
  'Summarize what I saved about productivity.',
];

function ConversationList({ items, activeId, onDelete, loading, error, onRetry }) {
  if (loading) {
    return (
      <div className="space-y-2 p-3" role="status" aria-label="Loading conversations">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4 text-sm text-stone-500">
        {getErrorMessage(error)}{' '}
        <button type="button" onClick={onRetry} className="font-medium text-brand-700 underline">
          Retry
        </button>
      </div>
    );
  }
  if (!items.length) {
    return <p className="p-4 text-sm text-stone-500">No conversations yet. Your questions and answers are saved here.</p>;
  }
  return (
    <ul className="space-y-0.5 p-2">
      {items.map((c) => (
        <li key={c.id} className="group relative">
          <Link
            to={`/ask/${c.id}`}
            aria-current={c.id === activeId ? 'page' : undefined}
            className={cn(
              'block rounded-md px-3 py-2 pr-9 transition-colors',
              c.id === activeId ? 'bg-white text-stone-900 ring-1 ring-stone-200' : 'text-stone-600 hover:bg-white/70 hover:text-stone-900'
            )}
          >
            <span className="block truncate text-sm font-medium">{c.title}</span>
            <span className="mt-0.5 flex items-center gap-1 truncate text-2xs text-stone-500">
              {c.scope === 'source' ? <FileText className="h-3 w-3 shrink-0" aria-hidden="true" /> : <Library className="h-3 w-3 shrink-0" aria-hidden="true" />}
              <span className="truncate">{c.scope === 'source' ? c.source?.title || 'Source' : 'Whole library'}</span>
              <span aria-hidden="true">·</span>
              {formatShortDate(c.lastMessageAt || c.updatedAt)}
            </span>
          </Link>
          <button
            type="button"
            onClick={() => onDelete(c)}
            aria-label={`Delete conversation ${c.title}`}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-stone-400 opacity-0 hover:bg-white hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Ask AI: conversation history on the left, the active thread on the right. */
export default function AskAI() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const active = items.find((c) => c.id === conversationId);
  useDocumentTitle(active?.title || 'Ask AI');

  const load = useCallback(async () => {
    try {
      const result = await aiService.listConversations({ limit: 50 });
      setItems(result.items);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function handleUpdated(conversation) {
    setItems((current) => [conversation, ...current.filter((c) => c.id !== conversation.id)]);
    if (conversation.id !== conversationId) navigate(`/ask/${conversation.id}`, { replace: true });
  }

  async function handleDelete(conversation) {
    if (!window.confirm(`Delete "${conversation.title}"? This cannot be undone.`)) return;
    try {
      await aiService.deleteConversation(conversation.id);
      setItems((current) => current.filter((c) => c.id !== conversation.id));
      if (conversation.id === conversationId) navigate('/ask');
      toast.info('Conversation deleted');
    } catch (err) {
      toast.error('Could not delete', getErrorMessage(err));
    }
  }

  const scope = active?.scope || (conversationId ? null : 'library');

  return (
    <div className="mx-auto flex w-full max-w-page flex-col px-5 py-8 sm:px-8 lg:h-[calc(100vh-4rem)] lg:px-12 lg:py-10">
      <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-2">Research</p>
          <h1 className="page-title">Ask AI</h1>
          <p className="mt-2.5 max-w-2xl text-[0.9375rem] leading-relaxed text-stone-500">
            Ask questions across everything you have saved. To ask about a single source, open it from your library.
          </p>
        </div>
        <Button variant="secondary" onClick={() => navigate('/ask')} disabled={!conversationId}>
          <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
          New chat
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside aria-label="Conversations" className="max-h-72 overflow-y-auto border-b border-stone-200/70 pb-4 lg:max-h-none lg:border-b-0 lg:border-r lg:pb-0 lg:pr-6">
          <p className="eyebrow mb-2 px-3">History</p>
          <ConversationList
            items={items}
            activeId={conversationId}
            onDelete={handleDelete}
            loading={loading}
            error={error}
            onRetry={load}
          />
        </aside>
        <section aria-label="Conversation" className="mx-auto flex min-h-[28rem] w-full max-w-reading flex-col">
          {active?.scope === 'source' && active.source && (
            <p className="mb-1 text-xs text-stone-500">
              About{' '}
              <Link to={`/library/${active.source.id}`} className="font-medium text-stone-900 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-600">
                {active.source.title}
              </Link>
            </p>
          )}
          <ChatPanel
            className="flex-1"
            conversationId={conversationId || null}
            scope={scope || 'library'}
            suggestions={conversationId ? [] : SUGGESTIONS}
            placeholder="Ask about your library…"
            onCreate={() => aiService.createConversation({ scope: 'library' })}
            onUpdated={handleUpdated}
          />
        </section>
      </div>
    </div>
  );
}
