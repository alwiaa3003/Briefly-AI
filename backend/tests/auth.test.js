'use strict';

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const User = require('../src/models/User');
const RefreshToken = require('../src/models/RefreshToken');
const { REUSE_GRACE_PERIOD_MS } = require('../src/services/tokenService');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();

const validUser = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'analytical1' };

function register(body = validUser) {
  return request(app).post('/api/auth/register').send(body);
}

function getRefreshCookie(res) {
  const cookies = res.headers['set-cookie'] || [];
  return cookies.find((cookie) => cookie.startsWith('briefly_rt='));
}

function cookieValue(setCookie) {
  return setCookie.split(';')[0];
}

beforeAll(startTestDatabase);
afterEach(clearTestDatabase);
afterAll(stopTestDatabase);

describe('POST /api/auth/register', () => {
  test('creates an account and starts a session', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(res.body.data.user.id).toMatch(/^[a-f0-9]{24}$/);
    expect(res.body.data.user.createdAt).toBeDefined();
    expect(typeof res.body.data.accessToken).toBe('string');
  });

  test('never returns the password or its hash', async () => {
    const res = await register();
    const body = JSON.stringify(res.body);

    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(body).not.toContain(validUser.password);
    expect(body).not.toContain('$2b$');
  });

  test('stores a bcrypt hash, not the plain password', async () => {
    await register();
    const stored = await User.findOne({ email: validUser.email }).select('+passwordHash');

    expect(stored.passwordHash).not.toBe(validUser.password);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    await expect(bcrypt.compare(validUser.password, stored.passwordHash)).resolves.toBe(true);
  });

  test('sets the refresh token as an httpOnly, SameSite=Strict cookie scoped to /api/auth', async () => {
    const res = await register();
    const cookie = getRefreshCookie(res);

    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    // Only the hash is persisted.
    const raw = decodeURIComponent(cookieValue(cookie).split('=')[1]);
    expect(await RefreshToken.countDocuments({ tokenHash: raw })).toBe(0);
    expect(await RefreshToken.countDocuments()).toBe(1);
  });

  test('normalizes email (trim + lowercase)', async () => {
    const res = await register({ ...validUser, email: '  ADA@Example.COM ' });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('ada@example.com');
  });

  test('rejects a duplicate email with 409, case-insensitively', async () => {
    await register();
    const res = await register({ ...validUser, email: 'ADA@example.com' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'EMAIL_IN_USE', message: 'An account with this email already exists.' },
    });
    expect(await User.countDocuments()).toBe(1);
  });

  test.each([
    ['an invalid email', { ...validUser, email: 'not-an-email' }, 'email'],
    ['a short password', { ...validUser, password: 'abc12' }, 'password'],
    ['a password without numbers', { ...validUser, password: 'onlyletters' }, 'password'],
    ['a password without letters', { ...validUser, password: '1234567890' }, 'password'],
    ['a password over 72 bytes', { ...validUser, password: `a1${'x'.repeat(71)}` }, 'password'],
    ['a missing name', { email: validUser.email, password: validUser.password }, 'name'],
    ['a one-letter name', { ...validUser, name: 'A' }, 'name'],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body, field) => {
    const res = await register(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((detail) => detail.field)).toContain(field);
    expect(await User.countDocuments()).toBe(0);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => register());

  test('logs in with valid credentials', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: validUser.email, password: validUser.password });

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(validUser.email);
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(getRefreshCookie(res)).toBeDefined();
  });

  test('accepts the email in any case', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'Ada@Example.com', password: validUser.password });
    expect(res.status).toBe(200);
  });

  test('rejects a wrong password with 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: validUser.email, password: 'wrongpass1' });

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
    expect(getRefreshCookie(res)).toBeUndefined();
  });

  test('rejects an unknown email with the same 401 response', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: validUser.password });

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
  });

  test('rejects a missing password with 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: validUser.email });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/auth/me', () => {
  test('rejects requests without a token', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('rejects a malformed token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-jwt');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({}, 'some-other-secret-that-is-long-enough-123', {
      subject: '507f1f77bcf86cd799439011',
      issuer: 'briefly-ai-api',
      audience: 'briefly-ai-web',
    });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('rejects an expired token', async () => {
    const expired = jwt.sign({}, process.env.JWT_ACCESS_SECRET, {
      subject: '507f1f77bcf86cd799439011',
      issuer: 'briefly-ai-api',
      audience: 'briefly-ai-web',
      expiresIn: -10,
    });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  test('returns the current user for a valid token', async () => {
    const { body } = await register();
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: validUser.email, name: validUser.name });
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });
});

describe('Session refresh and logout', () => {
  test('rotates the refresh token and issues a new access token', async () => {
    const first = await register();
    const cookie = cookieValue(getRefreshCookie(first));

    const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(validUser.email);
    expect(typeof res.body.data.accessToken).toBe('string');
    const rotated = getRefreshCookie(res);
    expect(rotated).toBeDefined();
    expect(cookieValue(rotated)).not.toBe(cookie);
  });

  test('rejects refresh without a cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NO_SESSION');
  });

  test('a just-rotated token is rejected without ending other sessions (concurrent refresh race)', async () => {
    const first = await register();
    const original = cookieValue(getRefreshCookie(first));

    const rotatedRes = await request(app).post('/api/auth/refresh').set('Cookie', original);
    const rotated = cookieValue(getRefreshCookie(rotatedRes));

    const replay = await request(app).post('/api/auth/refresh').set('Cookie', original);
    expect(replay.status).toBe(401);

    const stillValid = await request(app).post('/api/auth/refresh').set('Cookie', rotated);
    expect(stillValid.status).toBe(200);
  });

  test('detects reuse of an old rotated refresh token and revokes all sessions', async () => {
    const first = await register();
    const original = cookieValue(getRefreshCookie(first));

    const rotatedRes = await request(app).post('/api/auth/refresh').set('Cookie', original);
    const rotated = cookieValue(getRefreshCookie(rotatedRes));

    // Pretend the original token was rotated well outside the grace period.
    await RefreshToken.updateMany(
      { revokedAt: { $ne: null } },
      { $set: { revokedAt: new Date(Date.now() - REUSE_GRACE_PERIOD_MS - 1000) } }
    );

    // Replaying the old token fails ...
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', original);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_SESSION');

    // ... and also invalidates the legitimately rotated one.
    const afterReplay = await request(app).post('/api/auth/refresh').set('Cookie', rotated);
    expect(afterReplay.status).toBe(401);
  });

  test('logout revokes the refresh token and clears the cookie', async () => {
    const first = await register();
    const cookie = cookieValue(getRefreshCookie(first));

    const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBe(200);
    expect(getRefreshCookie(logout)).toMatch(/Expires=Thu, 01 Jan 1970/);

    const refresh = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(refresh.status).toBe(401);
  });
});
