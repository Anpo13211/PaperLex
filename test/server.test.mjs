import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createPaperLexApp } from '../server.mjs';
import { VocabularyStore } from '../lib/store.mjs';

async function startRedirectTestServer(context, libraryUrl) {
  const server = http.createServer(createPaperLexApp({ store: {}, libraryUrl }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('configured library redirects GET and HEAD document routes', async (context) => {
  const libraryUrl = 'https://paperlex.example/library';
  const baseUrl = await startRedirectTestServer(context, libraryUrl);

  for (const method of ['GET', 'HEAD']) {
    for (const pathname of ['/', '/index.html', '/vocabulary.html']) {
      const response = await fetch(`${baseUrl}${pathname}`, { method, redirect: 'manual' });
      assert.equal(response.status, 302, `${method} ${pathname}`);
      assert.equal(response.headers.get('location'), libraryUrl, `${method} ${pathname}`);
    }
  }
});

test('local query override keeps serving the bundled library UI', async (context) => {
  const baseUrl = await startRedirectTestServer(context, 'https://paperlex.example/library');

  for (const pathname of ['/', '/index.html', '/vocabulary.html']) {
    const response = await fetch(`${baseUrl}${pathname}?local=1`, { redirect: 'manual' });
    assert.equal(response.status, 200, pathname);
    assert.match(await response.text(), /PaperLex/u, pathname);
  }
});

test('configured library does not redirect APIs or static assets', async (context) => {
  const baseUrl = await startRedirectTestServer(context, 'https://paperlex.example/library');

  const config = await fetch(`${baseUrl}/api/config`, { redirect: 'manual' });
  assert.equal(config.status, 200);
  assert.equal(config.headers.get('location'), null);
  assert.equal((await config.json()).libraryUrl, 'https://paperlex.example/library');

  const script = await fetch(`${baseUrl}/app.js`, { redirect: 'manual' });
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('location'), null);
  assert.equal(script.headers.get('cache-control'), 'no-cache');
  assert.match(script.headers.get('content-type'), /^text\/javascript/u);

  const health = await fetch(`${baseUrl}/api/health`, { redirect: 'manual' });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('location'), null);
});

test('HTTP API protects the library and accepts a tokenized Preview capture', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-api-'));
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => ({
      status: 'complete',
      dictionary: {
        source: 'fixture',
        phonetic: '/kwɪˈɛsəns/',
        audioUrl: '',
        origin: '',
        meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a state of inactivity', example: '', synonyms: [] }] }],
      },
    }),
    exampleLookup: async () => ({
      status: 'complete',
      examples: [{
        text: 'The system remained in quiescence.',
        translation: '',
        source: 'Tatoeba',
        sourceUrl: 'https://tatoeba.org/en/sentences/show/456',
        author: 'fixture-user',
        license: 'CC BY 2.0 FR',
      }],
    }),
  });
  const server = http.createServer(createPaperLexApp({
    store,
    password: 'correct-horse',
    captureToken: 'capture-secret',
    sessionSecret: 'session-secret',
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const index = await fetch(`${baseUrl}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /PaperLex/);

  const appScript = await fetch(`${baseUrl}/app.js`);
  assert.equal(appScript.status, 200);
  assert.match(appScript.headers.get('content-type'), /^text\/javascript/);
  assert.match(await appScript.text(), /from '\.\/definition-format\.js'/);

  const definitionFormatter = await fetch(`${baseUrl}/definition-format.js`);
  assert.equal(definitionFormatter.status, 200);
  assert.match(definitionFormatter.headers.get('content-type'), /^text\/javascript/);
  assert.match(await definitionFormatter.text(), /export function parseAppleDefinition/);

  const unauthorized = await fetch(`${baseUrl}/api/words`);
  assert.equal(unauthorized.status, 401);

  const nullSession = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'null',
  });
  assert.equal(nullSession.status, 400);

  const badCapture = await fetch(`${baseUrl}/api/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ term: 'quiescence' }),
  });
  assert.equal(badCapture.status, 401);

  const plainTextCapture = await fetch(`${baseUrl}/api/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-PaperLex-Token': 'capture-secret' },
    body: JSON.stringify({ term: 'cross-site' }),
  });
  assert.equal(plainTextCapture.status, 415);

  const foreignOriginCapture = await fetch(`${baseUrl}/api/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PaperLex-Token': 'capture-secret',
      Origin: 'https://attacker.example',
    },
    body: JSON.stringify({ term: 'cross-site' }),
  });
  assert.equal(foreignOriginCapture.status, 403);

  const capture = await fetch(`${baseUrl}/api/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PaperLex-Token': 'capture-secret' },
    body: JSON.stringify({ term: 'quiescence', appleDefinition: '静止、無活動' }),
  });
  assert.equal(capture.status, 201);
  const capturePayload = await capture.json();
  assert.equal(capturePayload.word.encounterCount, 1);
  assert.equal(capturePayload.word.examples[0].text, 'The system remained in quiescence.');

  const badLogin = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-horse' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const arrayCreate = await fetch(`${baseUrl}/api/words`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '[]',
  });
  assert.equal(arrayCreate.status, 400);

  const list = await fetch(`${baseUrl}/api/words`, { headers: { Cookie: cookie } });
  const listPayload = await list.json();
  assert.equal(list.status, 200);
  assert.equal(listPayload.words.length, 1);

  const wordId = listPayload.words[0].id;
  store.db.prepare(`
    UPDATE words SET examples_json = '[]', example_lookup_status = 'unavailable' WHERE id = ?
  `).run(wordId);
  const refreshedExamples = await fetch(`${baseUrl}/api/words/${wordId}/examples/refresh`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(refreshedExamples.status, 200);
  assert.equal((await refreshedExamples.json()).word.examples[0].text, 'The system remained in quiescence.');

  store.db.prepare(`
    UPDATE words
    SET dictionary_json = NULL, lookup_status = 'unavailable',
        dictionary_lookup_attempted_at = '2020-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(wordId);
  const refreshedDictionary = await fetch(`${baseUrl}/api/words/${wordId}/dictionary/refresh`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(refreshedDictionary.status, 200);
  const refreshedDictionaryPayload = await refreshedDictionary.json();
  assert.equal(refreshedDictionaryPayload.word.lookupStatus, 'complete');
  assert.equal(
    refreshedDictionaryPayload.word.dictionary.meanings[0].definitions[0].definition,
    'a state of inactivity',
  );

  const nullUpdate = await fetch(`${baseUrl}/api/words/${wordId}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: 'null',
  });
  assert.equal(nullUpdate.status, 400);
  const update = await fetch(`${baseUrl}/api/words/${wordId}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'learning', customMeaning: '静止状態' }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).word.status, 'learning');

  const backup = await fetch(`${baseUrl}/api/export`, { headers: { Cookie: cookie } });
  assert.equal(backup.status, 200);
  assert.equal((await backup.json()).format, 'paperlex-backup');

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const failedLogin = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'still-wrong' }),
    });
    assert.equal(failedLogin.status, 401);
  }
  const throttledLogin = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'still-wrong' }),
  });
  assert.equal(throttledLogin.status, 429);
  assert.ok(Number(throttledLogin.headers.get('retry-after')) > 0);
});
