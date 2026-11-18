'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const requestLogger = require('./middleware/requestLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const apiRoutes = require('./routes');
const { mountFrontend, contentSecurityPolicy } = require('./frontend');

/**
 * Builds the Express application without starting a server or opening any
 * connections, so tests can mount it directly with supertest.
 *
 * With FRONTEND_DIST_DIR set (production image), the same app also serves the
 * built frontend, so the browser talks to one origin.
 */
function createApp({ frontendDistDir = config.frontend.distDir } = {}) {
  const app = express();
  const servesFrontend = Boolean(frontendDistDir);

  app.disable('x-powered-by');
  // Behind Render's proxy set TRUST_PROXY=1, so rate limits see the real client IP.
  app.set('trust proxy', config.trustProxy);

  app.use(servesFrontend ? helmet({ contentSecurityPolicy: false }) : helmet());
  if (servesFrontend) app.use(contentSecurityPolicy());
  app.use(
    cors({
      origin(origin, callback) {
        // Non-browser clients (curl, server-to-server) send no Origin header.
        if (!origin || config.cors.allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    })
  );

  app.use(express.json({ limit: config.http.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.http.jsonBodyLimit }));
  app.use(cookieParser());
  app.use(requestLogger);

  app.use('/api', apiRoutes);
  if (servesFrontend) mountFrontend(app, frontendDistDir);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
