import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VocabularyStore } from '../lib/store.mjs';

function dictionaryResult() {
  return {
    status: 'complete',
    dictionary: {
      source: 'test dictionary',
      phonetic: '/test/',
      audioUrl: '',
      origin: '',
      meanings: [{
        partOfSpeech: 'adjective',
        definitions: [{ definition: 'short-lived', example: 'an ephemeral cache', synonyms: [] }],
      }],
    },
  };
}

function exampleResult() {
  return {
    status: 'complete',
    examples: [{
      text: 'All dreams are ephemeral.',
      translation: '',
      source: 'Tatoeba',
      sourceUrl: 'https://tatoeba.org/en/sentences/show/123',
      author: 'fixture-user',
      license: 'CC BY 2.0 FR',
    }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('capture deduplicates terms and records every encounter', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-store-'));
  let lookupCount = 0;
  let exampleLookupCount = 0;
  let tick = 0;
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => {
      lookupCount += 1;
      return dictionaryResult();
    },
    exampleLookup: async () => {
      exampleLookupCount += 1;
      return exampleResult();
    },
    now: () => new Date(Date.UTC(2026, 8, 1, 0, tick++)),
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const first = await store.capture({
    term: 'ephemeral',
    appleDefinition: '短命の、はかない',
    context: 'an ephemeral intermediate result',
    sourceTitle: 'Example Paper',
    sourceApp: 'Preview',
  });
  const second = await store.capture({ term: 'Ephemeral', sourceApp: 'Preview' });

  assert.equal(first.created, true);
  assert.equal(fs.statSync(path.join(tempDir, 'test.sqlite')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(tempDir).mode & 0o777, 0o700);
  assert.equal(second.created, false);
  assert.equal(second.word.term, 'ephemeral');
  assert.equal(second.word.encounterCount, 2);
  assert.equal(second.word.encounters.length, 2);
  assert.equal(second.word.appleDefinition, '短命の、はかない');
  assert.equal(lookupCount, 1);
  assert.equal(exampleLookupCount, 1);
  assert.equal(second.word.examples[0].text, 'All dreams are ephemeral.');
  assert.equal(second.word.exampleLookupStatus, 'complete');

  const updated = store.updateWord(first.word.id, {
    status: 'learning',
    customMeaning: '一時的な',
    customExample: 'The state is ephemeral.',
    notes: '分散システムでよく見る',
    tags: ['systems', 'paper'],
  });
  assert.equal(updated.status, 'learning');
  assert.deepEqual(updated.tags, ['systems', 'paper']);
  assert.equal(store.exportBackup().words[0].encounters.length, 2);
  assert.equal(store.deleteWord(first.word.id), true);
  assert.equal(store.listWords().length, 0);
});

test('capture preserves a term when the dictionary provider throws', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-outage-'));
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => { throw new Error('provider down'); },
    exampleLookup: async () => { throw new Error('example provider down'); },
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = await store.capture({ term: 'quiescence' });
  assert.equal(result.created, true);
  assert.equal(result.word.lookupStatus, 'unavailable');
  assert.equal(result.word.exampleLookupStatus, 'unavailable');
  assert.deepEqual(result.word.examples, []);
  assert.equal(result.word.term, 'quiescence');
});

test('corrupt canonical JSON is reported instead of silently omitted', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-integrity-'));
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => exampleResult(),
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = await store.capture({ term: 'integrity' });
  store.db.prepare('UPDATE words SET examples_json = ? WHERE id = ?').run('{broken', result.word.id);
  assert.throws(() => store.listWords(), new RegExp(`Corrupt examples_json for word ${result.word.id}`));
  store.db.prepare('UPDATE words SET examples_json = ? WHERE id = ?').run('[]', result.word.id);
  store.db.prepare('UPDATE words SET tags_json = ? WHERE id = ?').run('{broken', result.word.id);
  assert.throws(() => store.listWords(), new RegExp(`Corrupt tags_json for word ${result.word.id}`));
});

test('an in-memory database never changes the working directory permissions', (context) => {
  const before = fs.statSync('.').mode & 0o777;
  const store = new VocabularyStore({
    filename: ':memory:',
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => exampleResult(),
  });
  context.after(() => store.close());
  assert.equal(fs.statSync('.').mode & 0o777, before);
});

test('example backfill retries unavailable rows once and caches the result', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-backfill-'));
  let available = false;
  let lookupCount = 0;
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => {
      lookupCount += 1;
      return available ? exampleResult() : { status: 'unavailable', examples: [] };
    },
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const captured = await store.capture({ term: 'ephemeral' });
  assert.equal(captured.word.exampleLookupStatus, 'unavailable');
  store.db.prepare(`
    UPDATE words SET example_lookup_attempted_at = '2020-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(captured.word.id);

  available = true;
  assert.deepEqual(await store.backfillExamples({ retryAfterMs: 0 }), { processed: 1 });
  const enriched = store.getWord(captured.word.id);
  assert.equal(enriched.exampleLookupStatus, 'complete');
  assert.equal(enriched.examples[0].text, 'All dreams are ephemeral.');
  assert.deepEqual(await store.backfillExamples(), { processed: 0 });
  assert.equal(lookupCount, 2);
});

test('dictionary backfill retries an old unavailable row and caches the result', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-dictionary-backfill-'));
  let available = false;
  let lookupCount = 0;
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => {
      lookupCount += 1;
      return available ? dictionaryResult() : { status: 'unavailable', dictionary: null };
    },
    exampleLookup: async () => exampleResult(),
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const captured = await store.capture({ term: 'recoverable' });
  assert.equal(captured.word.lookupStatus, 'unavailable');
  store.db.prepare(`
    UPDATE words SET dictionary_lookup_attempted_at = '2020-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(captured.word.id);

  available = true;
  assert.deepEqual(await store.backfillDictionaries({ retryAfterMs: 0 }), { processed: 1 });
  const enriched = store.getWord(captured.word.id);
  assert.equal(enriched.lookupStatus, 'complete');
  assert.equal(enriched.dictionary.meanings[0].definitions[0].definition, 'short-lived');
  assert.deepEqual(await store.backfillDictionaries(), { processed: 0 });
  assert.equal(lookupCount, 2);
});

test('legacy databases gain example columns without losing existing words', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-migration-'));
  const filename = path.join(tempDir, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE words (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      normalized_term TEXT NOT NULL UNIQUE,
      apple_definition TEXT NOT NULL DEFAULT '',
      dictionary_json TEXT,
      custom_meaning TEXT NOT NULL DEFAULT '',
      custom_example TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      lookup_status TEXT NOT NULL DEFAULT 'pending',
      encounter_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    INSERT INTO words (
      id, term, normalized_term, created_at, updated_at, last_seen_at
    ) VALUES (
      'legacy-id', 'legacy', 'legacy',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const store = new VocabularyStore({
    filename,
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => exampleResult(),
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const word = store.getWord('legacy-id');
  assert.equal(word.term, 'legacy');
  assert.deepEqual(word.examples, []);
  assert.equal(word.exampleLookupStatus, 'pending');
  const columns = new Set(store.db.prepare('PRAGMA table_info(words)').all().map((column) => column.name));
  assert.equal(columns.has('dictionary_lookup_attempted_at'), true);
  assert.equal(
    store.db.prepare('SELECT dictionary_lookup_attempted_at FROM words WHERE id = ?').get(word.id)
      .dictionary_lookup_attempted_at,
    null,
  );
});

test('capture persists the word and encounter before enrichment resolves', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-durable-capture-'));
  const dictionary = deferred();
  const examples = deferred();
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => dictionary.promise,
    exampleLookup: async () => examples.promise,
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const capture = store.capture({
    term: 'durable',
    context: 'a durable intermediate representation',
    sourceApp: 'Preview',
  });

  const pending = store.db.prepare(`
    SELECT id, lookup_status, example_lookup_status, encounter_count
    FROM words WHERE normalized_term = 'durable'
  `).get();
  assert.ok(pending?.id);
  assert.equal(pending.lookup_status, 'pending');
  assert.equal(pending.example_lookup_status, 'pending');
  assert.equal(pending.encounter_count, 1);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM encounters WHERE word_id = ?').get(pending.id).count,
    1,
  );

  dictionary.resolve(dictionaryResult());
  examples.resolve(exampleResult());
  const result = await capture;
  assert.equal(result.word.lookupStatus, 'complete');
  assert.equal(result.word.exampleLookupStatus, 'complete');
});

test('a stale unavailable backfill cannot erase a concurrent successful capture', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-example-race-'));
  const staleBackfill = deferred();
  const freshCapture = deferred();
  let phase = 'initial';
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => {
      if (phase === 'initial') return { status: 'unavailable', examples: [] };
      if (phase === 'backfill') return staleBackfill.promise;
      return freshCapture.promise;
    },
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const initial = await store.capture({ term: 'concurrent' });
  store.db.prepare(`
    UPDATE words SET example_lookup_attempted_at = '2020-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(initial.word.id);

  phase = 'backfill';
  const backfill = store.backfillExamples({ limit: 1, retryAfterMs: 0 });
  phase = 'capture';
  const capture = store.capture({ term: 'Concurrent', sourceApp: 'Preview' });
  freshCapture.resolve(exampleResult());
  const captured = await capture;
  assert.equal(captured.word.exampleLookupStatus, 'complete');

  staleBackfill.resolve({ status: 'unavailable', examples: [] });
  await backfill;
  const finalWord = store.getWord(initial.word.id);
  assert.equal(finalWord.exampleLookupStatus, 'complete');
  assert.equal(finalWord.examples[0].text, 'All dreams are ephemeral.');
  assert.equal(finalWord.encounterCount, 2);
});

test('example backfill drains more than fifty pending rows fairly in one run', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-example-drain-'));
  const attempts = new Map();
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async (term) => {
      attempts.set(term, (attempts.get(term) || 0) + 1);
      const index = Number(term.slice(5));
      return index < 50 ? { status: 'unavailable', examples: [] } : exampleResult();
    },
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const insert = store.db.prepare(`
    INSERT INTO words (
      id, term, normalized_term, created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 75; index += 1) {
    const term = `word-${index}`;
    const timestamp = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
    insert.run(`id-${index}`, term, term, timestamp, timestamp, timestamp);
  }

  assert.deepEqual(await store.backfillExamples({
    limit: 100,
    batchSize: 20,
    concurrency: 5,
    retryAfterMs: 0,
  }), { processed: 75 });
  assert.equal(attempts.size, 75);
  assert.ok([...attempts.values()].every((count) => count === 1));
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM words WHERE example_lookup_status = 'complete'").get().count,
    25,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM words WHERE example_lookup_status = 'unavailable'").get().count,
    50,
  );
});

test('migration retries complete legacy translations that lack separate attribution', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-example-shape-'));
  const filename = path.join(tempDir, 'test.sqlite');
  const initial = new VocabularyStore({
    filename,
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => exampleResult(),
  });
  initial.db.prepare(`
    INSERT INTO words (
      id, term, normalized_term, examples_json, example_lookup_status,
      created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, ?)
  `).run(
    'legacy-example-id',
    'legacy-example',
    'legacy-example',
    JSON.stringify([{
      text: 'This English sentence has attribution.',
      translation: 'この翻訳には個別の帰属情報がない。',
      source: 'Tatoeba',
      sourceUrl: 'https://tatoeba.org/en/sentences/show/123',
      author: 'english-author',
      license: 'CC BY 2.0 FR',
    }]),
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z',
  );
  initial.close();

  const migrated = new VocabularyStore({
    filename,
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => exampleResult(),
  });
  context.after(() => {
    migrated.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const word = migrated.getWord('legacy-example-id');
  assert.equal(word.exampleLookupStatus, 'pending');
  assert.equal(word.examples[0].text, 'This English sentence has attribution.');
  assert.equal(
    migrated.db.prepare('SELECT example_lookup_attempted_at FROM words WHERE id = ?').get(word.id)
      .example_lookup_attempted_at,
    null,
  );
});

test('concurrent manual example refreshes share one provider request', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-example-coalesce-'));
  const lookup = deferred();
  let lookupCount = 0;
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => {
      lookupCount += 1;
      if (lookupCount === 1) return { status: 'unavailable', examples: [] };
      return lookup.promise;
    },
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const captured = await store.capture({ term: 'coalesced' });
  const first = store.refreshExamples(captured.word.id);
  const second = store.refreshExamples(captured.word.id);
  lookup.resolve(exampleResult());

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(lookupCount, 2);
  assert.equal(firstResult.exampleLookupStatus, 'complete');
  assert.deepEqual(firstResult, secondResult);
});

test('concurrent manual dictionary refreshes share one provider request', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-dictionary-coalesce-'));
  const lookup = deferred();
  let lookupCount = 0;
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => {
      lookupCount += 1;
      if (lookupCount === 1) return { status: 'unavailable', dictionary: null };
      return lookup.promise;
    },
    exampleLookup: async () => exampleResult(),
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const captured = await store.capture({ term: 'coalesced-dictionary' });
  const first = store.refreshDictionary(captured.word.id);
  const second = store.refreshDictionary(captured.word.id);
  lookup.resolve(dictionaryResult());

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(lookupCount, 2);
  assert.equal(firstResult.lookupStatus, 'complete');
  assert.deepEqual(firstResult, secondResult);
});

test('backfill snapshots eligible rows and never repeats one when the clock moves backward', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-example-clock-'));
  let available = false;
  let lookupCount = 0;
  let currentTime = new Date('2026-09-01T00:00:10.000Z');
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => {
      lookupCount += 1;
      currentTime = new Date('2026-09-01T00:00:09.000Z');
      return available ? exampleResult() : { status: 'unavailable', examples: [] };
    },
    now: () => currentTime,
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const captured = await store.capture({ term: 'clockwise' });
  assert.equal(captured.word.exampleLookupStatus, 'unavailable');
  available = true;
  currentTime = new Date('2026-09-01T00:00:10.000Z');

  assert.deepEqual(await store.backfillExamples({ limit: 4, retryAfterMs: 0 }), { processed: 1 });
  assert.equal(lookupCount, 2);
  assert.equal(store.getWord(captured.word.id).exampleLookupStatus, 'complete');
});

test('aborting startup backfill settles promptly and leaves unfinished rows pending', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-example-abort-'));
  const started = deferred();
  let startedCount = 0;
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async (_term, { signal } = {}) => new Promise((resolve) => {
      startedCount += 1;
      if (startedCount === 3) started.resolve();
      signal?.addEventListener('abort', () => {
        resolve({ status: 'aborted', examples: [], reason: 'aborted' });
      }, { once: true });
    }),
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const insert = store.db.prepare(`
    INSERT INTO words (
      id, term, normalized_term, created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 8; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
    insert.run(`abort-${index}`, `abort-${index}`, `abort-${index}`, timestamp, timestamp, timestamp);
  }

  const controller = new AbortController();
  const backfill = store.backfillExamples({
    limit: 8,
    batchSize: 8,
    concurrency: 3,
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();

  const result = await Promise.race([
    backfill,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('backfill did not stop')), 500).unref();
    }),
  ]);
  assert.deepEqual(result, { processed: 0 });
  assert.equal(startedCount, 3);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM words WHERE example_lookup_status = 'pending'").get().count,
    8,
  );
});

test('aborting dictionary backfill settles promptly and leaves unfinished rows pending', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-dictionary-abort-'));
  const started = deferred();
  let startedCount = 0;
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async (_term, { signal } = {}) => new Promise((resolve) => {
      startedCount += 1;
      if (startedCount === 3) started.resolve();
      signal?.addEventListener('abort', () => {
        resolve({ status: 'aborted', dictionary: null, reason: 'aborted' });
      }, { once: true });
    }),
    exampleLookup: async () => exampleResult(),
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const insert = store.db.prepare(`
    INSERT INTO words (
      id, term, normalized_term, created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 8; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
    insert.run(`dictionary-abort-${index}`, `dictionary-abort-${index}`, `dictionary-abort-${index}`, timestamp, timestamp, timestamp);
  }

  const controller = new AbortController();
  const backfill = store.backfillDictionaries({
    limit: 8,
    batchSize: 8,
    concurrency: 3,
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();

  const result = await Promise.race([
    backfill,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('dictionary backfill did not stop')), 500).unref();
    }),
  ]);
  assert.deepEqual(result, { processed: 0 });
  assert.equal(startedCount, 3);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM words WHERE lookup_status = 'pending'").get().count,
    8,
  );
});

test('example outages log a category without exposing the selected term', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlex-example-log-'));
  const warnings = [];
  const store = new VocabularyStore({
    filename: path.join(tempDir, 'test.sqlite'),
    dictionaryLookup: async () => dictionaryResult(),
    exampleLookup: async () => ({ status: 'unavailable', examples: [], reason: 'http_503' }),
    logger: { warn: (...values) => warnings.push(values) },
  });
  context.after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await store.capture({ term: 'private-selection' });
  assert.deepEqual(warnings, [[
    '[PaperLex examples]',
    { status: 'unavailable', category: 'http_503' },
  ]]);
  assert.doesNotMatch(JSON.stringify(warnings), /private-selection/);
});
