import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Copy, FileQuestion, RotateCcw } from 'lucide-react';
import { Card } from '../components/common/Card';
import Button, { ButtonLink } from '../components/common/Button';
import EmptyState from '../components/common/EmptyState';
import Notice from '../components/common/Notice';
import ProcessingSteps from '../components/summary/ProcessingSteps';
import SourceHeader from '../components/summary/SourceHeader';
import SummaryContent from '../components/summary/SummaryContent';
import VideoSummaryContent from '../components/summary/VideoSummaryContent';
import DocumentSummaryContent, { DownloadOriginalButton } from '../components/summary/DocumentSummaryContent';
import SummarySkeleton from '../components/summary/SummarySkeleton';
import SourceWorkspace from '../components/study/SourceWorkspace';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import * as sourceService from '../services/sourceService';
import { getErrorMessage } from '../utils/errors';
import { formatFileSize } from '../utils/format';
import { isInProgress } from '../utils/sourceStatus';
import { summaryToMarkdown } from '../utils/summaryMarkdown';

export const POLL_INTERVAL_MS = 2000;

function BackLink() {
  return (
    <Link to="/library" className="inline-flex items-center gap-1.5 text-xs font-medium text-stone-500 transition-colors hover:text-stone-900">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Library
    </Link>
  );
}

function CopyButton({ source }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(summaryToMarkdown(source));
      setCopied(true);
      toast.success('Summary copied', 'Paste it anywhere as Markdown.');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access.');
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleCopy}>
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy summary'}
    </Button>
  );
}

function SubmittedItem({ source }) {
  if (source.kind === 'video' || source.kind === 'document') {
    return (
      <p className="mt-1 break-all text-sm text-stone-500">
        {source.upload?.originalName || (source.kind === 'document' ? 'Uploaded document' : 'Uploaded video')}
        {source.upload?.sizeBytes ? ` · ${formatFileSize(source.upload.sizeBytes)}` : ''}
      </p>
    );
  }
  return <p className="mt-1 break-all text-sm text-stone-500">{source.submittedUrl}</p>;
}

function ProcessingState({ source }) {
  const isVideo = source.kind !== 'article';
  const thumbnail = source.video?.thumbnailUrl;
  return (
    <Card className="max-w-2xl p-6 sm:p-7">
      <div className="flex gap-4">
        {thumbnail && (
          <img
            src={thumbnail}
            alt=""
            className="hidden aspect-video w-32 shrink-0 rounded-md object-cover sm:block"
            referrerPolicy="no-referrer"
          />
        )}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-stone-900">Working on your summary</h2>
          <SubmittedItem source={source} />
        </div>
      </div>
      <div className="mt-6">
        <ProcessingSteps status={source.status} job={source.job} kind={source.kind} progress={source.progress} source={source} />
      </div>
      {source.job?.waiting?.reason?.message && (
        <Notice title="Paused: waiting for AI capacity" className="mt-5">
          {source.job.waiting.reason.message}
        </Notice>
      )}
      <p className="mt-6 border-t border-stone-200/70 pt-4 text-xs text-stone-500">
        {source.kind === 'document'
          ? 'Long or scanned documents can take several minutes. You can leave this page. The summary will be saved to your library.'
          : isVideo
          ? 'Videos take a few minutes, longer for long recordings. You can leave this page. The summary will be saved to your library.'
          : 'This usually takes under a minute. You can leave this page. The summary will be saved to your library.'}
      </p>
    </Card>
  );
}

const FAILED_TITLE = {
  article: 'This article could not be summarized',
  youtube: 'This video could not be summarized',
  video: 'This video could not be summarized',
  document: 'This document could not be summarized',
};

const SUMMARIZE_TAB = { article: 'article', youtube: 'youtube', video: 'upload', document: 'document' };
const AGAIN_LABEL = {
  article: 'Summarize another article',
  youtube: 'Summarize another video',
  video: 'Upload a video',
  document: 'Upload a document',
};

function FailedState({ source, onRetry, retrying }) {
  const isUpload = source.kind === 'video' || source.kind === 'document';
  const extracted = source.kind === 'document' && source.document?.extractedAt;
  const uploadGone = isUpload && !extracted && source.upload && !source.upload.available;
  return (
    <div className="max-w-2xl space-y-4">
      <Notice variant="error" title={FAILED_TITLE[source.kind] ?? FAILED_TITLE.article}>
        {source.error?.message || 'Something went wrong while processing this item.'}
      </Notice>
      <Card className="p-6">
        <p className="text-sm text-stone-600">
          {isUpload ? 'Uploaded file: ' : 'Submitted link: '}
          <span className="break-all text-stone-900">
            {isUpload ? source.upload?.originalName || 'file' : source.submittedUrl}
          </span>
        </p>
        {uploadGone && (
          <p className="mt-2 text-xs text-stone-500">The uploaded file has been removed, so it needs to be uploaded again.</p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {!uploadGone && (
            <Button onClick={onRetry} loading={retrying}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Try again
            </Button>
          )}
          <ButtonLink to={`/summarize?source=${SUMMARIZE_TAB[source.kind] ?? 'article'}`} variant={uploadGone ? 'primary' : 'secondary'}>
            {AGAIN_LABEL[source.kind] ?? 'Summarize another article'}
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}

export default function SummaryDetail() {
  const { id } = useParams();
  const toast = useToast();
  const [source, setSource] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);

  useDocumentTitle(source?.summary?.title || source?.metadata?.title || 'Summary');

  const load = useCallback(async () => {
    try {
      const result = await sourceService.getSource(id);
      if (mounted.current) {
        setSource(result);
        setLoadError(null);
      }
      return result;
    } catch (error) {
      if (mounted.current) setLoadError(error);
      return null;
    }
  }, [id]);

  useEffect(() => {
    mounted.current = true;
    setSource(null);
    setLoadError(null);
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // Poll while the article is being processed.
  const status = source?.status;
  useEffect(() => {
    if (!isInProgress(status)) return undefined;
    const timer = setTimeout(load, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [status, source, load]);

  async function handleRetry() {
    setRetrying(true);
    try {
      await sourceService.retrySource(id);
      await load();
      toast.info('Retrying', 'The article has been queued again.');
    } catch (error) {
      toast.error('Could not retry', getErrorMessage(error));
    } finally {
      if (mounted.current) setRetrying(false);
    }
  }

  let body;
  if (loadError && !source) {
    const notFound = loadError.response?.status === 404 || loadError.response?.status === 400;
    body = (
      <Card>
        <EmptyState
          icon={FileQuestion}
          title={notFound ? 'Summary not found' : 'Could not load this summary'}
          description={
            notFound ? 'It may have been removed, or the link is incorrect.' : getErrorMessage(loadError)
          }
          action={
            notFound ? (
              <ButtonLink to="/library" variant="secondary" size="sm">
                Back to library
              </ButtonLink>
            ) : (
              <Button variant="secondary" size="sm" onClick={load}>
                Try again
              </Button>
            )
          }
        />
      </Card>
    );
  } else if (!source) {
    body = <SummarySkeleton />;
  } else {
    body = (
      <>
        <SourceHeader
          source={source}
          actions={
            source.status === 'completed' && source.summary ? (
              <>
                <CopyButton source={source} />
                {source.kind === 'document' && <DownloadOriginalButton source={source} />}
              </>
            ) : null
          }
        />
        {source.status === 'completed' && source.summary ? (
          <SourceWorkspace
            source={source}
            summary={
              source.kind === 'article' ? (
                <SummaryContent source={source} />
              ) : source.kind === 'document' ? (
                <DocumentSummaryContent source={source} />
              ) : (
                <VideoSummaryContent source={source} />
              )
            }
          />
        ) : source.status === 'failed' ? (
          <FailedState source={source} onRetry={handleRetry} retrying={retrying} />
        ) : (
          <ProcessingState source={source} />
        )}
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-page px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
      <div className="mb-6">
        <BackLink />
      </div>
      {body}
    </div>
  );
}
