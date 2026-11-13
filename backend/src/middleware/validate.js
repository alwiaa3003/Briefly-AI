'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Validates and normalizes request data with zod schemas.
 * On success the parsed (trimmed, defaulted, stripped) values replace the
 * originals so controllers only ever see validated input.
 *
 *   router.post('/', validate({ body: schema }), controller)
 */
function validate(schemas) {
  return function validationMiddleware(req, _res, next) {
    const details = [];

    for (const location of ['params', 'query', 'body']) {
      const schema = schemas[location];
      if (!schema) continue;

      const result = schema.safeParse(req[location] ?? {});
      if (result.success) {
        req[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          details.push({ field: issue.path.join('.') || location, message: issue.message });
        }
      }
    }

    if (details.length > 0) return next(ApiError.validation(details));
    return next();
  };
}

module.exports = validate;
