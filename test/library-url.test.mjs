import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCaptureBaseUrl, normalizeExternalLibraryUrl } from '../lib/library-url.mjs';

const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESOLVER = path.join(PROJECT_DIR, 'scripts', 'resolve-library-url.mjs');
const LOCAL_TOKEN = 'local-capture-token-long-enough-123';

test('external library URLs require a hostname instead of a local or literal IP target', () => {
  assert.equal(normalizeExternalLibraryUrl('https://paperlex.example./library'), 'https://paperlex.example/library');
  for (const value of [
    'https://localhost./',
    'https://127.0.0.2/',
    'https://[::ffff:127.0.0.1]/',
    'https://0.0.0.0/',
    'https://192.0.2.1/',
    'https://paperlex.example/?',
    'https://paperlex.example/#',
  ]) {
    assert.throws(() => normalizeExternalLibraryUrl(value), /PAPERLEX_LIBRARY_URL/u);
  }
});

test('capture targets distinguish an explicit local endpoint from a safe remote library', () => {
  assert.equal(classifyCaptureBaseUrl('http://127.0.0.2:8787').kind, 'local');
  assert.equal(classifyCaptureBaseUrl('https://localhost./').kind, 'local');
  assert.equal(classifyCaptureBaseUrl('https://paperlex.example/library').kind, 'remote');
  assert.throws(() => classifyCaptureBaseUrl('http://paperlex.example/library'));
});

test('installer resolver returns one remote URL and fails closed for unsafe capture settings', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-library-url-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const remoteConfig = path.join(tempDir, 'remote.json');
  fs.writeFileSync(remoteConfig, JSON.stringify({
    baseURL: 'https://paperlex.example/library',
    token: 'remote-capture-token-long-enough-123',
  }));
  const remote = runResolver(['--capture', remoteConfig]);
  assert.equal(remote.status, 0);
  assert.equal(remote.stdout, 'https://paperlex.example/library');

  const localConfig = path.join(tempDir, 'local.json');
  fs.writeFileSync(localConfig, JSON.stringify({ baseURL: 'http://127.0.0.1:8787', token: LOCAL_TOKEN }));
  const local = runResolver(['--capture', localConfig], LOCAL_TOKEN);
  assert.equal(local.status, 0);
  assert.equal(local.stdout, 'LOCAL');
  assert.notEqual(runResolver(['--capture', localConfig], 'different-token-long-enough-123').status, 0);

  for (const baseURL of [
    'http://paperlex.example',
    'https://localhost.',
    'https://127.0.0.2',
    'https://paperlex.example/?',
    'https://paperlex.example/#',
  ]) {
    fs.writeFileSync(remoteConfig, JSON.stringify({ baseURL, token: 'remote-capture-token-long-enough-123' }));
    assert.notEqual(runResolver(['--capture', remoteConfig]).status, 0, baseURL);
  }
});

function runResolver(args, expectedToken = '') {
  return spawnSync(process.execPath, [RESOLVER, ...args], {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    env: { ...process.env, PAPERLEX_EXPECTED_CAPTURE_TOKEN: expectedToken },
  });
}
