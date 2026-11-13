import { apiClient } from './apiClient';

/** GET /api/health/ready — resolves even when degraded (HTTP 503 still carries the report). */
export async function getSystemStatus() {
  const response = await apiClient.get('/health/ready', {
    validateStatus: (status) => status === 200 || status === 503,
  });
  return response.data.data;
}

/** Submits the infrastructure test job (API -> BullMQ -> worker -> Python). */
export async function createTestJob(message) {
  const response = await apiClient.post('/jobs/test', { message });
  return response.data.data.job;
}

export async function getJob(jobId) {
  const response = await apiClient.get(`/jobs/${jobId}`);
  return response.data.data.job;
}
