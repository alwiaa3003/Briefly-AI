import { Fragment } from 'react';
import { cn } from '../../utils/cn';

/*
 * Minimal, safe Markdown for AI-generated text (answers, styled summaries, notes).
 * Supports paragraphs, "-"/"*" and "1." lists, "#".."###" headings, **bold**, *italic*
 * and `code`. Everything is rendered as React text nodes — no HTML is ever injected,
 * so model output cannot add markup, links or scripts to the page.
 */

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

function inline(text) {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i} className="font-semibold text-stone-900">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i} className="rounded bg-stone-100 px-1 py-px font-mono text-[0.85em] text-stone-800">{part.slice(1, -1)}</code>;
    if (((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function parse(text) {
  const blocks = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*(#{1,3})\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] });
    } else if (bullet || numbered) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

export default function Markdown({ text, className }) {
  return (
    <div className={cn('space-y-3', className)}>
      {parse(text).map((block, i) => {
        if (block.type === 'h') {
          return (
            <p key={i} className="pt-1 font-sans text-sm font-semibold text-stone-900">
              {inline(block.text)}
            </p>
          );
        }
        if (block.type === 'ul' || block.type === 'ol') {
          const List = block.type;
          return (
            <List key={i} className={cn('space-y-1.5 pl-5', block.type === 'ul' ? 'list-disc marker:text-stone-400' : 'list-decimal marker:text-stone-500')}>
              {block.items.map((item, j) => (
                <li key={j} className="pl-1">
                  {inline(item)}
                </li>
              ))}
            </List>
          );
        }
        return <p key={i}>{inline(block.text)}</p>;
      })}
    </div>
  );
}

export { parse as parseMarkdown };
