'use strict';

const { UnrecoverableError } = require('bullmq');
const Source = require('../../models/Source');
const Summary = require('../../models/Summary');
const processingClient = require('../../services/processingClient');
const { ProcessingServiceError } = processingClient;
const { SOURCE_STATUSES } = require('../../queues/constants');
const { summaryResultSchema, extractResultSchema } = require('../../validators/summaryValidator');
const { summaryInputHash, reuseSummary } = require('../../services/ai/summaryCache');

function badResponse(stage) {
  return new ProcessingServiceError(`The ${stage} result could not be used.`, {
    code: stage === 'extraction' ? 'ARTICLE_BAD_EXTRACTION' : 'AI_INVALID_RESPONSE',
    retryable: false,
  });
}

function setStatus(sourceId, status) {
  return Source.updateOne({ _id: sourceId }, { $set: { status, error: null } });
}

/**
 * summarize_article job:
 *   1. extract  - the Python service fetches the page safely and extracts text + metadata
 *   2. persist  - text and metadata are stored on the Source (once)
 *   3. summarize - the Python service calls Gemini; the result is validated
 *   4. persist  - a Summary document is upserted and the Source marked completed
 *
 * Idempotent across retries: a source that is already extracted skips step 1,
 * and the Summary upsert (unique per source) can never create duplicates.
 */
async function handleSummarizeArticle({ input }) {
  const source = await Source.findById(input.sourceId).select('+content');
  if (!source) throw new UnrecoverableError('The article no longer exists.');

  if (source.status === SOURCE_STATUSES.COMPLETED && source.summary) {
    return { sourceId: source.id, summaryId: source.summary.toString() };
  }

  if (!source.extractedAt || !source.content) {
    await setStatus(source._id, SOURCE_STATUSES.EXTRACTING);
    const raw = await processingClient.extractArticle({ url: source.submittedUrl });
    const parsed = extractResultSchema.safeParse(raw);
    if (!parsed.success) throw badResponse('extraction');
    const extracted = parsed.data;

    source.finalUrl = extracted.final_url;
    source.canonicalUrl = extracted.canonical_url;
    source.metadata = {
      title: extracted.title,
      author: extracted.author,
      publishedAt: extracted.published_at,
      siteName: extracted.site_name,
      description: extracted.description,
      language: extracted.language,
      wordCount: extracted.word_count,
    };
    source.content = extracted.content;
    source.contentTruncated = extracted.content_truncated;
    source.extractedAt = new Date();
    await source.save();
  }

  const inputHash = summaryInputHash('article', [source.content, source.metadata?.title || null]);
  const cached = await reuseSummary(source, inputHash);
  if (cached) return { sourceId: source.id, summaryId: cached.id, cached: true };

  await setStatus(source._id, SOURCE_STATUSES.SUMMARIZING);
  const raw = await processingClient.summarizeArticle({
    url: source.canonicalUrl || source.finalUrl || source.submittedUrl,
    title: source.metadata?.title,
    author: source.metadata?.author,
    publishedAt: source.metadata?.publishedAt,
    siteName: source.metadata?.siteName,
    content: source.content,
  });
  const parsed = summaryResultSchema.safeParse(raw);
  if (!parsed.success) throw badResponse('summary');
  const { summary, model, prompt_version: promptVersion, input_truncated: inputTruncated, usage } = parsed.data;

  const saved = await Summary.findOneAndUpdate(
    { source: source._id },
    {
      $set: {
        user: source.user,
        title: summary.title,
        overview: summary.overview,
        sections: summary.sections,
        keyTakeaways: summary.key_takeaways,
        concepts: summary.concepts,
        mainArguments: summary.main_arguments,
        model,
        promptVersion,
        inputHash,
        inputTruncated,
        inputCharacters: parsed.data.input_characters ?? null,
        usage: { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null },
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  await Source.updateOne(
    { _id: source._id },
    {
      $set: {
        status: SOURCE_STATUSES.COMPLETED,
        summary: saved._id,
        completedAt: new Date(),
        error: null,
        failedAt: null,
      },
    }
  );

  return { sourceId: source.id, summaryId: saved.id };
}

/** Called by the processor when the job will not be retried again. */
handleSummarizeArticle.onFinalFailure = async ({ input, error }) => {
  await Source.updateOne(
    { _id: input.sourceId, status: { $ne: SOURCE_STATUSES.COMPLETED } },
    { $set: { status: SOURCE_STATUSES.FAILED, error, failedAt: new Date() } }
  );
};

module.exports = handleSummarizeArticle;
