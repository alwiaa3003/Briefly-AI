import { useState } from 'react';
import { Download } from 'lucide-react';
import Button from '../common/Button';
import { OnThisPage, Paragraphs, RailSection, ReadingSection, SectionTitle } from './Reading';
import RefChips from '../document/RefChips';
import OriginalViewer from '../document/OriginalViewer';
import ExtractedTextViewer from '../document/ExtractedTextViewer';
import { useToast } from '../../hooks/useToast';
import * as sourceService from '../../services/sourceService';
import { cn } from '../../utils/cn';
import { getErrorMessage } from '../../utils/errors';
import { formatDate, formatFileSize } from '../../utils/format';

const FORMAT_LABEL = { pdf: 'PDF', docx: 'Word document', txt: 'Text file' };

export function DownloadOriginalButton({ source }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!source.upload?.available) return null;

  async function download() {
    setBusy(true);
    try {
      const original = await sourceService.getOriginal(source.id, { download: true });
      window.location.assign(original.url);
    } catch (error) {
      toast.error('Could not download the file', getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={download} loading={busy}>
      {!busy && <Download className="h-3.5 w-3.5" aria-hidden="true" />}
      Download original
    </Button>
  );
}

function RefList({ items, refs, onRef, render }) {
  return items.map((item, index) => render(item, refs?.[index], index, onRef));
}

function DocumentFacts({ source }) {
  const doc = source.document || {};
  const rows = [
    ['Format', FORMAT_LABEL[doc.format] || doc.format],
    ['Pages', doc.pageCount ? `${doc.pageCount}${doc.pagesProcessed && doc.pagesProcessed < doc.pageCount ? ` (${doc.pagesProcessed} processed)` : ''}` : null],
    ['Length', doc.wordCount ? `${doc.wordCount.toLocaleString()} words` : null],
    ['Author', doc.author],
    ['Created', doc.created],
    ['File', source.upload ? `${source.upload.originalName} · ${formatFileSize(source.upload.sizeBytes)}` : null],
    ['Text recognition', doc.ocrPages?.length ? `${doc.ocrPages.length} scanned page${doc.ocrPages.length === 1 ? '' : 's'}` : null],
    ['Summarized', formatDate(source.completedAt || source.summary?.createdAt)],
  ].filter(([, value]) => value);

  return (
    <RailSection aria-labelledby="document-heading">
      <SectionTitle id="document-heading">Document</SectionTitle>
      <dl className="mt-4 space-y-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className="mt-0.5 break-words text-stone-700">{value}</dd>
          </div>
        ))}
      </dl>
      {doc.warnings?.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
          {doc.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <p className="mt-5 border-t border-stone-200/70 pt-4 text-xs leading-5 text-stone-500">
        {doc.format === 'pdf'
          ? 'Page references point to the pages where the information appears.'
          : 'Word and text files have no fixed pages, so references point to sections.'}{' '}
        The summary is AI-generated from the extracted text. Check important details against the original.
      </p>
    </RailSection>
  );
}

function SummaryTab({ source, onRef }) {
  const { summary } = source;
  const refs = summary.references || {};

  return (
    <div data-reading="" className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_17.5rem] xl:items-start">
      <div className="min-w-0 max-w-reading space-y-9">
        <ReadingSection aria-labelledby="overview-heading">
          <SectionTitle id="overview-heading">Executive overview</SectionTitle>
          <div className="mt-3 space-y-4 font-serif text-[1.1875rem] leading-[1.7] text-stone-800">
            <Paragraphs text={summary.overview} />
          </div>
        </ReadingSection>

        <ReadingSection aria-labelledby="summary-heading">
          <SectionTitle id="summary-heading">Detailed summary</SectionTitle>
          <div className="mt-5 space-y-7">
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

        {summary.sectionBreakdown?.length > 0 && (
          <ReadingSection aria-labelledby="breakdown-heading">
            <SectionTitle id="breakdown-heading">Section by section</SectionTitle>
            <ol className="mt-4 divide-y divide-stone-200/70">
              {summary.sectionBreakdown.map((section) => (
                <li key={`${section.title}-${section.pages?.join(',')}`} className="py-3 first:pt-0 last:pb-0">
                  <h3 className="text-sm font-semibold text-stone-900">
                    {section.title}
                    <RefChips refs={section} onSelect={onRef} />
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-stone-600">{section.summary}</p>
                </li>
              ))}
            </ol>
          </ReadingSection>
        )}

        {summary.mainArguments?.length > 0 && (
          <ReadingSection aria-labelledby="arguments-heading">
            <SectionTitle id="arguments-heading">Main arguments and conclusions</SectionTitle>
            <ul className="mt-4 space-y-3">
              <RefList
                items={summary.mainArguments}
                refs={refs.mainArguments}
                onRef={onRef}
                render={(argument, ref, index) => (
                  <li key={index} className="border-l-2 border-brand-200 pl-4 text-[0.9375rem] leading-7 text-stone-700">
                    {argument}
                    <RefChips refs={ref} onSelect={onRef} />
                  </li>
                )}
              />
            </ul>
          </ReadingSection>
        )}
      </div>

      <aside className="space-y-7 xl:sticky xl:top-8">
          <OnThisPage />
        <RailSection aria-labelledby="takeaways-heading">
          <SectionTitle id="takeaways-heading">Key takeaways</SectionTitle>
          <ol className="mt-4 space-y-3">
            <RefList
              items={summary.keyTakeaways}
              refs={refs.keyTakeaways}
              onRef={onRef}
              render={(point, ref, index) => (
                <li key={index} className="flex gap-3 text-sm leading-6 text-stone-700">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-2xs font-semibold text-brand-700">
                    {index + 1}
                  </span>
                  <span>
                    {point}
                    <RefChips refs={ref} onSelect={onRef} />
                  </span>
                </li>
              )}
            />
          </ol>
        </RailSection>

        {summary.facts?.length > 0 && (
          <RailSection aria-labelledby="facts-heading">
            <SectionTitle id="facts-heading">Facts and figures</SectionTitle>
            <ul className="mt-4 space-y-3">
              {summary.facts.map((fact) => (
                <li key={fact.statement} className="text-sm leading-6 text-stone-700">
                  {fact.statement}
                  <RefChips refs={fact} onSelect={onRef} />
                </li>
              ))}
            </ul>
          </RailSection>
        )}

        {summary.concepts?.length > 0 && (
          <RailSection aria-labelledby="concepts-heading">
            <SectionTitle id="concepts-heading">Definitions</SectionTitle>
            <dl className="mt-4 space-y-4">
              <RefList
                items={summary.concepts}
                refs={refs.concepts}
                onRef={onRef}
                render={(concept, ref) => (
                  <div key={concept.term}>
                    <dt className="text-sm font-semibold text-stone-900">
                      {concept.term}
                      <RefChips refs={ref} onSelect={onRef} />
                    </dt>
                    <dd className="mt-0.5 text-sm leading-6 text-stone-600">{concept.explanation}</dd>
                  </div>
                )}
              />
            </dl>
          </RailSection>
        )}

        <DocumentFacts source={source} />
      </aside>
    </div>
  );
}

/** Completed document summary with tabs to switch between the summary, the original PDF and the extracted text. */
export default function DocumentSummaryContent({ source }) {
  const isPdf = source.document?.format === 'pdf';
  const canShowOriginal = isPdf && source.upload?.available;
  const [tab, setTab] = useState('summary');
  const [pdfPage, setPdfPage] = useState(null);
  const [textFocus, setTextFocus] = useState(null);

  const tabs = [
    { id: 'summary', label: 'Summary' },
    ...(canShowOriginal ? [{ id: 'original', label: 'Original PDF' }] : []),
    { id: 'text', label: 'Extracted text' },
  ];

  function handleRef(ref) {
    if (ref.page && canShowOriginal) {
      setPdfPage(ref.page);
      setTab('original');
    } else {
      setTextFocus({ ...ref, nonce: Date.now() });
      setTab('text');
    }
  }

  return (
    <div>
      <div role="tablist" aria-label="Document view" className="mb-6 inline-flex gap-1 rounded-lg border border-stone-200 bg-white p-1 shadow-card">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              tab === id ? 'bg-stone-100 text-stone-900' : 'text-stone-500 hover:text-stone-800'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'summary' && <SummaryTab source={source} onRef={handleRef} />}
      {tab === 'original' && <OriginalViewer source={source} page={pdfPage} />}
      {tab === 'text' && <ExtractedTextViewer source={source} focus={textFocus} />}
    </div>
  );
}
