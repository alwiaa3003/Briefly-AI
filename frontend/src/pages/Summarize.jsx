import { useSearchParams } from 'react-router-dom';
import PageContainer from '../components/layout/PageContainer';
import Composer from '../components/summarize/Composer';

const OUTPUT = ['A concise overview', 'Key takeaways and concepts', 'Chapters, timestamps or page references', 'Notes, quizzes and flashcards on demand'];

export default function Summarize() {
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <PageContainer
      width="narrow"
      eyebrow="New reading"
      title="Bring something in"
      description="Add an article, a video or a document. Briefly reads or transcribes it and writes a summary you can study from."
      documentTitle="Summarize"
    >
      <Composer autoFocus value={searchParams.get('source')} onChange={(id) => setSearchParams({ source: id }, { replace: true })} />

      <section aria-labelledby="output-heading" className="mt-12 border-t border-stone-200 pt-6">
        <h2 id="output-heading" className="eyebrow mb-3">
          What you&rsquo;ll get
        </h2>
        <ul className="grid gap-x-6 gap-y-2 text-sm text-stone-600 sm:grid-cols-2">
          {OUTPUT.map((item) => (
            <li key={item} className="flex items-center gap-2.5">
              <span className="h-1 w-1 rounded-full bg-brand-500" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </section>
    </PageContainer>
  );
}
