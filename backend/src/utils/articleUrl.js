'use strict';

const net = require('net');
const ApiError = require('./ApiError');

/**
 * First-line URL validation and normalization for article submissions.
 *
 * This gives users immediate feedback and keeps obviously unsafe URLs out of
 * the queue. It is NOT the security boundary: the processing service
 * re-validates every URL and redirect after DNS resolution and connects only
 * to the validated IP (see processing-service/app/extractors/url_safety.py).
 */

const MAX_URL_LENGTH = 2048;
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.home.arpa', '.corp', '.private'];
const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|ref_src)$/i;

// IPv4 ranges that are never valid article hosts.
const BLOCKED_IPV4_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isBlockedIPv4(ip) {
  const value = ipv4ToInt(ip);
  return BLOCKED_IPV4_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function invalid(message = 'Enter a valid article URL starting with http:// or https://.') {
  return ApiError.badRequest(message, 'INVALID_URL');
}

function unsafe(message) {
  return ApiError.badRequest(message, 'UNSAFE_URL');
}

/**
 * @returns {{ url: string, normalizedUrl: string, hostname: string }}
 * @throws {ApiError} 400 INVALID_URL | UNSAFE_URL
 */
function parseArticleUrl(input) {
  if (typeof input !== 'string') throw invalid();
  const trimmed = input.trim();
  if (!trimmed) throw invalid('Enter an article URL.');
  if (trimmed.length > MAX_URL_LENGTH) throw invalid('The URL is too long.');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\\]/.test(trimmed)) throw invalid();

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalid();
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('Only http:// and https:// links are supported.');
  }
  if (url.username || url.password) throw unsafe('URLs containing usernames or passwords are not allowed.');
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw unsafe('Only standard web ports (80 and 443) are allowed.');
  }

  // WHATWG URL parsing already lowercases hosts and canonicalizes IPv4 shorthand
  // such as "127.1", "0x7f000001" or "2130706433" into dotted form.
  const hostname = url.hostname.replace(/\.$/, '');
  if (!hostname) throw invalid();

  if (hostname.startsWith('[')) {
    throw unsafe('Links to IP addresses are not supported. Use the website’s domain name.');
  }
  if (net.isIPv4(hostname)) {
    if (isBlockedIPv4(hostname)) throw unsafe('Links to private or internal network addresses are not allowed.');
  } else {
    if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      throw unsafe('Links to local or internal hosts are not allowed.');
    }
    if (!hostname.includes('.')) throw unsafe('Links to local or internal hosts are not allowed.');
  }

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.hostname = hostname;

  const cleanUrl = url.toString();
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '';
  const normalizedUrl = `${url.protocol}//${url.host}${pathname}${url.search}`;

  return { url: cleanUrl, normalizedUrl, hostname };
}

module.exports = { parseArticleUrl, isBlockedIPv4, MAX_URL_LENGTH };
