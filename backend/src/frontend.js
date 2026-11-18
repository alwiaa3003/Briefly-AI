'use strict';

/**
 * Production single-origin deployment: Express serves the built React app (frontend/dist).
 *
 * One origin for the app and the API keeps the SameSite=Strict refresh cookie working
 * (*.onrender.com is a public suffix, so separate services there would be different sites).
 *
 * - Hashed build assets (/assets/*) are cached for a year; index.html is never cached, so a
 *   deploy is picked up on the next load.
 * - Any other GET for a page (no file extension, not /api) returns index.html, so client-side
 *   routes like /library/123 survive a reload. /api/* never reaches the fallback.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const config = require('./config/env');

const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Origins of the object storage (presigned upload PUTs, video playback, PDF viewer). */
function storageOrigins() {
  const { endpoint, bucket, forcePathStyle } = config.storage;
  if (!endpoint) return [];
  try {
    const url = new URL(endpoint);
    const origins = [url.origin];
    // Virtual-hosted style URLs put the bucket in the host name.
    if (!forcePathStyle && bucket) origins.push(`${url.protocol}//${bucket}.${url.host}`);
    return origins;
  } catch {
    return [];
  }
}

/** Content-Security-Policy for the app pages: only the hosts the UI actually uses. */
function contentSecurityPolicy() {
  const storage = storageOrigins();
  return helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      // Video thumbnails come from YouTube's image hosts.
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'media-src': ["'self'", 'blob:', ...storage],
      'frame-src': ['https://www.youtube-nocookie.com', 'https://www.youtube.com', ...storage],
      // Direct uploads PUT to object storage.
      'connect-src': ["'self'", ...storage],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
    },
  });
}

/** Mounts the built frontend. Throws at startup when the build is missing (a deploy mistake). */
function mountFrontend(app, distDir = config.frontend.distDir) {
  const root = path.resolve(distDir);
  const indexFile = path.join(root, 'index.html');
  if (!fs.existsSync(indexFile)) {
    throw new Error(`FRONTEND_DIST_DIR is set but ${indexFile} does not exist. Build the frontend first.`);
  }

  app.use(
    express.static(root, {
      index: false,
      redirect: false,
      setHeaders(res, filePath) {
        const hashedAsset = filePath.startsWith(path.join(root, 'assets') + path.sep);
        res.setHeader('Cache-Control', hashedAsset ? `public, max-age=${YEAR_SECONDS}, immutable` : 'no-cache');
      },
    })
  );

  // SPA fallback: page navigations only (GET/HEAD, not /api, no file extension).
  app.get(/^\/(?!api(?:\/|$))(?!.*\.[a-z0-9]+$).*/i, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  });
}

module.exports = { mountFrontend, contentSecurityPolicy, storageOrigins };
