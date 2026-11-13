'use strict';

const processingClient = require('../../services/processingClient');

/**
 * Infrastructure test job: performs an authenticated round-trip to the
 * Python processing service and stores its response as the job result.
 */
async function handleTestJob({ input, processingJobId }) {
  const response = await processingClient.runInternalTest({
    message: input.message,
    jobId: processingJobId,
  });
  return { processingService: response };
}

module.exports = handleTestJob;
