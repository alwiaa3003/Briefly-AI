import { useCallback, useEffect, useState } from 'react';
import { History, MessageSquarePlus } from 'lucide-react';
import { Card } from '../common/Card';
import Button from '../common/Button';
import Skeleton from '../common/Skeleton';
import ChatPanel from '../ai/ChatPanel';
import * as aiService from '../../services/aiService';
import { formatShortDate } from '../../utils/format';

const SUGGESTIONS = {
  article: ['What is the main argument?', 'What evidence supports it?', 'What are the limitations?'],
  youtube: ['What are the key points of this video?', 'What examples are given?', 'What does the speaker conclude?'],
  video: ['What are the key points of this video?', 'What examples are given?', 'What does the speaker conclude?'],
  document: ['What is this document about?', 'What are the key findings?', 'Explain the main terms.'],
};

/** "Ask" tab of a source: its conversations and a chat scoped to this source only. */
export default function SourceAsk({ source }) {
  const [conversations, setConversations] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await aiService.listConversations({ sourceId: source.id, limit: 20 });
      setConversations(result.items);
      setActiveId((current) => current ?? result.items[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err);
      setConversations([]);
    }
  }, [source.id]);

  useEffect(() => {
    load();
  }, [load]);

  function handleUpdated(conversation) {
    setConversations((current) => [conversation, ...(current || []).filter((c) => c.id !== conversation.id)]);
    setActiveId(conversation.id);
  }

  const indexing = source.rag && ['queued', 'indexing'].includes(source.rag.status);

  return (
    <Card className="flex min-h-[32rem] flex-col p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200/70 pb-3">
        <div className="flex min-w-0 items-center gap-2 text-sm text-stone-600">
          <History className="h-4 w-4 shrink-0 text-stone-400" aria-hidden="true" />
          {conversations === null ? (
            <Skeleton className="h-5 w-40" />
          ) : conversations.length > 1 ? (
            <select
              aria-label="Previous conversations"
              value={activeId || ''}
              onChange={(event) => setActiveId(event.target.value || null)}
              className="h-8 max-w-[16rem] truncate rounded-md border border-stone-200 bg-white px-2 text-xs"
            >
              {!activeId && <option value="">New conversation</option>}
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} · {formatShortDate(c.lastMessageAt || c.updatedAt)}
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate">{conversations[0]?.title && activeId ? conversations[0].title : 'New conversation'}</span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setActiveId(null)} disabled={!activeId}>
          <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
          New chat
        </Button>
      </div>
      {indexing && (
        <p className="mt-3 rounded-md bg-stone-50 px-3 py-2 text-xs text-stone-500">
          This source is still being prepared for questions. It only takes a moment.
        </p>
      )}
      {error && <p className="mt-3 text-xs text-red-600">Previous conversations could not be loaded.</p>}
      <ChatPanel
        className="flex-1"
        conversationId={activeId}
        scope="source"
        suggestions={SUGGESTIONS[source.kind] || SUGGESTIONS.article}
        placeholder="Ask about this source…"
        onCreate={() => aiService.createConversation({ scope: 'source', sourceId: source.id })}
        onUpdated={handleUpdated}
      />
    </Card>
  );
}
