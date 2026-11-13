import { formatDate, getHostname, safeExternalUrl } from '../../utils/format';
import { Paragraphs, RailSection, ReadingLayout, ReadingSection, SectionTitle } from './Reading';

export { Paragraphs, SectionTitle };

/** Numbered key takeaways (shared with video summaries). */
export function Takeaways({ items, refs }) {
  return (
    <ol className="mt-4 space-y-3.5">
      {items.map((point, index) => (
        <li key={point} className="flex gap-3 text-sm leading-6 text-stone-700">
          <span className="mt-px w-5 shrink-0 font-serif text-base leading-6 text-brand-600 tabular-nums">{index + 1}</span>
          <span>
            {point}
            {refs?.[index]}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The completed article summary. All text is rendered as plain text (React escapes it),
 * so model output can never inject markup into the page.
 */
export default function SummaryContent({ source }) {
  const { summary, metadata = {} } = source;

  const rail = (
    <>
      <RailSection aria-labelledby="takeaways-heading">
        <SectionTitle id="takeaways-heading">Key takeaways</SectionTitle>
        <Takeaways items={summary.keyTakeaways} />
      </RailSection>

      {summary.concepts?.length > 0 && (
        <RailSection aria-labelledby="concepts-heading">
          <SectionTitle id="concepts-heading">Key concepts</SectionTitle>
          <dl className="mt-4 space-y-4">
            {summary.concepts.map((concept) => (
              <div key={concept.term}>
                <dt className="text-sm font-semibold text-stone-900">{concept.term}</dt>
                <dd className="mt-0.5 text-sm leading-6 text-stone-600">{concept.explanation}</dd>
              </div>
            ))}
          </dl>
        </RailSection>
      )}

      <RailSection aria-labelledby="source-heading">
        <SectionTitle id="source-heading">Source</SectionTitle>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-xs text-stone-500">Website</dt>
            <dd className="mt-0.5 break-words text-stone-700">
              <a href={safeExternalUrl(source.url)} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-stone-300 underline-offset-2 hover:text-stone-900 hover:decoration-stone-500">
                {getHostname(source.url) || source.url}
              </a>
            </dd>
          </div>
          {metadata.wordCount ? (
            <div>
              <dt className="text-xs text-stone-500">Length</dt>
              <dd className="mt-0.5 text-stone-700">{metadata.wordCount.toLocaleString()} words</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-stone-500">Summarized</dt>
            <dd className="mt-0.5 text-stone-700">{formatDate(source.completedAt || summary.createdAt)}</dd>
          </div>
        </dl>
        <p className="mt-5 text-xs leading-5 text-stone-500">
          {summary.inputTruncated || source.contentTruncated ? 'This article was very long, so only its first part was summarized. ' : ''}
          Summaries are AI-generated from the article text. Check important details against the original.
        </p>
      </RailSection>
    </>
  );

  return (
    <ReadingLayout rail={rail}>
      <ReadingSection aria-labelledby="overview-heading">
        <SectionTitle id="overview-heading">Overview</SectionTitle>
        <div className="mt-3 space-y-4 font-serif text-[1.1875rem] leading-[1.7] text-stone-800">
          <Paragraphs text={summary.overview} />
        </div>
      </ReadingSection>

      <ReadingSection aria-labelledby="summary-heading">
        <SectionTitle id="summary-heading">Detailed summary</SectionTitle>
        <div className="mt-5 space-y-8">
          {summary.sections.map((section) => (
            <section key={section.heading}>
              <h3 className="font-serif text-xl font-medium text-stone-900">{section.heading}</h3>
              <div className="reading mt-2.5">
                <Paragraphs text={section.content} />
              </div>
            </section>
          ))}
        </div>
      </ReadingSection>

      {summary.mainArguments?.length > 0 && (
        <ReadingSection aria-labelledby="arguments-heading">
          <SectionTitle id="arguments-heading">Main arguments and conclusions</SectionTitle>
          <ul className="mt-4 space-y-4">
            {summary.mainArguments.map((argument) => (
              <li key={argument} className="border-l-2 border-brand-300 pl-5 font-serif text-[1.0625rem] italic leading-relaxed text-stone-700">
                {argument}
              </li>
            ))}
          </ul>
        </ReadingSection>
      )}
    </ReadingLayout>
  );
}
