import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cleanOptionalText, cleanTags, cleanTerm, normalizeTerm, ValidationError } from './normalize.mjs';
import { lookupDictionary } from './dictionary.mjs';
import { lookupExamples } from './examples.mjs';

const STATUSES = new Set(['new', 'learning', 'mastered']);

export class VocabularyStore {
  constructor({
    filename,
    dictionaryLookup = lookupDictionary,
    exampleLookup = lookupExamples,
    logger = null,
    now = () => new Date(),
  }) {
    const isMemoryDatabase = filename === ':memory:';
    if (!isMemoryDatabase) {
      const databaseDirectory = path.dirname(filename);
      const directoryExists = fs.existsSync(databaseDirectory);
      fs.mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
      if (!directoryExists) fs.chmodSync(databaseDirectory, 0o700);
    }
    this.db = new DatabaseSync(filename);
    this.dictionaryLookup = dictionaryLookup;
    this.exampleLookup = exampleLookup;
    this.logger = logger;
    this.dictionaryRefreshes = new Map();
    this.exampleRefreshes = new Map();
    this.now = now;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#migrate();
    if (!isMemoryDatabase) enforcePrivateDatabasePermissions(filename);
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS words (
        id TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        normalized_term TEXT NOT NULL UNIQUE,
        apple_definition TEXT NOT NULL DEFAULT '',
        dictionary_json TEXT,
        examples_json TEXT NOT NULL DEFAULT '[]',
        example_lookup_status TEXT NOT NULL DEFAULT 'pending',
        example_lookup_attempted_at TEXT,
        custom_meaning TEXT NOT NULL DEFAULT '',
        custom_example TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'learning', 'mastered')),
        lookup_status TEXT NOT NULL DEFAULT 'pending',
        dictionary_lookup_attempted_at TEXT,
        encounter_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS encounters (
        id TEXT PRIMARY KEY,
        word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
        context TEXT NOT NULL DEFAULT '',
        source_title TEXT NOT NULL DEFAULT '',
        source_app TEXT NOT NULL DEFAULT '',
        captured_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_words_created_at ON words(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_words_last_seen_at ON words(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_encounters_word_id ON encounters(word_id, captured_at DESC);
    `);

    const columns = new Set(this.db.prepare('PRAGMA table_info(words)').all().map((column) => column.name));
    if (!columns.has('examples_json')) {
      this.db.exec("ALTER TABLE words ADD COLUMN examples_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.has('example_lookup_status')) {
      this.db.exec("ALTER TABLE words ADD COLUMN example_lookup_status TEXT NOT NULL DEFAULT 'pending'");
    }
    if (!columns.has('example_lookup_attempted_at')) {
      this.db.exec('ALTER TABLE words ADD COLUMN example_lookup_attempted_at TEXT');
    }
    if (!columns.has('dictionary_lookup_attempted_at')) {
      this.db.exec('ALTER TABLE words ADD COLUMN dictionary_lookup_attempted_at TEXT');
    }

    const completedExamples = this.db.prepare(`
      SELECT id, examples_json FROM words WHERE example_lookup_status = 'complete'
    `).all();
    const markForRefresh = this.db.prepare(`
      UPDATE words
      SET example_lookup_status = 'pending', example_lookup_attempted_at = NULL
      WHERE id = ?
    `);
    for (const row of completedExamples) {
      const examples = parseStoredJson(row.examples_json, [], row.id, 'examples_json');
      if (Array.isArray(examples) && examples.some(hasUnattributedTranslation)) {
        markForRefresh.run(row.id);
      }
    }
  }

  close() {
    this.db.close();
  }

  listWords() {
    return this.db.prepare('SELECT * FROM words ORDER BY created_at DESC').all().map(rowToWord);
  }

  getWord(id) {
    const row = this.db.prepare('SELECT * FROM words WHERE id = ?').get(id);
    if (!row) return null;
    const word = rowToWord(row);
    word.encounters = this.db
      .prepare('SELECT * FROM encounters WHERE word_id = ? ORDER BY captured_at DESC')
      .all(id)
      .map(rowToEncounter);
    return word;
  }

  async capture(input = {}) {
    const term = cleanTerm(input.term);
    const normalized = normalizeTerm(term);
    const appleDefinition = cleanOptionalText(input.appleDefinition, 40_000, 'Apple辞書の定義');
    const context = cleanOptionalText(input.context, 4_000, '文脈');
    const sourceTitle = cleanOptionalText(input.sourceTitle, 500, '出典名');
    const sourceApp = cleanOptionalText(input.sourceApp, 100, 'アプリ名');
    const capturedAt = this.now().toISOString();
    let id;
    let created;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT * FROM words WHERE normalized_term = ?').get(normalized);
      if (current) {
        id = current.id;
        created = false;
        const nextAppleDefinition = current.apple_definition || appleDefinition;
        this.db.prepare(`
          UPDATE words SET
              apple_definition = ?, encounter_count = encounter_count + 1,
              updated_at = ?, last_seen_at = ?
          WHERE id = ?
        `).run(
          nextAppleDefinition,
          capturedAt,
          capturedAt,
          id,
        );
      } else {
        id = randomUUID();
        created = true;
        this.db.prepare(`
          INSERT INTO words (
            id, term, normalized_term, apple_definition, dictionary_json, lookup_status,
            dictionary_lookup_attempted_at,
            examples_json, example_lookup_status, example_lookup_attempted_at,
            encounter_count, created_at, updated_at, last_seen_at
          ) VALUES (?, ?, ?, ?, NULL, 'pending', NULL, '[]', 'pending', NULL, 1, ?, ?, ?)
        `).run(
          id,
          term,
          normalized,
          appleDefinition,
          capturedAt,
          capturedAt,
          capturedAt,
        );
      }

      this.db.prepare(`
        INSERT INTO encounters (id, word_id, context, source_title, source_app, captured_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), id, context, sourceTitle, sourceApp, capturedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const persisted = this.getWord(id);
    const needsDictionary = !persisted.dictionary
      && ['pending', 'unavailable'].includes(persisted.lookupStatus);
    const needsExamples = ['pending', 'unavailable'].includes(persisted.exampleLookupStatus);
    const dictionaryTask = needsDictionary
      ? safelyLookupDictionary(this.dictionaryLookup, term)
      : Promise.resolve(null);
    const exampleTask = needsExamples
      ? safelyLookupExamples(this.exampleLookup, term)
      : Promise.resolve(null);
    const [lookup, exampleResult] = await Promise.all([dictionaryTask, exampleTask]);
    const enrichedAt = this.now().toISOString();

    if (lookup) this.#storeDictionaryResult(id, lookup, enrichedAt);
    if (exampleResult) this.#storeExampleResult(id, exampleResult, enrichedAt);
    return { word: this.getWord(id), created };
  }

  #storeDictionaryResult(id, result, updatedAt) {
    if (result.status === 'unavailable') {
      this.logger?.warn?.('[PaperLex dictionary]', {
        status: 'unavailable',
        category: result.reason || 'provider_unavailable',
      });
    }
    const dictionaryJson = result.dictionary ? JSON.stringify(result.dictionary) : null;
    const allowedStatuses = result.dictionary ? "'pending', 'unavailable', 'not_found'" : "'pending', 'unavailable'";
    this.db.prepare(`
      UPDATE words
      SET dictionary_json = CASE WHEN ? = 'complete' THEN ? ELSE dictionary_json END,
          lookup_status = ?, dictionary_lookup_attempted_at = ?, updated_at = ?
      WHERE id = ? AND dictionary_json IS NULL AND lookup_status IN (${allowedStatuses})
    `).run(result.status, dictionaryJson, result.status, updatedAt, updatedAt, id);
  }

  async refreshDictionary(id, { signal } = {}) {
    if (this.dictionaryRefreshes.has(id)) return this.dictionaryRefreshes.get(id);
    const refresh = this.#refreshDictionary(id, signal).finally(() => this.dictionaryRefreshes.delete(id));
    this.dictionaryRefreshes.set(id, refresh);
    return refresh;
  }

  async #refreshDictionary(id, signal) {
    const current = this.db.prepare('SELECT * FROM words WHERE id = ?').get(id);
    if (!current) return null;
    if (current.dictionary_json || ['complete', 'not_found'].includes(current.lookup_status)) {
      return this.getWord(id);
    }
    if (signal?.aborted) return this.getWord(id);

    const result = await safelyLookupDictionary(this.dictionaryLookup, current.term, { signal });
    if (!result) return this.getWord(id);
    this.#storeDictionaryResult(id, result, this.now().toISOString());
    return this.getWord(id);
  }

  async backfillDictionaries({
    limit = 200,
    batchSize = 25,
    concurrency = 3,
    retryAfterMs = 15 * 60 * 1000,
    signal,
  } = {}) {
    if (signal?.aborted) return { processed: 0 };
    const boundedLimit = Math.max(1, Math.min(1_000, Number(limit) || 200));
    const boundedBatchSize = Math.max(1, Math.min(50, Number(batchSize) || 25));
    const boundedConcurrency = Math.max(1, Math.min(5, Number(concurrency) || 3));
    const boundedRetryAfterMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(retryAfterMs) || 0));
    const retryBefore = new Date(this.now().getTime() - boundedRetryAfterMs).toISOString();
    const eligible = this.db.prepare(`
      SELECT id FROM words
      WHERE dictionary_json IS NULL AND (
        lookup_status = 'pending'
        OR (
          lookup_status = 'unavailable'
          AND (dictionary_lookup_attempted_at IS NULL OR dictionary_lookup_attempted_at <= ?)
        )
      )
      ORDER BY
        CASE WHEN dictionary_lookup_attempted_at IS NULL THEN 0 ELSE 1 END,
        dictionary_lookup_attempted_at ASC,
        last_seen_at DESC
      LIMIT ?
    `).all(retryBefore, boundedLimit);
    let processed = 0;

    for (let offset = 0; offset < eligible.length; offset += boundedBatchSize) {
      if (signal?.aborted) break;
      const queue = eligible.slice(offset, offset + boundedBatchSize);
      const worker = async () => {
        while (queue.length && !signal?.aborted) {
          const row = queue.shift();
          await this.refreshDictionary(row.id, { signal });
          if (!signal?.aborted) processed += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(boundedConcurrency, queue.length) }, worker));
    }
    return { processed };
  }

  #storeExampleResult(id, result, attemptedAt) {
    if (result.status === 'unavailable') {
      this.logger?.warn?.('[PaperLex examples]', {
        status: 'unavailable',
        category: result.reason || 'provider_unavailable',
      });
    }
    const allowedStatuses = result.status === 'complete'
      ? "'pending', 'unavailable', 'not_found'"
      : "'pending', 'unavailable'";
    this.db.prepare(`
      UPDATE words
      SET examples_json = CASE WHEN ? = 'complete' THEN ? ELSE examples_json END,
          example_lookup_status = ?,
          example_lookup_attempted_at = ?, updated_at = ?
      WHERE id = ? AND example_lookup_status IN (${allowedStatuses})
    `).run(result.status, JSON.stringify(result.examples), result.status, attemptedAt, attemptedAt, id);
  }

  async refreshExamples(id, { signal } = {}) {
    if (this.exampleRefreshes.has(id)) return this.exampleRefreshes.get(id);
    const refresh = this.#refreshExamples(id, signal).finally(() => this.exampleRefreshes.delete(id));
    this.exampleRefreshes.set(id, refresh);
    return refresh;
  }

  async #refreshExamples(id, signal) {
    const current = this.db.prepare('SELECT * FROM words WHERE id = ?').get(id);
    if (!current) return null;
    if (['complete', 'not_found'].includes(current.example_lookup_status)) {
      return this.getWord(id);
    }
    if (signal?.aborted) return this.getWord(id);

    const result = await safelyLookupExamples(this.exampleLookup, current.term, { signal });
    if (!result) return this.getWord(id);
    this.#storeExampleResult(id, result, this.now().toISOString());
    return this.getWord(id);
  }

  async backfillExamples({
    limit = 200,
    batchSize = 25,
    concurrency = 3,
    retryAfterMs = 15 * 60 * 1000,
    signal,
  } = {}) {
    if (signal?.aborted) return { processed: 0 };
    const boundedLimit = Math.max(1, Math.min(1_000, Number(limit) || 200));
    const boundedBatchSize = Math.max(1, Math.min(50, Number(batchSize) || 25));
    const boundedConcurrency = Math.max(1, Math.min(5, Number(concurrency) || 3));
    const boundedRetryAfterMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(retryAfterMs) || 0));
    const runStarted = this.now();
    const retryBefore = new Date(runStarted.getTime() - boundedRetryAfterMs).toISOString();
    const eligible = this.db.prepare(`
      SELECT id FROM words
      WHERE (
        example_lookup_status = 'pending'
        OR (
          example_lookup_status = 'unavailable'
          AND (example_lookup_attempted_at IS NULL OR example_lookup_attempted_at <= ?)
        )
      )
      ORDER BY
        CASE WHEN example_lookup_attempted_at IS NULL THEN 0 ELSE 1 END,
        example_lookup_attempted_at ASC,
        last_seen_at DESC
      LIMIT ?
    `).all(retryBefore, boundedLimit);
    let processed = 0;

    for (let offset = 0; offset < eligible.length; offset += boundedBatchSize) {
      if (signal?.aborted) break;
      const batch = eligible.slice(offset, offset + boundedBatchSize);

      const queue = [...batch];
      const worker = async () => {
        while (queue.length && !signal?.aborted) {
          const row = queue.shift();
          await this.refreshExamples(row.id, { signal });
          if (!signal?.aborted) processed += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(boundedConcurrency, queue.length) }, worker));
    }
    return { processed };
  }

  updateWord(id, input = {}) {
    const current = this.getWord(id);
    if (!current) return null;

    const customMeaning = input.customMeaning === undefined
      ? current.customMeaning
      : cleanOptionalText(input.customMeaning, 8_000, '自分の意味');
    const customExample = input.customExample === undefined
      ? current.customExample
      : cleanOptionalText(input.customExample, 4_000, '例文');
    const notes = input.notes === undefined
      ? current.notes
      : cleanOptionalText(input.notes, 12_000, 'メモ');
    const tags = input.tags === undefined ? current.tags : cleanTags(input.tags);
    const status = input.status === undefined ? current.status : String(input.status);
    if (!STATUSES.has(status)) throw new ValidationError('不正な復習状態です。');

    const updatedAt = this.now().toISOString();
    this.db.prepare(`
      UPDATE words
      SET custom_meaning = ?, custom_example = ?, notes = ?, tags_json = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(customMeaning, customExample, notes, JSON.stringify(tags), status, updatedAt, id);
    return this.getWord(id);
  }

  deleteWord(id) {
    return this.db.prepare('DELETE FROM words WHERE id = ?').run(id).changes > 0;
  }

  exportBackup() {
    return {
      format: 'paperlex-backup',
      version: 1,
      exportedAt: this.now().toISOString(),
      words: this.listWords().map((word) => this.getWord(word.id)),
    };
  }
}

function rowToWord(row) {
  const dictionary = parseStoredJson(row.dictionary_json, null, row.id, 'dictionary_json');
  const examples = parseStoredJson(row.examples_json, [], row.id, 'examples_json');
  const tags = parseStoredJson(row.tags_json, [], row.id, 'tags_json');
  if (dictionary !== null && (typeof dictionary !== 'object' || Array.isArray(dictionary))) {
    throw new Error(`Corrupt dictionary_json for word ${row.id}`);
  }
  if (!Array.isArray(examples)) throw new Error(`Corrupt examples_json for word ${row.id}`);
  if (!Array.isArray(tags)) throw new Error(`Corrupt tags_json for word ${row.id}`);
  return {
    id: row.id,
    term: row.term,
    normalizedTerm: row.normalized_term,
    appleDefinition: row.apple_definition,
    dictionary,
    examples,
    exampleLookupStatus: row.example_lookup_status,
    customMeaning: row.custom_meaning,
    customExample: row.custom_example,
    notes: row.notes,
    tags,
    status: row.status,
    lookupStatus: row.lookup_status,
    encounterCount: Number(row.encounter_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

async function safelyLookupDictionary(provider, term, { signal } = {}) {
  if (signal?.aborted) return null;
  try {
    const result = await provider(term, { signal });
    if (signal?.aborted || result?.status === 'aborted') return null;
    if (!result || typeof result !== 'object') throw new Error('Invalid dictionary result');
    const dictionary = result.dictionary && typeof result.dictionary === 'object' ? result.dictionary : null;
    return {
      status: dictionary ? 'complete' : result.status === 'not_found' ? 'not_found' : 'unavailable',
      dictionary,
      reason: typeof result.reason === 'string' ? result.reason : '',
    };
  } catch {
    if (signal?.aborted) return null;
    return { status: 'unavailable', dictionary: null, reason: 'provider_exception' };
  }
}

async function safelyLookupExamples(provider, term, { signal } = {}) {
  if (signal?.aborted) return null;
  try {
    const result = await provider(term, { signal });
    if (signal?.aborted || result?.status === 'aborted') return null;
    if (!result || typeof result !== 'object' || !Array.isArray(result.examples)) {
      throw new Error('Invalid example result');
    }
    const examples = result.examples.slice(0, 3);
    return {
      status: examples.length ? 'complete' : result.status === 'not_found' ? 'not_found' : 'unavailable',
      examples,
      reason: typeof result.reason === 'string' ? result.reason : '',
    };
  } catch {
    if (signal?.aborted) return null;
    return { status: 'unavailable', examples: [], reason: 'provider_exception' };
  }
}

function hasUnattributedTranslation(example) {
  if (!example || typeof example !== 'object' || !example.translation) return false;
  return !example.translationSourceUrl || !example.translationAuthor || !example.translationLicense;
}

function rowToEncounter(row) {
  return {
    id: row.id,
    context: row.context,
    sourceTitle: row.source_title,
    sourceApp: row.source_app,
    capturedAt: row.captured_at,
  };
}

function parseStoredJson(value, fallback, recordId, column) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Corrupt ${column} for word ${recordId}`);
  }
}

function enforcePrivateDatabasePermissions(filename) {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
  }
}
