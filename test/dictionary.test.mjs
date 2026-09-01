import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupDictionary, mapDictionaryPayload, mapWiktionaryPayload } from '../lib/dictionary.mjs';

const fixture = [{
  word: 'ephemeral',
  phonetic: '/ɪˈfɛmərəl/',
  phonetics: [{ audio: '//example.test/audio.mp3' }],
  meanings: [{
    partOfSpeech: 'adjective',
    definitions: [{
      definition: 'lasting for a very short time',
      example: 'ephemeral streams',
      synonyms: ['transitory'],
    }],
  }],
}];

test('mapDictionaryPayload retains the fields used by the UI', () => {
  const mapped = mapDictionaryPayload(fixture);
  assert.equal(mapped.phonetic, '/ɪˈfɛmərəl/');
  assert.equal(mapped.audioUrl, 'https://example.test/audio.mp3');
  assert.equal(mapped.meanings[0].partOfSpeech, 'adjective');
  assert.equal(mapped.meanings[0].definitions[0].example, 'ephemeral streams');
});

test('lookupDictionary distinguishes a missing word from an outage', async () => {
  const missing = await lookupDictionary('not-a-word', {
    fetchImpl: async () => ({ status: 404, ok: false }),
  });
  assert.deepEqual(missing, { status: 'not_found', dictionary: null });

  const unavailable = await lookupDictionary('ephemeral', {
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.dictionary, null);
  assert.match(unavailable.reason, /free_dictionary_network_error/);
  assert.match(unavailable.reason, /wiktionary_network_error/);
});

test('Wiktionary fallback strips markup and keeps attribution and an example', async () => {
  const wiktionaryFixture = {
    en: [{
      partOfSpeech: 'Verb',
      definitions: [{
        definition: '<span class="usage"></span> To <a href="/wiki/make">make</a> something &quot;clear&quot;.',
        parsedExamples: [{ example: 'This <b>elucidates</b> the result.' }],
      }],
    }],
  };
  const requested = [];
  const result = await lookupDictionary('elucidate', {
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.startsWith('https://api.dictionaryapi.dev/')) {
        return { status: 503, ok: false };
      }
      return { status: 200, ok: true, json: async () => wiktionaryFixture };
    },
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.dictionary.source, 'Wiktionary');
  assert.equal(result.dictionary.license, 'CC BY-SA 4.0');
  assert.equal(result.dictionary.meanings[0].partOfSpeech, 'verb');
  assert.equal(result.dictionary.meanings[0].definitions[0].definition, 'To make something "clear".');
  assert.equal(result.dictionary.meanings[0].definitions[0].example, 'This elucidates the result.');
  assert.match(requested[1], /en\.wiktionary\.org/);
});

test('Wiktionary fallback retries a hyphenated headword with spaces', async () => {
  const requested = [];
  const result = await lookupDictionary('a-priori', {
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.startsWith('https://api.dictionaryapi.dev/')) return { status: 404, ok: false };
      if (url.endsWith('/a-priori')) return { status: 404, ok: false };
      return {
        status: 200,
        ok: true,
        json: async () => ({
          en: [{ partOfSpeech: 'Adverb', definitions: [{ definition: 'Known independently of experience.' }] }],
        }),
      };
    },
  });

  assert.equal(result.status, 'complete');
  assert.match(result.dictionary.sourceUrl, /a_priori$/);
  assert.equal(requested.length, 3);
  assert.match(requested[2], /a%20priori$/);
});

test('mapWiktionaryPayload rejects pages without English definitions', () => {
  assert.equal(mapWiktionaryPayload({ fr: [] }, 'mot'), null);
});

test('lookupDictionary returns promptly when its caller aborts', async () => {
  const controller = new AbortController();
  const started = new Promise((resolve) => {
    controller.started = resolve;
  });
  const lookup = lookupDictionary('pending', {
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => new Promise((resolve) => {
      controller.started();
      signal.addEventListener('abort', () => resolve({ status: 499, ok: false }), { once: true });
    }),
  });
  await started;
  controller.abort();
  assert.deepEqual(await lookup, { status: 'aborted', dictionary: null, reason: 'aborted' });
});
