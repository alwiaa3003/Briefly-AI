import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '../common/Card';
import Badge from '../common/Badge';
import Button from '../common/Button';
import EmptyState from '../common/EmptyState';
import Spinner from '../common/Spinner';
import * as sourceService from '../../services/sourceService';
import { cn } from '../../utils/cn';
import { getErrorMessage } from '../../utils/errors';

const PAGE_SIZE = 50;

function sectionKey(name) {
  return (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function TableBlock({ text }) {
  const rows = text.split('\n').map((row) => row.split(' | '));
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">
        <tbody>
          {rows.map((cells, r) => (
            <tr key={r} className={r === 0 ? 'bg-stone-50 font-medium' : ''}>
              {cells.map((cell, c) => (
                <td key={c} className="border border-stone-200 px-2 py-1 text-stone-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block }) {
  if (block.kind === 'heading') {
    const size = block.level === 1 ? 'text-base' : 'text-sm';
    return <h4 className={cn('font-semibold text-stone-900', size)}>{block.text}</h4>;
  }
  if (block.kind === 'table') return <TableBlock text={block.text} />;
  return <p className="whitespace-pre-line text-sm leading-6 text-stone-700">{block.text}</p>;
}

/** Plain-text rendering of the extracted content (React escapes everything; no HTML is rendered). */
export default function ExtractedTextViewer({ source, focus }) {
  const [parts, setParts] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const container = useRef(null);

  const load = useCallback(
    async (page) => {
      const result = await sourceService.getDocumentText(source.id, { page, limit: PAGE_SIZE });
      setParts((current) => (page === 1 ? result.parts : [...current, ...result.parts]));
      setMeta(result);
      return result;
    },
    [source.id]
  );

  useEffect(() => {
    load(1).catch(setError);
  }, [load]);

  // Load until the referenced part is present, then scroll to it.
  const focused = focus
    ? parts.find((p) => (focus.page ? p.page === focus.page : (p.headingPath || []).concat(p.blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).some((h) => sectionKey(h) === sectionKey(focus.section))))
    : null;
  useEffect(() => {
    if (!focus || !meta) return;
    if (focused) {
      container.current?.querySelector(`[data-part="${focused.index}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } else if (meta.page < meta.totalPages && !loadingMore) {
      setLoadingMore(true);
      load(meta.page + 1)
        .catch(setError)
        .finally(() => setLoadingMore(false));
    }
  }, [focus, focused, meta, load, loadingMore]);

  if (error) return <Card><EmptyState title="The extracted text could not be loaded" description={getErrorMessage(error)} /></Card>;
  if (!meta) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
        <Spinner size="sm" /> Loading extracted text…
      </div>
    );
  }

  const isPdf = source.document?.format === 'pdf';
  return (
    <Card className="p-5 sm:p-7">
      <p className="mb-5 text-xs text-stone-500">
        Text as Briefly extracted it from the file{isPdf ? ', page by page' : ''}. Formatting is simplified; check the original for
        layout, images and charts.
      </p>
      <div ref={container} className="space-y-6">
        {parts.map((part) => (
          <section
            key={part.index}
            data-part={part.index}
            aria-label={part.page ? `Page ${part.page}` : `Part ${part.index + 1}`}
            className={cn('scroll-mt-24 rounded-lg', focused?.index === part.index && 'bg-amber-50/60 ring-1 ring-amber-200')}
          >
            <div className="mb-2 flex items-center gap-2 border-b border-stone-200/70 pb-1.5">
              <span className="text-2xs font-semibold uppercase tracking-wider text-stone-500">
                {part.page ? `Page ${part.page}` : `Part ${part.index + 1}`}
                {!part.page && part.headingPath?.length ? ` · ${part.headingPath.join(' › ')}` : ''}
              </span>
              {part.ocr && <Badge>Text recognition</Badge>}
            </div>
            {part.blocks.length ? (
              <div className="space-y-3">
                {part.blocks.map((block, index) => (
                  <Block key={index} block={block} />
                ))}
              </div>
            ) : (
              <p className="text-sm italic text-stone-500">No text on this page.</p>
            )}
          </section>
        ))}
      </div>
      {meta.page < meta.totalPages && (
        <div className="mt-6 flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            loading={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              load(meta.page + 1)
                .catch(setError)
                .finally(() => setLoadingMore(false));
            }}
          >
            Load more
          </Button>
        </div>
      )}
    </Card>
  );
}
