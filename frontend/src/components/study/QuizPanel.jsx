import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCheck, RotateCcw, Sparkles, Trash2, XCircle } from 'lucide-react';
import { Card } from '../common/Card';
import Button from '../common/Button';
import Badge from '../common/Badge';
import Skeleton from '../common/Skeleton';
import SourceRefs from '../ai/SourceRefs';
import { FailedGeneration, GeneratingState } from '../ai/GenerationState';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import * as aiService from '../../services/aiService';
import { cn } from '../../utils/cn';
import { getErrorMessage } from '../../utils/errors';
import { formatShortDate } from '../../utils/format';
import { DIFFICULTIES, QUESTION_TYPES, isGenerating } from '../../utils/study';

const TYPE_LABEL = Object.fromEntries(QUESTION_TYPES.map((t) => [t.id, t.label]));

function QuizSetup({ onCreate, busy, defaults }) {
  const [count, setCount] = useState(defaults?.quizQuestionCount ?? 10);
  const [difficulty, setDifficulty] = useState(defaults?.quizDifficulty ?? 'medium');
  const [types, setTypes] = useState(defaults?.quizQuestionTypes ?? QUESTION_TYPES.map((t) => t.id));

  useEffect(() => {
    if (!defaults) return;
    setCount(defaults.quizQuestionCount);
    setDifficulty(defaults.quizDifficulty);
    setTypes(defaults.quizQuestionTypes);
  }, [defaults]);

  const toggle = (id) => setTypes((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));

  return (
    <form
      className="space-y-5 p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate({ count: Number(count), difficulty, types });
      }}
    >
      <div>
        <h2 className="text-sm font-semibold text-stone-900">New quiz</h2>
        <p className="mt-0.5 text-sm text-stone-500">Questions are based only on this source. Answers are revealed after you submit.</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-stone-700">Questions</span>
          <input
            type="number"
            min={3}
            max={30}
            value={count}
            onChange={(event) => setCount(event.target.value)}
            className="control h-10"
          />
        </label>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-stone-700">Difficulty</legend>
          <div className="flex gap-1.5">
            {DIFFICULTIES.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={difficulty === d.id}
                onClick={() => setDifficulty(d.id)}
                className={cn(
                  'h-10 flex-1 rounded-lg border text-sm font-medium',
                  difficulty === d.id ? 'border-stone-800 bg-stone-800 text-white' : 'border-stone-200 text-stone-600 hover:border-stone-300'
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-stone-700">Question types</legend>
          <div className="space-y-1">
            {QUESTION_TYPES.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-sm text-stone-700">
                <input type="checkbox" checked={types.includes(t.id)} onChange={() => toggle(t.id)} className="rounded border-stone-300 text-brand-700" />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <Button type="submit" loading={busy} disabled={!types.length || count < 3 || count > 30}>
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        Generate quiz
      </Button>
    </form>
  );
}

function AnswerInput({ question, value, onChange, disabled }) {
  const name = `answer-${question.id}`;
  if (question.type === 'multiple_choice') {
    return (
      <div className="space-y-1.5" role="radiogroup" aria-label={question.question}>
        {question.options.map((option, i) => (
          <label
            key={option}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm',
              value === i ? 'border-stone-900 bg-stone-50 ring-1 ring-stone-900' : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50/60'
            )}
          >
            <input type="radio" name={name} checked={value === i} onChange={() => onChange(i)} disabled={disabled} className="mt-0.5" />
            {option}
          </label>
        ))}
      </div>
    );
  }
  if (question.type === 'true_false') {
    return (
      <div className="flex gap-2" role="radiogroup" aria-label={question.question}>
        {[true, false].map((option) => (
          <label
            key={String(option)}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm',
              value === option ? 'border-stone-900 bg-stone-50 ring-1 ring-stone-900' : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50/60'
            )}
          >
            <input type="radio" name={name} checked={value === option} onChange={() => onChange(option)} disabled={disabled} />
            {option ? 'True' : 'False'}
          </label>
        ))}
      </div>
    );
  }
  return (
    <input
      type="text"
      aria-label={`Answer to: ${question.question}`}
      value={value ?? ''}
      maxLength={500}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      placeholder="Type a short answer"
      className="control h-10"
    />
  );
}

function correctAnswerText(q) {
  if (q.type === 'multiple_choice') return q.options[q.correctOption];
  if (q.type === 'true_false') return q.correctBoolean ? 'True' : 'False';
  return q.acceptedAnswers.join(' / ');
}

function responseText(q) {
  if (q.response === null || q.response === undefined || q.response === '') return 'No answer';
  if (q.type === 'multiple_choice') return q.options[q.response] ?? 'No answer';
  if (q.type === 'true_false') return q.response ? 'True' : 'False';
  return q.response;
}

function Review({ result, onRetry, onNew }) {
  const { attempt, questions } = result;
  const percent = Math.round((attempt.score / attempt.total) * 100);
  return (
    <div className="space-y-5 p-5 sm:p-6">
      <div className="flex flex-col gap-3 rounded-xl bg-stone-50 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-stone-500">Your score</p>
          <p className="font-serif text-3xl font-semibold text-stone-900" aria-label={`Score ${attempt.score} of ${attempt.total}`}>
            {attempt.score} / {attempt.total} <span className="text-lg text-stone-500">({percent}%)</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onRetry}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Retry quiz
          </Button>
          <Button variant="ghost" onClick={onNew}>
            New quiz
          </Button>
        </div>
      </div>
      <ol className="space-y-4">
        {questions.map((q, i) => (
          <li key={q.id} className={cn('rounded-lg border p-4', q.correct ? 'border-emerald-200' : 'border-red-200')}>
            <div className="flex items-start gap-2">
              {q.correct ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Correct" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-label="Incorrect" />
              )}
              <p className="text-sm font-medium text-stone-900">
                {i + 1}. {q.question}
              </p>
            </div>
            <dl className="mt-2 space-y-1 pl-6 text-sm">
              <div className="flex gap-1.5">
                <dt className="text-stone-500">Your answer:</dt>
                <dd className={q.correct ? 'text-emerald-700' : 'text-red-700'}>{responseText(q)}</dd>
              </div>
              {!q.correct && (
                <div className="flex gap-1.5">
                  <dt className="text-stone-500">Correct answer:</dt>
                  <dd className="text-stone-900">{correctAnswerText(q)}</dd>
                </div>
              )}
            </dl>
            <p className="mt-2 pl-6 text-sm leading-relaxed text-stone-600">
              {q.explanation}
              <SourceRefs refs={q.refs} />
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TakeQuiz({ quiz, onSubmitted }) {
  const toast = useToast();
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const answered = quiz.questions.filter((q) => answers[q.id] !== undefined && answers[q.id] !== '').length;

  async function submit(event) {
    event.preventDefault();
    if (answered < quiz.questions.length && !window.confirm('Some questions are unanswered. Submit anyway?')) return;
    setBusy(true);
    try {
      onSubmitted(await aiService.submitQuiz(quiz.id, answers));
    } catch (err) {
      toast.error('Could not submit the quiz', getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-serif text-[1.375rem] font-medium text-stone-900">{quiz.title}</h2>
        <Badge>{DIFFICULTIES.find((d) => d.id === quiz.difficulty)?.label}</Badge>
      </div>
      <ol className="space-y-5">
        {quiz.questions.map((q, i) => (
          <li key={q.id} className="space-y-2">
            <p className="text-sm font-medium text-stone-900">
              {i + 1}. {q.question} <span className="ml-1 text-2xs font-normal text-stone-500">{TYPE_LABEL[q.type]}</span>
            </p>
            <AnswerInput question={q} value={answers[q.id]} onChange={(value) => setAnswers((a) => ({ ...a, [q.id]: value }))} disabled={busy} />
          </li>
        ))}
      </ol>
      <div className="flex items-center justify-between border-t border-stone-200/70 pt-4">
        <span className="text-sm text-stone-500">
          {answered} of {quiz.questions.length} answered
        </span>
        <Button type="submit" loading={busy}>
          <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
          Submit answers
        </Button>
      </div>
    </form>
  );
}

export default function QuizPanel({ source }) {
  const toast = useToast();
  const [quizzes, setQuizzes] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [mode, setMode] = useState('take'); // take | review | setup
  const [result, setResult] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [attemptKey, setAttemptKey] = useState(0);
  const [reusedNotice, setReusedNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const items = await aiService.listQuizzes(source.id);
      setQuizzes(items);
      setActiveId((current) => (current && items.some((q) => q.id === current) ? current : items[0]?.id ?? null));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [source.id]);

  useEffect(() => {
    load();
    Promise.resolve()
      .then(() => aiService.getPreferences())
      .then((p) => p && setPrefs(p))
      .catch(() => {});
  }, [load]);

  const active = quizzes?.find((q) => q.id === activeId);
  usePolling(load, isGenerating(active));

  async function create(options) {
    setBusy(true);
    try {
      const { item: quiz, reused } = await aiService.createQuiz(source.id, options);
      setQuizzes((current) => [quiz, ...(current || []).filter((q) => q.id !== quiz.id)]);
      setActiveId(quiz.id);
      // Same settings as an existing quiz: it was opened instead of spending AI quota on a new one.
      setReusedNotice(reused ? options : null);
      setMode('take');
      setResult(null);
    } catch (err) {
      toast.error('Could not create the quiz', getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(quiz) {
    if (!window.confirm('Delete this quiz and its results?')) return;
    try {
      await aiService.deleteQuiz(quiz.id);
      setQuizzes((current) => current.filter((q) => q.id !== quiz.id));
      setActiveId(null);
      setResult(null);
    } catch (err) {
      toast.error('Could not delete the quiz', getErrorMessage(err));
    }
  }

  let body;
  if (quizzes === null && !error) {
    body = (
      <div className="space-y-3 p-6" role="status" aria-label="Loading quizzes">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else if (error && quizzes === null) {
    body = <FailedGeneration item={{ error: { message: getErrorMessage(error) } }} onRetry={load} what="Could not load quizzes" />;
  } else if (mode === 'setup' || !active) {
    body = <QuizSetup onCreate={create} busy={busy} defaults={prefs} />;
  } else if (isGenerating(active)) {
    body = <GeneratingState title="Writing your quiz…" item={active} />;
  } else if (active.status === 'failed') {
    body = <FailedGeneration item={active} onRetry={() => setMode('setup')} what="The quiz could not be generated" />;
  } else if (mode === 'review' && result) {
    body = (
      <Review
        result={result}
        onRetry={() => {
          setResult(null);
          setMode('take');
          setAttemptKey((k) => k + 1);
        }}
        onNew={() => setMode('setup')}
      />
    );
  } else {
    body = (
      <TakeQuiz
        key={`${active.id}-${attemptKey}`}
        quiz={active}
        onSubmitted={(review) => {
          setResult(review);
          setMode('review');
          load();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {quizzes?.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Your quizzes"
            value={activeId || ''}
            onChange={(event) => {
              setActiveId(event.target.value);
              setMode('take');
              setResult(null);
            }}
            className="control h-9 w-auto pr-8"
          >
            {quizzes.map((q) => (
              <option key={q.id} value={q.id}>
                {(q.title || 'Quiz') + ` · ${formatShortDate(q.createdAt)}` + (q.bestScore !== null && q.bestScore !== undefined ? ` · best ${q.bestScore}%` : '')}
              </option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={() => setMode('setup')}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            New quiz
          </Button>
          {active && (
            <Button variant="ghost" size="sm" onClick={() => remove(active)} aria-label="Delete quiz">
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      {reusedNotice && mode !== 'setup' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 bg-stone-50 px-4 py-2.5 text-sm text-stone-600">
          <span>You already had a quiz with these settings, so it was opened (no AI quota used).</span>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => create({ ...reusedNotice, regenerate: true })}
          >
            Generate new questions
          </Button>
        </div>
      )}
      <Card>{body}</Card>
    </div>
  );
}
