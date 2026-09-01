import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupExamples, mapTatoebaPayload } from '../lib/examples.mjs';

test('lookupExamples sends the stable Tatoeba query and request metadata', async () => {
  let requestUrl;
  let requestOptions;
  const result = await lookupExamples('a priori', {
    timeoutMs: 123,
    fetchImpl: async (url, options) => {
      requestUrl = new URL(url);
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: 42,
            text: 'This is known a priori.',
            lang: 'eng',
            is_unapproved: false,
            owner: 'alice',
            license: 'CC BY 2.0 FR',
            translations: [[{
              id: 84,
              lang: 'jpn',
              text: 'これは先験的に知られている。',
              owner: 'hanako',
              license: 'CC BY 2.0 FR',
              is_unapproved: false,
            }]],
          }],
        }),
      };
    },
  });

  assert.equal(requestUrl.origin + requestUrl.pathname, 'https://api.tatoeba.org/v1/sentences');
  assert.deepEqual(Object.fromEntries(requestUrl.searchParams), {
    lang: 'eng',
    q: 'a priori',
    sort: 'relevance',
    'showtrans:lang': 'jpn',
    limit: '3',
  });
  assert.deepEqual(requestOptions.headers, {
    Accept: 'application/json',
    'User-Agent': 'PaperLex/0.1',
  });
  assert.ok(requestOptions.signal instanceof AbortSignal);
  assert.equal(result.status, 'complete');
  assert.equal(result.examples[0].translation, 'これは先験的に知られている。');
  assert.equal(result.examples[0].translationSourceUrl, 'https://tatoeba.org/en/sentences/show/84');
});

test('mapTatoebaPayload keeps approved English sentences, removes duplicates, and limits results', () => {
  const valid = (id, text, extra = {}) => ({
    id,
    text,
    lang: 'eng',
    is_unapproved: false,
    owner: `owner-${id}`,
    license: 'CC BY 2.0 FR',
    translations: [],
    ...extra,
  });
  const payload = {
    data: [
      valid(1, 'First example.', { translations: [
        { id: 10, lang: 'fra', text: 'Premier.' },
        { id: 11, lang: 'jpn', text: '最初の例。', owner: 'translator', license: 'CC BY 2.0 FR', is_unapproved: false },
      ] }),
      valid(2, 'First example.'),
      valid(3, 'Unapproved.', { is_unapproved: true }),
      valid(4, 'Not English.', { lang: 'deu' }),
      valid('5', 'Invalid id.'),
      valid(6, '   '),
      valid(7, 'Second example.'),
      valid(8, 'Third example.'),
      valid(9, 'Fourth example.'),
    ],
  };

  assert.deepEqual(mapTatoebaPayload(payload), [
    {
      text: 'First example.',
      translation: '最初の例。',
      source: 'Tatoeba',
      sourceUrl: 'https://tatoeba.org/en/sentences/show/1',
      author: 'owner-1',
      license: 'CC BY 2.0 FR',
      translationSourceUrl: 'https://tatoeba.org/en/sentences/show/11',
      translationAuthor: 'translator',
      translationLicense: 'CC BY 2.0 FR',
    },
    {
      text: 'Second example.',
      translation: '',
      source: 'Tatoeba',
      sourceUrl: 'https://tatoeba.org/en/sentences/show/7',
      author: 'owner-7',
      license: 'CC BY 2.0 FR',
      translationSourceUrl: '',
      translationAuthor: '',
      translationLicense: '',
    },
    {
      text: 'Third example.',
      translation: '',
      source: 'Tatoeba',
      sourceUrl: 'https://tatoeba.org/en/sentences/show/8',
      author: 'owner-8',
      license: 'CC BY 2.0 FR',
      translationSourceUrl: '',
      translationAuthor: '',
      translationLicense: '',
    },
  ]);
});

test('lookupExamples distinguishes missing results from an outage', async () => {
  const missing404 = await lookupExamples('missing', {
    fetchImpl: async () => ({ status: 404, ok: false }),
  });
  assert.deepEqual(missing404, { status: 'not_found', examples: [] });

  const empty = await lookupExamples('missing', {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ data: [] }) }),
  });
  assert.deepEqual(empty, { status: 'not_found', examples: [] });

  const serverError = await lookupExamples('word', {
    fetchImpl: async () => ({ status: 503, ok: false }),
  });
  assert.deepEqual(serverError, { status: 'unavailable', examples: [], reason: 'http_503' });

  const offline = await lookupExamples('word', {
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(offline, { status: 'unavailable', examples: [], reason: 'network_error' });

  const invalidJson = await lookupExamples('word', {
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{broken' }),
  });
  assert.deepEqual(invalidJson, { status: 'unavailable', examples: [], reason: 'invalid_json' });

  const invalidPayload = await lookupExamples('word', {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ error: 'bad shape' }) }),
  });
  assert.deepEqual(invalidPayload, { status: 'unavailable', examples: [], reason: 'invalid_payload' });

  const timeout = await lookupExamples('word', {
    fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); },
  });
  assert.deepEqual(timeout, { status: 'unavailable', examples: [], reason: 'timeout' });
});

test('mapTatoebaPayload supplies the documented corpus license when the API omits it', () => {
  assert.deepEqual(mapTatoebaPayload({
    data: [{
      id: 91,
      text: 'A bounded example.',
      lang: 'eng',
      is_unapproved: false,
      owner: 'author',
      translations: [[{
        id: 92,
        text: '境界のある例。',
        lang: 'jpn',
        is_unapproved: false,
        owner: 'translator',
      }]],
    }],
  })[0], {
    text: 'A bounded example.',
    translation: '境界のある例。',
    source: 'Tatoeba',
    sourceUrl: 'https://tatoeba.org/en/sentences/show/91',
    author: 'author',
    license: 'CC BY 2.0 FR',
    translationSourceUrl: 'https://tatoeba.org/en/sentences/show/92',
    translationAuthor: 'translator',
    translationLicense: 'CC BY 2.0 FR',
  });
});

test('lookupExamples rejects an oversized response before reading its body', async () => {
  let bodyRead = false;
  const result = await lookupExamples('oversized', {
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: { get: () => String(600 * 1024) },
      text: async () => {
        bodyRead = true;
        return '{}';
      },
    }),
  });

  assert.deepEqual(result, { status: 'unavailable', examples: [], reason: 'response_too_large' });
  assert.equal(bodyRead, false);
});

test('lookupExamples cancels a streamed response that crosses the byte limit', async () => {
  let cancelled = false;
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      sent += 1;
      controller.enqueue(new Uint8Array(300 * 1024));
      if (sent === 3) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await lookupExamples('streamed', {
    fetchImpl: async () => ({ status: 200, ok: true, body }),
  });
  assert.deepEqual(result, { status: 'unavailable', examples: [], reason: 'response_too_large' });
  assert.equal(cancelled, true);
});
