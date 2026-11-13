import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderApp, TEST_USER, apiError } from './renderApp';
import { DOCX_SOURCE, DOCX_TEXT, PDF_SOURCE, PDF_TEXT } from './documentFixtures';
import * as authService from '../services/authService';
import * as sourceService from '../services/sourceService';
import { summaryToMarkdown } from '../utils/summaryMarkdown';

vi.mock('../services/authService');
vi.mock('../services/systemService');
vi.mock('../services/sourceService');
vi.mock('../services/aiService');

const ENABLED = { enabled: true, maxBytes: 50 * 1024 * 1024, maxPages: 1000, retentionDays: 30 };
const SIGNED = 'https://acct.r2.example/documents/x?X-Amz-Signature=abc';

beforeEach(() => {
  vi.resetAllMocks();
  authService.refreshSession.mockResolvedValue({ user: TEST_USER, accessToken: 'token' });
  sourceService.getDocumentUploadConfig.mockResolvedValue(ENABLED);
  sourceService.getOriginal.mockResolvedValue({ url: SIGNED, inline: true, filename: 'urban-heat.pdf', format: 'pdf' });
  sourceService.getDocumentText.mockResolvedValue(PDF_TEXT);
});

function docFile(name, type, size = 4096) {
  const file = new File([new Uint8Array(16)], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('Document upload tab', () => {
  test('explains the setup requirement when storage is not configured', async () => {
    sourceService.getDocumentUploadConfig.mockResolvedValue({ ...ENABLED, enabled: false });
    renderApp('/summarize?source=document');

    expect(await screen.findByText("Document uploads aren't set up on this server")).toBeInTheDocument();
    expect(screen.getByLabelText('Choose a document')).toBeDisabled();
  });

  test.each([
    ['old.doc', 'application/msword', 'Legacy .doc files are not supported. Save the document as .docx and upload it again.'],
    ['macro.docm', 'application/vnd.ms-word.document.macroEnabled.12', 'Macro-enabled Word documents are not supported. Save it as a regular .docx.'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Choose a PDF, DOCX or TXT document.'],
    ['image.pdf', 'image/png', 'This file does not look like a PDF, DOCX or TXT document.'],
  ])('rejects %s before uploading', async (name, type, message) => {
    renderApp('/summarize?source=document');
    await screen.findByLabelText('Choose a document');
    const dropzone = screen.getByText('Drop a document here, or click to browse').closest('label');
    fireEvent.drop(dropzone, { dataTransfer: { files: [docFile(name, type)] } });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(sourceService.uploadDocument).not.toHaveBeenCalled();
  });

  test('rejects files over the size limit', async () => {
    const { user } = renderApp('/summarize?source=document');
    await user.upload(await screen.findByLabelText('Choose a document'), docFile('big.pdf', 'application/pdf', 60 * 1024 * 1024));
    expect(await screen.findByText('The file is 60.0 MB; the limit is 50.0 MB.')).toBeInTheDocument();
  });

  test.each([
    ['report.pdf', 'application/pdf'],
    ['review.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['notes.txt', 'text/plain'],
  ])('uploads %s with progress and opens the processing page', async (name, type) => {
    sourceService.uploadDocument.mockImplementation(async (file, { onProgress }) => {
      onProgress(0.6);
      return { source: { ...PDF_SOURCE, status: 'extracting', summary: null }, job: { id: 'j' }, duplicate: false };
    });
    sourceService.getSource.mockResolvedValue({ ...PDF_SOURCE, status: 'extracting', summary: null, progress: { current: 1, total: 4, stage: 'ocr' } });
    const { user } = renderApp('/summarize?source=document');

    await user.upload(await screen.findByLabelText('Choose a document'), docFile(name, type));
    await user.click(screen.getByRole('button', { name: /Upload and summarize/ }));

    expect(sourceService.uploadDocument.mock.calls[0][0].name).toBe(name);
    expect(await screen.findByText('Document uploaded')).toBeInTheDocument();
    expect(await screen.findByText('Reading document')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Text recognition progress' })).toBeInTheDocument();
    expect(screen.getByText('Scanned page 2 of 4')).toBeInTheDocument();
  });

  test('shows server-side signature rejections next to the file', async () => {
    sourceService.uploadDocument.mockRejectedValue(apiError(415, 'UNSUPPORTED_DOCUMENT_TYPE', 'The file content is not a valid PDF, DOCX or TXT document.'));
    const { user } = renderApp('/summarize?source=document');
    await user.upload(await screen.findByLabelText('Choose a document'), docFile('renamed.pdf', 'application/pdf'));
    await user.click(screen.getByRole('button', { name: /Upload and summarize/ }));
    expect(await screen.findByText('The file content is not a valid PDF, DOCX or TXT document.')).toBeInTheDocument();
  });
});

describe('Document summary page', () => {
  test('shows metadata, executive overview, sections, facts, definitions and page references', async () => {
    sourceService.getSource.mockResolvedValue(PDF_SOURCE);
    renderApp(`/library/${PDF_SOURCE.id}`);

    const title = await screen.findByRole('heading', { level: 1, name: 'Urban Heat Report' });
    const header = title.closest('header');
    expect(within(header).getByText('PDF')).toBeInTheDocument();
    expect(within(header).getByText('12 pages')).toBeInTheDocument();
    expect(within(header).getByText('By Example Institute')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Executive overview' })).toBeInTheDocument();
    const breakdown = screen.getByRole('heading', { name: 'Section by section' }).closest('section');
    expect(within(breakdown).getByRole('button', { name: 'Go to page 1' })).toBeInTheDocument();
    expect(within(breakdown).getByRole('button', { name: 'Go to page 5' })).toBeInTheDocument();
    expect(screen.getByText('Canopy is 31% in wealthy districts and 12% elsewhere.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Definitions' })).toBeInTheDocument();
    expect(screen.getByText('2 scanned pages')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Original PDF' })).toBeInTheDocument();
  });

  test('clicking a page reference opens the original PDF at that page', async () => {
    sourceService.getSource.mockResolvedValue(PDF_SOURCE);
    const { user } = renderApp(`/library/${PDF_SOURCE.id}`);

    const facts = (await screen.findByRole('heading', { name: 'Facts and figures' })).closest('section');
    await user.click(within(facts).getByRole('button', { name: 'Go to page 6' }));

    const frame = await screen.findByTitle('Original document, page 6');
    expect(frame).toHaveAttribute('src', `${SIGNED}#page=6`);
    expect(screen.getByRole('tab', { name: 'Original PDF' })).toHaveAttribute('aria-selected', 'true');
    expect(sourceService.getOriginal).toHaveBeenCalledWith(PDF_SOURCE.id);
  });

  test('the extracted text tab shows pages, tables and OCR badges as plain text', async () => {
    sourceService.getSource.mockResolvedValue(PDF_SOURCE);
    const { user } = renderApp(`/library/${PDF_SOURCE.id}`);

    await user.click(await screen.findByRole('tab', { name: 'Extracted text' }));

    const page3 = await screen.findByRole('region', { name: 'Page 3' });
    expect(within(page3).getByText('Text recognition')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Page 2' })).getByRole('table')).toBeInTheDocument();
    expect(sourceService.getDocumentText).toHaveBeenCalledWith(PDF_SOURCE.id, { page: 1, limit: 50 });
  });

  test('DOCX references point to sections and open the extracted text there', async () => {
    sourceService.getSource.mockResolvedValue(DOCX_SOURCE);
    sourceService.getDocumentText.mockResolvedValue(DOCX_TEXT);
    const { user } = renderApp(`/library/${DOCX_SOURCE.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Quarterly Review' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Original PDF' })).not.toBeInTheDocument(); // DOCX is never rendered inline
    expect(screen.getByText(/references point to sections/)).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Go to section Outlook' })[0]);

    const part = await screen.findByRole('region', { name: 'Part 2' });
    await waitFor(() => expect(part.className).toContain('ring-amber-200'));
    expect(screen.getByRole('tab', { name: 'Extracted text' })).toHaveAttribute('aria-selected', 'true');
  });

  test('download original requests an attachment URL', async () => {
    sourceService.getSource.mockResolvedValue(DOCX_SOURCE);
    sourceService.getOriginal.mockResolvedValue({ url: 'https://acct.r2.example/doc?sig=1', inline: false });
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign });
    const { user } = renderApp(`/library/${DOCX_SOURCE.id}`);

    await user.click(await screen.findByRole('button', { name: /Download original/ }));
    expect(sourceService.getOriginal).toHaveBeenCalledWith(DOCX_SOURCE.id, { download: true });
    expect(assign).toHaveBeenCalledWith('https://acct.r2.example/doc?sig=1');
  });

  test('explains when the original file has been removed', async () => {
    sourceService.getSource.mockResolvedValue(PDF_SOURCE);
    sourceService.getOriginal.mockRejectedValue(apiError(410, 'UPLOAD_EXPIRED', 'The original file was removed after 30 days. The extracted text and summary are still available.'));
    const { user } = renderApp(`/library/${PDF_SOURCE.id}`);

    await user.click(await screen.findByRole('tab', { name: 'Original PDF' }));
    expect(await screen.findByText(/original file was removed after 30 days/)).toBeInTheDocument();
  });

  test('copies the summary as Markdown with page references', async () => {
    sourceService.getSource.mockResolvedValue(PDF_SOURCE);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { user } = renderApp(`/library/${PDF_SOURCE.id}`);

    await user.click(await screen.findByRole('button', { name: 'Copy summary' }));
    const markdown = writeText.mock.calls[0][0];
    expect(markdown).toBe(summaryToMarkdown(PDF_SOURCE));
    expect(markdown).toContain('- Canopy is 31% in wealthy districts and 12% elsewhere. (pp. 5, 6)');
    expect(markdown).toContain('### 1. Introduction (pp. 1, 2)');
    expect(markdown).toContain('- Trees cool streets. (p. 2)');
  });

  test('a failed extracted document can be retried even if its file is gone', async () => {
    sourceService.getSource.mockResolvedValue({
      ...PDF_SOURCE,
      status: 'failed',
      summary: null,
      error: { code: 'AI_UNAVAILABLE', message: 'The AI service is temporarily unavailable.' },
      upload: { ...PDF_SOURCE.upload, available: false },
    });
    renderApp(`/library/${PDF_SOURCE.id}`);

    expect(await screen.findByText('This document could not be summarized')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  test('a failed document that was never extracted asks for a new upload', async () => {
    sourceService.getSource.mockResolvedValue({
      ...PDF_SOURCE,
      status: 'failed',
      summary: null,
      document: { format: 'pdf' },
      error: { code: 'DOCUMENT_ENCRYPTED', message: 'This PDF is password-protected. Remove the password and upload it again.' },
      upload: { ...PDF_SOURCE.upload, available: false },
    });
    renderApp(`/library/${PDF_SOURCE.id}`);

    expect(await screen.findByText(/password-protected/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upload a document' })).toHaveAttribute('href', '/summarize?source=document');
  });

  test('long documents show the combining step and section progress', async () => {
    sourceService.getSource.mockResolvedValue({
      ...PDF_SOURCE,
      status: 'summarizing',
      summary: null,
      document: { ...PDF_SOURCE.document, strategy: 'combine' },
      progress: { current: 2, total: 9, stage: 'chunks' },
    });
    renderApp(`/library/${PDF_SOURCE.id}`);

    expect(await screen.findByText('Section 3 of 9')).toBeInTheDocument();
    expect(screen.getByText('Combining')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Summarization progress' })).toBeInTheDocument();
  });
});
