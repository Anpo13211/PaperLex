import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, verifyCaptureToken } from '../lib/auth.mjs';

test('sessions are signed, bounded payloads and reject tampering', () => {
  const auth = createAuth({ password: 'browser-secret', sessionSecret: 'signing-secret' });
  const cookie = auth.sessionCookie();
  const value = cookie.match(/^paperlex_session=([^;]+)/)[1];
  assert.equal(auth.isAuthorized({ headers: { cookie: `paperlex_session=${value}` } }), true);
  assert.equal(auth.isAuthorized({ headers: { cookie: `paperlex_session=${value}x` } }), false);
  assert.match(auth.sessionCookie({ secure: true }), /; Secure$/);
  assert.match(auth.clearCookie(), /Max-Age=0/);
});

test('capture always requires the configured secret', () => {
  assert.equal(verifyCaptureToken({ headers: {} }, ''), false);
  assert.equal(verifyCaptureToken({ headers: { 'x-paperlex-token': 'correct' } }, 'correct'), true);
  assert.equal(verifyCaptureToken({ headers: { authorization: 'Bearer correct' } }, 'correct'), true);
  assert.equal(verifyCaptureToken({ headers: { 'x-paperlex-token': 'wrong' } }, 'correct'), false);
});
