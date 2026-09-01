import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeNetworkConfig, loadConfig } from '../lib/config.mjs';

test('loadConfig accepts a strict TCP port and rejects partial values', () => {
  assert.equal(loadConfig({ PAPERLEX_PORT: '8787' }, '/tmp').port, 8787);
  for (const value of ['0', '65536', '8787junk', '8787.5', ' 8787', '']) {
    const environment = value === '' ? { PAPERLEX_PORT: '0' } : { PAPERLEX_PORT: value };
    assert.throws(() => loadConfig(environment, '/tmp'), /Invalid PAPERLEX_PORT/);
  }
});

test('non-loopback listening requires both browser and capture credentials', () => {
  const safe = loadConfig({
    PAPERLEX_HOST: '0.0.0.0',
    PAPERLEX_PASSWORD: 'browser-secret',
    PAPERLEX_CAPTURE_TOKEN: 'capture-secret-long-enough-123',
  }, '/tmp');
  assert.doesNotThrow(() => assertSafeNetworkConfig(safe));

  assert.throws(() => assertSafeNetworkConfig(loadConfig({
    PAPERLEX_HOST: '0.0.0.0',
    PAPERLEX_CAPTURE_TOKEN: 'capture-secret-long-enough-123',
  }, '/tmp')), /PAPERLEX_PASSWORD/);

  assert.throws(() => assertSafeNetworkConfig(loadConfig({
    PAPERLEX_HOST: '0.0.0.0',
    PAPERLEX_PASSWORD: 'browser-secret',
  }, '/tmp')), /PAPERLEX_CAPTURE_TOKEN/);

  assert.throws(() => assertSafeNetworkConfig(loadConfig({
    PAPERLEX_HOST: '127.0.0.1',
  }, '/tmp')), /PAPERLEX_CAPTURE_TOKEN/);

  assert.throws(() => assertSafeNetworkConfig(loadConfig({
    PAPERLEX_HOST: '0.0.0.0',
    PAPERLEX_PASSWORD: 'short',
    PAPERLEX_CAPTURE_TOKEN: 'capture-secret-long-enough-123',
  }, '/tmp')), /PAPERLEX_PASSWORD/);
});

test('secure-cookie configuration is explicit and strict', () => {
  assert.equal(loadConfig({ PAPERLEX_SECURE_COOKIE: 'true' }, '/tmp').secureCookie, true);
  assert.equal(loadConfig({ PAPERLEX_SECURE_COOKIE: '0' }, '/tmp').secureCookie, false);
  assert.throws(() => loadConfig({ PAPERLEX_SECURE_COOKIE: 'sometimes' }, '/tmp'), /PAPERLEX_SECURE_COOKIE/);
});

test('browser authentication rejects an explicitly weak session secret', () => {
  const config = loadConfig({
    PAPERLEX_HOST: '0.0.0.0',
    PAPERLEX_PASSWORD: 'browser-secret',
    PAPERLEX_CAPTURE_TOKEN: 'capture-secret-long-enough-123',
    PAPERLEX_SESSION_SECRET: 'x',
  }, '/tmp');
  assert.throws(() => assertSafeNetworkConfig(config), /PAPERLEX_SESSION_SECRET/);
});

test('library URL is disabled when PAPERLEX_LIBRARY_URL is blank', () => {
  assert.equal(loadConfig({}, '/tmp').libraryUrl, '');
  assert.equal(loadConfig({ PAPERLEX_LIBRARY_URL: '   ' }, '/tmp').libraryUrl, '');
});

test('library URL accepts a safe absolute HTTPS destination', () => {
  assert.equal(
    loadConfig({ PAPERLEX_LIBRARY_URL: 'https://paperlex.example/library' }, '/tmp').libraryUrl,
    'https://paperlex.example/library',
  );
});

test('library URL rejects unsafe or non-HTTPS destinations', () => {
  for (const value of [
    'http://paperlex.example/library',
    'javascript:alert(1)',
    '/library',
    'https://user:password@paperlex.example/library',
    'https://127.0.0.1:8787/',
    'https://localhost/library',
    'https://paperlex.example/library?token=secret',
    'https://paperlex.example/library#secret',
    'https://paperlex.example/library?',
    'https://paperlex.example/library#',
    'https://localhost./library',
    'https://127.0.0.2/library',
    'https://[::ffff:127.0.0.1]/library',
    'https://0.0.0.0/library',
  ]) {
    assert.throws(
      () => loadConfig({ PAPERLEX_LIBRARY_URL: value }, '/tmp'),
      /PAPERLEX_LIBRARY_URL/,
    );
  }
});
