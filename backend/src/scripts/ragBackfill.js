'use strict';

/**
 * npm run rag:backfill [-- --all]
 *
 * Queues indexing for completed sources that are not indexed yet (summarized
 * before Milestone 5, or whose indexing failed). With --all, every completed
 * source is re-indexed (needed after changing EMBEDDING_MODEL / EMBEDDING_DIMENSIONS).
 * A worker (npm run worker) must be running to process the jobs.
 */

const { connectDatabase, disconnectDatabase } = require('../config/database');
const { waitForSharedRedis, closeSharedRedisConnection } = require('../config/redis');
const { closeProcessingQueue } = require('../queues/processingQueue');
const Source = require('../models/Source');
const { scheduleIndexing } = require('../services/rag/indexService');
const { RAG_STATUSES, SOURCE_STATUSES } = require('../queues/constants');

async function main() {
  const all = process.argv.includes('--all');
  await connectDatabase();
  await waitForSharedRedis(15000);

  const filter = { status: SOURCE_STATUSES.COMPLETED };
  if (!all) filter['rag.status'] = { $in: [RAG_STATUSES.NONE, RAG_STATUSES.FAILED, null] };
  const sources = await Source.find(filter).select('_id user').lean();

  let queued = 0;
  for (const source of sources) {
    if (await scheduleIndexing({ sourceId: source._id, userId: source.user, force: all })) queued += 1;
  }
  console.log(`Queued indexing for ${queued} of ${sources.length} source(s).`);
}

main()
  .catch((error) => {
    console.error(`rag:backfill failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeProcessingQueue().catch(() => {});
    await closeSharedRedisConnection().catch(() => {});
    await disconnectDatabase();
  });
