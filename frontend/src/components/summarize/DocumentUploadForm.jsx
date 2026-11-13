import { FileText } from 'lucide-react';
import Notice from '../common/Notice';
import FileUploadForm from './FileUploadForm';
import * as sourceService from '../../services/sourceService';
import { ACCEPTED_DOCUMENT_EXTENSIONS, ACCEPTED_DOCUMENT_MIME_TYPES } from '../../utils/contentTypes';
import { formatFileSize } from '../../utils/format';

function extensionOf(name) {
  const match = /\.[^.]+$/.exec(name || '');
  return match ? match[0].toLowerCase() : '';
}

const GENERIC_TYPES = new Set(['', 'application/octet-stream']);

export function validateDocumentFile(file, config) {
  const ext = extensionOf(file.name);
  if (ext === '.doc') return 'Legacy .doc files are not supported. Save the document as .docx and upload it again.';
  if (ext === '.docm') return 'Macro-enabled Word documents are not supported. Save it as a regular .docx.';
  if (!ACCEPTED_DOCUMENT_EXTENSIONS.includes(ext)) return 'Choose a PDF, DOCX or TXT document.';
  if (!GENERIC_TYPES.has(file.type) && !ACCEPTED_DOCUMENT_MIME_TYPES.some((type) => file.type.startsWith(type))) {
    return 'This file does not look like a PDF, DOCX or TXT document.';
  }
  if (file.size === 0) return 'The file is empty.';
  if (config && file.size > config.maxBytes) {
    return `The file is ${formatFileSize(file.size)}; the limit is ${formatFileSize(config.maxBytes)}.`;
  }
  return null;
}

const LABELS = {
  drop: 'Drop a document here, or click to browse',
  hint: (config) => `PDF, DOCX or TXT${config ? ` · up to ${formatFileSize(config.maxBytes)}` : ''}`,
  inputLabel: 'Choose a document',
  choose: 'Choose a document to upload.',
  submit: 'Upload and summarize',
  created: 'Document uploaded',
  createdDescription: 'Briefly is reading and summarizing it now.',
  note: (config) =>
    `Scanned PDFs are read with text recognition. Files are private and deleted after ${config.retentionDays} days; the summary and extracted text are kept.`,
};

const SETUP_NOTICE = (
  <Notice title="Document uploads aren't set up on this server">
    Uploaded documents are stored in object storage (such as Cloudflare R2 or S3), which has not been configured yet.
    An administrator needs to set the <code className="text-xs">STORAGE_*</code> variables in{' '}
    <code className="text-xs">backend/.env</code> (see the README). Articles and YouTube links work without it.
  </Notice>
);

export default function DocumentUploadForm() {
  return (
    <FileUploadForm
      loadConfig={sourceService.getDocumentUploadConfig}
      upload={sourceService.uploadDocument}
      validate={validateDocumentFile}
      accept={[...ACCEPTED_DOCUMENT_EXTENSIONS, ...ACCEPTED_DOCUMENT_MIME_TYPES].join(',')}
      icon={FileText}
      labels={LABELS}
      setupNotice={SETUP_NOTICE}
    />
  );
}
