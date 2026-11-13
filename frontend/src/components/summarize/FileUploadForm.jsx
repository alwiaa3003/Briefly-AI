import { useEffect, useId, useRef, useState } from 'react';
import { UploadCloud, X } from 'lucide-react';
import Button from '../common/Button';
import Notice from '../common/Notice';
import Spinner from '../common/Spinner';
import SubmitRow from './SubmitRow';
import { useSubmitAndOpen } from './useSubmitAndOpen';
import { useToast } from '../../hooks/useToast';
import { cn } from '../../utils/cn';
import { getErrorMessage } from '../../utils/errors';
import { formatFileSize } from '../../utils/format';

const FILE_ERROR_CODES = new Set([
  'UNSUPPORTED_VIDEO_TYPE',
  'UNSUPPORTED_DOCUMENT_TYPE',
  'FILE_TOO_LARGE',
  'EMPTY_FILE',
]);

/**
 * Generic upload form: drag-and-drop or picker, client-side validation, upload
 * progress, cancel, and a clear "storage not configured" state.
 *
 * Props:
 *   loadConfig()                     -> { enabled, maxBytes, retentionDays, ... }
 *   upload(file, { onProgress, signal })
 *   validate(file, config)           -> error message | null
 *   inspect(file, config)            -> Promise<{ details?: string, error?: string }> (optional, best effort)
 *   accept, icon, labels: { drop, hint(config), choose, submit, created, createdDescription, setupTitle }
 */
export default function FileUploadForm({ loadConfig, upload, validate, inspect, accept, icon: FileIcon, labels, setupNotice }) {
  const inputId = useId();
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const open = useSubmitAndOpen();
  const toast = useToast();

  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [file, setFile] = useState(null);
  const [details, setDetails] = useState('');
  const [fileError, setFileError] = useState('');
  const [formError, setFormError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(null); // null = not uploading, 0..1 while uploading

  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((result) => !cancelled && setConfig(result))
      .catch((error) => !cancelled && setConfigError(error));
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [loadConfig]);

  const uploading = progress !== null;
  const enabled = Boolean(config?.enabled);

  async function selectFile(selected) {
    if (!selected || uploading) return;
    setFormError('');
    setDetails('');
    const error = validate(selected, config);
    setFile(selected);
    setFileError(error || '');
    if (error || !inspect) return;
    const result = await inspect(selected, config);
    if (result?.details) setDetails(result.details);
    if (result?.error) setFileError(result.error);
  }

  function clearFile() {
    setFile(null);
    setFileError('');
    setDetails('');
    if (inputRef.current) inputRef.current.value = '';
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (uploading || !enabled) return;
    if (!file) {
      setFileError(labels.choose);
      return;
    }
    if (fileError) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setFormError('');
    setProgress(0);
    try {
      const result = await upload(file, { onProgress: setProgress, signal: controller.signal });
      open(result, { createdTitle: labels.created, createdDescription: labels.createdDescription });
    } catch (err) {
      if (controller.signal.aborted || err.code === 'ERR_CANCELED') {
        toast.info('Upload cancelled');
      } else {
        const code = err.response?.data?.error?.code;
        const message = getErrorMessage(err, 'The file could not be uploaded. Please try again.');
        if (FILE_ERROR_CODES.has(code)) setFileError(message);
        else setFormError(message);
      }
      setProgress(null);
    } finally {
      abortRef.current = null;
    }
  }

  if (!config && !configError) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
        <Spinner size="sm" /> Checking upload settings…
      </div>
    );
  }

  const percent = uploading ? Math.round(progress * 100) : 0;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5" aria-busy={uploading || undefined}>
      {configError && <Notice variant="error">{getErrorMessage(configError, 'Upload settings could not be loaded.')}</Notice>}
      {config && !enabled && setupNotice}
      {formError && <Notice variant="error">{formError}</Notice>}

      <label
        htmlFor={inputId}
        aria-disabled={!enabled || uploading || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          if (enabled && !uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (enabled) selectFile(event.dataTransfer.files?.[0]);
        }}
        className={cn(
          'flex flex-col items-center rounded-xl border-[1.5px] border-dashed px-6 py-12 text-center transition-colors duration-150',
          !enabled || uploading
            ? 'cursor-not-allowed border-stone-200 bg-stone-50 opacity-70'
            : dragging
              ? 'cursor-pointer border-brand-400 bg-brand-50/60'
              : 'cursor-pointer border-stone-300 bg-white hover:border-stone-400 hover:bg-stone-50/60'
        )}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-stone-100">
          <UploadCloud className="h-5 w-5 text-stone-500" aria-hidden="true" />
        </span>
        <span className="mt-4 text-sm font-medium text-stone-900">{labels.drop}</span>
        <span className="mt-1 text-xs text-stone-500">{labels.hint(config)}</span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="sr-only"
          aria-label={labels.inputLabel}
          accept={accept}
          disabled={!enabled || uploading}
          onChange={(event) => selectFile(event.target.files?.[0])}
        />
      </label>

      {file && (
        <div className={cn('rounded-lg border bg-white px-4 py-3', fileError ? 'border-red-200' : 'border-stone-200')}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <FileIcon className="h-4 w-4 shrink-0 text-stone-400" aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-stone-900">{file.name}</p>
                <p className="text-xs text-stone-500">
                  {formatFileSize(file.size)}
                  {details ? ` · ${details}` : ''}
                </p>
              </div>
            </div>
            {!uploading && (
              <button
                type="button"
                onClick={clearFile}
                className="rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                aria-label="Remove selected file"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          {fileError && (
            <p role="alert" className="mt-2 text-xs text-red-600">
              {fileError}
            </p>
          )}
          {uploading && (
            <div className="mt-3">
              <div
                className="h-1.5 overflow-hidden rounded-full bg-stone-100"
                role="progressbar"
                aria-label="Upload progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div className="h-full rounded-full bg-stone-900 transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-stone-500">
                {percent < 100 ? `Uploading… ${percent}%` : 'Finishing upload and checking the file…'}
              </p>
            </div>
          )}
        </div>
      )}
      {!file && fileError && (
        <p role="alert" className="text-xs text-red-600">
          {fileError}
        </p>
      )}

      <SubmitRow
        disabled={!enabled || Boolean(fileError)}
        loading={uploading}
        label={uploading ? 'Uploading…' : labels.submit}
        note={config?.enabled ? labels.note(config) : 'Uploads become available once storage is configured.'}
        extra={
          uploading ? (
            <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
              Cancel
            </Button>
          ) : null
        }
      />
    </form>
  );
}
