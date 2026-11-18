/** Turns an axios error into a message that is safe and useful to show to users. */
export function getErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return fallback;
  if (error.response?.data?.error?.message) return error.response.data.error.message;
  // Errors that already carry a user-facing explanation (e.g. a failed transfer to storage).
  if (error.userMessage) return error.userMessage;
  if (error.serverStarting) return 'Briefly is still starting up. Please try again in a moment.';
  if (error.code === 'ECONNABORTED') return 'The request timed out. Please try again.';
  if (error.request && !error.response) return 'Cannot reach the server. Check that the API is running.';
  return fallback;
}

/** Maps API validation details to `{ fieldName: message }`. */
export function getFieldErrors(error) {
  const details = error?.response?.data?.error?.details;
  if (!Array.isArray(details)) return {};
  return details.reduce((acc, { field, message }) => {
    if (field && !acc[field]) acc[field] = message;
    return acc;
  }, {});
}
