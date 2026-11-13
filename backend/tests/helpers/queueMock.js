'use strict';

/**
 * Stand-in for src/queues/processingQueue.js so API tests can exercise job
 * submission without Redis. Use with:
 *   jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
 */
const state = { available: true, failAdd: false, added: [] };

module.exports = {
  DEFAULT_JOB_OPTIONS: Object.freeze({ attempts: 3 }),
  isQueueAvailable: () => state.available,
  addProcessingJob: async (job) => {
    if (state.failAdd) throw new Error('simulated Redis failure');
    state.added.push(job);
    return { id: job.jobId };
  },
  getProcessingQueue: () => {
    throw new Error('not available in unit tests');
  },
  closeProcessingQueue: async () => {},
  __state: state,
  __reset() {
    state.available = true;
    state.failAdd = false;
    state.added.length = 0;
  },
};
