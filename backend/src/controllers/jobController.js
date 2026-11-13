'use strict';

const jobService = require('../services/jobService');
const { sendSuccess } = require('../utils/http');

/** POST /api/jobs/test — queues an infrastructure test job for the current user. */
async function createTestJob(req, res) {
  const job = await jobService.createTestJob({ userId: req.auth.userId, message: req.body.message });
  return sendSuccess(res, 202, { job: job.toJSON() });
}

/** GET /api/jobs/:id — status of one of the current user's jobs. */
async function getJob(req, res) {
  const job = await jobService.getJobForUser(req.params.id, req.auth.userId);
  return sendSuccess(res, 200, { job: job.toJSON() });
}

module.exports = { createTestJob, getJob };
