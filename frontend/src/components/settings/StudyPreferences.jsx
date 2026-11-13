import { useEffect, useState } from 'react';
import { Section, SectionBody, SectionHeader } from './SettingsSection';
import Button from '../common/Button';
import Skeleton from '../common/Skeleton';
import { useToast } from '../../hooks/useToast';
import * as aiService from '../../services/aiService';
import { getErrorMessage } from '../../utils/errors';
import { DIFFICULTIES, QUESTION_TYPES, SUMMARY_STYLES } from '../../utils/study';

const selectClass =
  'control h-10';

/** Defaults for summary styles and study tools. */
export default function StudyPreferences() {
  const toast = useToast();
  const [prefs, setPrefs] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.resolve()
      .then(() => aiService.getPreferences())
      .then(setPrefs)
      .catch(setError);
  }, []);

  const set = (key) => (event) => setPrefs((p) => ({ ...p, [key]: event.target.value }));

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    try {
      setPrefs(
        await aiService.updatePreferences({
          summaryStyle: prefs.summaryStyle,
          quizDifficulty: prefs.quizDifficulty,
          quizQuestionCount: Number(prefs.quizQuestionCount),
          quizQuestionTypes: prefs.quizQuestionTypes,
          flashcardCount: Number(prefs.flashcardCount),
        })
      );
      toast.success('Preferences saved');
    } catch (err) {
      toast.error('Could not save preferences', getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section>
      <SectionHeader title="Study preferences" description="Defaults for summary styles, quizzes and flashcards." />
      <SectionBody>
        {error ? (
          <p className="text-sm text-red-600">{getErrorMessage(error)}</p>
        ) : !prefs ? (
          <div className="grid gap-4 sm:grid-cols-2" role="status" aria-label="Loading preferences">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : (
          <form onSubmit={save} className="grid gap-5 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-stone-700">Default summary style</span>
              <select value={prefs.summaryStyle} onChange={set('summaryStyle')} className={selectClass}>
                {SUMMARY_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-stone-700">Quiz difficulty</span>
              <select value={prefs.quizDifficulty} onChange={set('quizDifficulty')} className={selectClass}>
                {DIFFICULTIES.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-stone-700">Questions per quiz</span>
              <input type="number" min={3} max={30} value={prefs.quizQuestionCount} onChange={set('quizQuestionCount')} className={selectClass} />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-stone-700">Flashcards per deck</span>
              <input type="number" min={5} max={60} value={prefs.flashcardCount} onChange={set('flashcardCount')} className={selectClass} />
            </label>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1.5 text-sm font-medium text-stone-700">Question types</legend>
              <div className="flex flex-wrap gap-4">
                {QUESTION_TYPES.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm text-stone-700">
                    <input
                      type="checkbox"
                      checked={prefs.quizQuestionTypes.includes(t.id)}
                      onChange={() =>
                        setPrefs((p) => ({
                          ...p,
                          quizQuestionTypes: p.quizQuestionTypes.includes(t.id)
                            ? p.quizQuestionTypes.filter((x) => x !== t.id)
                            : [...p.quizQuestionTypes, t.id],
                        }))
                      }
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="sm:col-span-2">
              <Button type="submit" loading={saving} disabled={!prefs.quizQuestionTypes.length}>
                Save preferences
              </Button>
            </div>
          </form>
        )}
      </SectionBody>
    </Section>
  );
}
