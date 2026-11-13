'use strict';

const { z } = require('zod');

// bcrypt only uses the first 72 bytes of a password, so longer input is rejected
// rather than silently truncated.
const BCRYPT_MAX_BYTES = 72;

const email = z
  .string({ required_error: 'Email is required.', invalid_type_error: 'Email must be a string.' })
  .trim()
  .toLowerCase()
  .min(1, 'Email is required.')
  .max(254, 'Email is too long.')
  .email('Enter a valid email address.');

const newPassword = z
  .string({ required_error: 'Password is required.', invalid_type_error: 'Password must be a string.' })
  .min(8, 'Password must be at least 8 characters.')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_BYTES, 'Password must be at most 72 bytes.')
  .refine((value) => /[A-Za-z]/.test(value), 'Password must contain at least one letter.')
  .refine((value) => /\d/.test(value), 'Password must contain at least one number.');

const registerSchema = z.object({
  name: z
    .string({ required_error: 'Name is required.', invalid_type_error: 'Name must be a string.' })
    .trim()
    .min(2, 'Name must be at least 2 characters.')
    .max(80, 'Name must be at most 80 characters.'),
  email,
  password: newPassword,
});

const loginSchema = z.object({
  email,
  password: z
    .string({ required_error: 'Password is required.', invalid_type_error: 'Password must be a string.' })
    .min(1, 'Password is required.')
    .max(256, 'Password is too long.'),
});

module.exports = { registerSchema, loginSchema, BCRYPT_MAX_BYTES };
