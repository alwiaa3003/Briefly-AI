/**
 * Client-side validation mirroring the API rules (backend/src/validators).
 * The server remains the source of truth; this only gives faster feedback.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MAX_BYTES = 72;

export function validateEmail(email) {
  const value = email.trim();
  if (!value) return 'Email is required.';
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) return 'Enter a valid email address.';
  return null;
}

export function validateNewPassword(password) {
  if (!password) return 'Password is required.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return 'Password is too long.';
  if (!/[A-Za-z]/.test(password)) return 'Password must contain at least one letter.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  return null;
}

function compact(errors) {
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message));
}

export function validateLoginForm({ email, password }) {
  return compact({
    email: validateEmail(email),
    password: password ? null : 'Password is required.',
  });
}

export function validateRegisterForm({ name, email, password, confirmPassword }) {
  const trimmedName = name.trim();
  return compact({
    name: !trimmedName
      ? 'Name is required.'
      : trimmedName.length < 2
        ? 'Name must be at least 2 characters.'
        : trimmedName.length > 80
          ? 'Name must be at most 80 characters.'
          : null,
    email: validateEmail(email),
    password: validateNewPassword(password),
    confirmPassword: !confirmPassword
      ? 'Please confirm your password.'
      : confirmPassword !== password
        ? 'Passwords do not match.'
        : null,
  });
}

export function isValidHttpUrl(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const LOCAL_HOST_PATTERN = /(^localhost$)|(\.(localhost|local|internal|lan|home|corp|private)$)/;
const PRIVATE_IPV4_PATTERN = /^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/**
 * Quick client-side check for article URLs. Mirrors the API rules so most
 * mistakes are caught before submitting; the server remains authoritative.
 */
export function validateArticleUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter an article URL.';
  if (trimmed.length > 2048) return 'The URL is too long.';

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a full URL starting with http:// or https://.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http:// and https:// links are supported.';
  if (url.username || url.password) return 'URLs containing usernames or passwords are not allowed.';
  if (url.port && url.port !== '80' && url.port !== '443') return 'Only standard web ports (80 and 443) are allowed.';

  const host = url.hostname.replace(/\.$/, '');
  if (host.startsWith('[') || PRIVATE_IPV4_PATTERN.test(host) || LOCAL_HOST_PATTERN.test(host) || !host.includes('.')) {
    return 'Links to local or private network addresses are not allowed.';
  }
  return null;
}

const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'];

export function isYouTubeUrl(value) {
  if (!isValidHttpUrl(value)) return false;
  return YOUTUBE_HOSTS.includes(new URL(value.trim()).hostname.toLowerCase());
}
