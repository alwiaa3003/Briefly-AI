import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Layers, RefreshCw, RotateCcw, Shuffle } from 'lucide-react';
import { Card } from '../common/Card';
import Button from '../common/Button';
import Skeleton from '../common/Skeleton';
import SourceRefs from '../ai/SourceRefs';
import { FailedGeneration, GeneratingState, NotGeneratedState } from '../ai/GenerationState';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import * as aiService from '../../services/aiService';
import { cn } from '../../utils/cn';
import { getErrorMessage } from '../../utils/errors';
import { isGenerating, shuffle } from '../../utils/study';

function Viewer({ deck, onDeckChange, onRegenerate, regenerating }) {
  const toast = useToast();
  const [order, setOrder] = useState(() => deck.cards.map((c) => c.id));
  const [position, setPosition] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const byId = useMemo(() => new Map(deck.cards.map((c) => [c.id, c])), [deck.cards]);
  const card = byId.get(order[position]) || deck.cards[0];
  const known = deck.cards.filter((c) => c.review?.status === 'known').length;

  const go = useCallback(
    (delta) => {
      setFlipped(false);
      setPosition((p) => (p + delta + order.length) % order.length);
    },
    [order.length]
  );

  useEffect(() => {
    function onKey(event) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      if (event.key === 'ArrowRight') go(1);
      else if (event.key === 'ArrowLeft') go(-1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  async function mark(status) {
    try {
      onDeckChange(await aiService.reviewFlashcard(deck.id, card.id, status));
      go(1);
    } catch (err) {
      toast.error('Could not save your review', getErrorMessage(err));
    }
  }

  async function reset() {
    try {
      onDeckChange(await aiService.resetFlashcards(deck.id));
      setPosition(0);
      setFlipped(false);
    } catch (err) {
      toast.error('Could not reset progress', getErrorMessage(err));
    }
  }

  return (
    <div className="space-y-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-stone-500">
            Card {position + 1} of {order.length} · {known} known
          </p>
          <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-label="Cards known" aria-valuemin={0} aria-valuemax={deck.cards.length} aria-valuenow={known}>
            <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${(known / deck.cards.length) * 100}%` }} />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOrder(shuffle(deck.cards.map((c) => c.id)));
              setPosition(0);
              setFlipped(false);
            }}
          >
            <Shuffle className="h-3.5 w-3.5" aria-hidden="true" />
            Shuffle
          </Button>
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset progress
          </Button>
          <Button variant="ghost" size="sm" onClick={onRegenerate} loading={regenerating}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Regenerate
          </Button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        aria-label={flipped ? 'Show question' : 'Show answer'}
        className={cn(
          'flex min-h-[16rem] w-full flex-col items-center justify-center rounded-2xl border px-6 py-12 text-center shadow-card transition-colors duration-200',
          flipped ? 'border-stone-300 bg-stone-50' : 'border-stone-200 bg-white hover:border-stone-300'
        )}
      >
        <span className="mb-3 text-2xs font-semibold uppercase tracking-wide text-stone-500">{flipped ? 'Answer' : 'Question'}</span>
        <span className={cn('max-w-xl leading-relaxed text-stone-900', flipped ? 'text-base' : 'font-serif text-xl font-semibold')}>
          {flipped ? card.back : card.front}
        </span>
        {flipped && <SourceRefs refs={card.refs} />}
        {!flipped && <span className="mt-4 text-xs text-stone-500">Click to reveal the answer</span>}
        {card.review?.status && card.review.status !== 'new' && (
          <span className={cn('mt-4 text-2xs font-medium', card.review.status === 'known' ? 'text-emerald-600' : 'text-amber-700')}>
            {card.review.status === 'known' ? 'Marked as known' : 'Still learning'}
          </span>
        )}
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="secondary" onClick={() => go(-1)} aria-label="Previous card">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Previous
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => mark('learning')}>
            Still learning
          </Button>
          <Button onClick={() => mark('known')}>I knew it</Button>
        </div>
        <Button variant="secondary" onClick={() => go(1)} aria-label="Next card">
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export default function FlashcardsPanel({ source }) {
  const toast = useToast();
  const [deck, setDeck] = useState(undefined);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDeck(await aiService.getFlashcards(source.id));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [source.id]);

  useEffect(() => {
    load();
  }, [load]);
  usePolling(load, isGenerating(deck));

  async function generate(regenerate = false) {
    setBusy(true);
    try {
      const prefs = await aiService.getPreferences().catch(() => null);
      setDeck(await aiService.generateFlashcards(source.id, { count: prefs?.flashcardCount, regenerate }));
    } catch (err) {
      toast.error('Could not generate flashcards', getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (deck === undefined && !error) {
    body = (
      <div className="p-6" role="status" aria-label="Loading flashcards">
        <Skeleton className="h-56 w-full rounded-2xl" />
      </div>
    );
  } else if (error && deck === undefined) {
    body = <FailedGeneration item={{ error: { message: getErrorMessage(error) } }} onRetry={load} what="Could not load flashcards" />;
  } else if (!deck) {
    body = (
      <NotGeneratedState
        icon={Layers}
        title="Flashcards"
        description="Revision cards for the most important concepts, definitions and facts in this source."
        actionLabel="Generate flashcards"
        onGenerate={() => generate()}
        busy={busy}
      />
    );
  } else if (isGenerating(deck)) {
    body = <GeneratingState title="Making your flashcards…" item={deck} />;
  } else if (deck.status === 'failed') {
    body = <FailedGeneration item={deck} onRetry={() => generate(true)} busy={busy} what="The flashcards could not be generated" />;
  } else {
    body = <Viewer key={deck.generatedAt} deck={deck} onDeckChange={setDeck} onRegenerate={() => generate(true)} regenerating={busy} />;
  }
  return <Card>{body}</Card>;
}
