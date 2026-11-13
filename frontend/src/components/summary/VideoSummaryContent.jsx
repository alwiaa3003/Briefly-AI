import { useRef } from 'react';
import { OnThisPage, Paragraphs, RailSection, ReadingSection, SectionTitle } from './Reading';
import VideoPlayer from '../video/VideoPlayer';
import TimestampButton from '../video/TimestampButton';
import TranscriptViewer from '../video/TranscriptViewer';
import { formatDate, formatDuration, formatFileSize, formatTimestamp } from '../../utils/format';

function captionsDescription(captions) {
  if (!captions || captions.available === null || captions.available === undefined) return null;
  if (!captions.available) return 'YouTube lists no caption tracks for this video.';
  const parts = [];
  if (captions.manualLanguages?.length) parts.push(`creator-provided (${captions.manualLanguages.join(', ')})`);
  if (captions.autoLanguages?.length) parts.push(`auto-generated (${captions.autoLanguages.join(', ')})`);
  return parts.length ? `YouTube lists captions: ${parts.join('; ')}.` : null;
}

/**
 * Completed video summary. Chapter, key-moment and transcript timestamps
 * seek the embedded player. Every timestamp was checked against the transcript
 * on the server; none are generated in the browser.
 */
export default function VideoSummaryContent({ source }) {
  const playerRef = useRef(null);
  const { summary, video = {}, upload } = source;
  const seek = (seconds) => {
    playerRef.current?.seek(seconds);
    document.getElementById('video-player')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  };
  const captionNote = source.kind === 'youtube' ? captionsDescription(video.captions) : null;

  return (
    <div className="space-y-6">
      <div data-reading="" className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_17.5rem] xl:items-start">
        <div className="min-w-0 max-w-reading space-y-9">
          <div id="video-player">
            <VideoPlayer ref={playerRef} source={source} />
          </div>

          <ReadingSection aria-labelledby="overview-heading">
            <SectionTitle id="overview-heading">Overview</SectionTitle>
            <div className="mt-3 space-y-4 font-serif text-[1.1875rem] leading-[1.7] text-stone-800">
              <Paragraphs text={summary.overview} />
            </div>
          </ReadingSection>

          {summary.chapters?.length > 0 && (
            <ReadingSection aria-labelledby="chapters-heading">
              <SectionTitle id="chapters-heading">Chapters</SectionTitle>
              <ol className="mt-4 divide-y divide-stone-200/70">
                {summary.chapters.map((chapter) => (
                  <li key={`${chapter.startSeconds}-${chapter.title}`} className="flex gap-4 py-3 first:pt-0 last:pb-0">
                    <TimestampButton seconds={chapter.startSeconds} onSeek={seek} className="mt-0.5" />
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-stone-900">{chapter.title}</h3>
                      <p className="mt-0.5 text-sm leading-6 text-stone-600">{chapter.summary}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </ReadingSection>
          )}

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

          {summary.mainArguments?.length > 0 && (
            <ReadingSection aria-labelledby="arguments-heading">
              <SectionTitle id="arguments-heading">Main arguments and conclusions</SectionTitle>
              <ul className="mt-4 space-y-3">
                {summary.mainArguments.map((argument) => (
                  <li key={argument} className="border-l-2 border-brand-200 pl-4 text-[0.9375rem] leading-7 text-stone-700">
                    {argument}
                  </li>
                ))}
              </ul>
            </ReadingSection>
          )}
        </div>

        <aside className="space-y-7 xl:sticky xl:top-8">
          <OnThisPage />
          <RailSection aria-labelledby="takeaways-heading">
            <SectionTitle id="takeaways-heading">Key takeaways</SectionTitle>
            <ol className="mt-4 space-y-3">
              {summary.keyTakeaways.map((point, index) => (
                <li key={point} className="flex gap-3 text-sm leading-6 text-stone-700">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-2xs font-semibold text-brand-700">
                    {index + 1}
                  </span>
                  <span>{point}</span>
                </li>
              ))}
            </ol>
          </RailSection>

          {summary.keyMoments?.length > 0 && (
            <RailSection aria-labelledby="moments-heading">
              <SectionTitle id="moments-heading">Key moments</SectionTitle>
              <ul className="mt-4 space-y-3">
                {summary.keyMoments.map((moment) => (
                  <li key={`${moment.seconds}-${moment.description}`} className="flex gap-3 text-sm leading-6 text-stone-700">
                    <TimestampButton seconds={moment.seconds} onSeek={seek} className="mt-0.5" />
                    <span>{moment.description}</span>
                  </li>
                ))}
              </ul>
            </RailSection>
          )}

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
              {video.durationSeconds ? (
                <div>
                  <dt className="text-xs text-stone-500">Length</dt>
                  <dd className="mt-0.5 text-stone-700">
                    {formatDuration(video.durationSeconds)} ({formatTimestamp(video.durationSeconds)})
                  </dd>
                </div>
              ) : null}
              {upload && (
                <div>
                  <dt className="text-xs text-stone-500">File</dt>
                  <dd className="mt-0.5 break-words text-stone-700">
                    {upload.originalName} · {formatFileSize(upload.sizeBytes)}
                  </dd>
                </div>
              )}
              {source.transcript?.available && (
                <div>
                  <dt className="text-xs text-stone-500">Transcript</dt>
                  <dd className="mt-0.5 text-stone-700">
                    {source.transcript.wordCount.toLocaleString()} words
                    {source.transcript.language ? ` · ${source.transcript.language}` : ''}
                    {source.transcript.hasSpeakerLabels ? ' · speaker labels' : ''}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-stone-500">Summarized</dt>
                <dd className="mt-0.5 text-stone-700">{formatDate(source.completedAt || summary.createdAt)}</dd>
              </div>
            </dl>
            <p className="mt-5 border-t border-stone-200/70 pt-4 text-xs leading-5 text-stone-500">
              {summary.inputTruncated ? 'This recording was very long, so only its first part was summarized. ' : ''}
              {captionNote ? `${captionNote} ` : ''}
              The transcript and summary are AI-generated. Timestamps point to where the transcript has the matching speech.
            </p>
          </RailSection>
        </aside>
      </div>

      {source.transcript?.available && <TranscriptViewer source={source} onSeek={seek} />}
    </div>
  );
}
