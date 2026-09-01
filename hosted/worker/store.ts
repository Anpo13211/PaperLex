import { cleanOptionalText, cleanTags, cleanTerm, normalizeTerm, ValidationError } from "./normalize.ts";
import { lookupDictionary, lookupExamples } from "./enrichment.ts";

export interface D1ResultLike<T = unknown> {
  success?: boolean;
  results?: T[];
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<Array<D1ResultLike<T>>>;
}

type LookupStatus = "pending" | "complete" | "not_found" | "unavailable";
type WordStatus = "new" | "learning" | "mastered";

interface WordRow {
  id: string;
  term: string;
  normalized_term: string;
  apple_definition: string;
  dictionary_json: string | null;
  examples_json: string;
  example_lookup_status: LookupStatus;
  custom_meaning: string;
  custom_example: string;
  notes: string;
  tags_json: string;
  status: WordStatus;
  lookup_status: LookupStatus;
  encounter_count: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

interface EncounterRow {
  id: string;
  context: string;
  source_title: string;
  source_app: string;
  captured_at: string;
}

export interface PaperLexWord {
  id: string;
  term: string;
  normalizedTerm: string;
  appleDefinition: string;
  dictionary: Record<string, unknown> | null;
  examples: Array<Record<string, unknown>>;
  exampleLookupStatus: LookupStatus;
  customMeaning: string;
  customExample: string;
  notes: string;
  tags: string[];
  status: WordStatus;
  lookupStatus: LookupStatus;
  encounterCount: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  encounters?: Array<Record<string, unknown>>;
}

const WORD_COLUMNS = `
  id, term, normalized_term, apple_definition, dictionary_json,
  examples_json, example_lookup_status, custom_meaning, custom_example,
  notes, tags_json, status, lookup_status, encounter_count,
  created_at, updated_at, last_seen_at
`;
const STATUSES = new Set<WordStatus>(["new", "learning", "mastered"]);

export class D1VocabularyStore {
  private readonly db: D1DatabaseLike;
  private readonly now: () => Date;
  private readonly dictionaryLookup: typeof lookupDictionary;
  private readonly exampleLookup: typeof lookupExamples;

  constructor(
    db: D1DatabaseLike,
    now: () => Date = () => new Date(),
    lookups: { dictionary?: typeof lookupDictionary; examples?: typeof lookupExamples } = {},
  ) {
    this.db = db;
    this.now = now;
    this.dictionaryLookup = lookups.dictionary || lookupDictionary;
    this.exampleLookup = lookups.examples || lookupExamples;
  }

  async listWords(): Promise<PaperLexWord[]> {
    const result = await this.db.prepare(`SELECT ${WORD_COLUMNS} FROM words ORDER BY created_at DESC`).all<WordRow>();
    return (result.results || []).map(rowToWord);
  }

  async getWord(id: string): Promise<PaperLexWord | null> {
    const row = await this.db.prepare(`SELECT ${WORD_COLUMNS} FROM words WHERE id = ?`).bind(id).first<WordRow>();
    if (!row) return null;
    const encounters = await this.db.prepare(`
      SELECT id, context, source_title, source_app, captured_at
      FROM encounters WHERE word_id = ? ORDER BY captured_at DESC
    `).bind(id).all<EncounterRow>();
    return { ...rowToWord(row), encounters: (encounters.results || []).map(rowToEncounter) };
  }

  async capture(input: Record<string, unknown> = {}): Promise<{ word: PaperLexWord; created: boolean }> {
    const term = cleanTerm(input.term);
    const normalized = normalizeTerm(term);
    const appleDefinition = cleanOptionalText(input.appleDefinition, 40_000, "Apple辞書の定義");
    const context = cleanOptionalText(input.context, 4_000, "文脈");
    const sourceTitle = cleanOptionalText(input.sourceTitle, 500, "出典名");
    const sourceApp = cleanOptionalText(input.sourceApp, 100, "アプリ名");
    const capturedAt = this.now().toISOString();
    const existing = await this.db.prepare(`SELECT ${WORD_COLUMNS} FROM words WHERE normalized_term = ?`).bind(normalized).first<WordRow>();
    let id = existing?.id || crypto.randomUUID();
    let created = !existing;

    const encounter = () => this.db.prepare(`
      INSERT INTO encounters (id, word_id, context, source_title, source_app, captured_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), id, context, sourceTitle, sourceApp, capturedAt);

    if (existing) {
      await this.db.batch([
        this.db.prepare(`
          UPDATE words SET apple_definition = ?, encounter_count = encounter_count + 1,
            updated_at = ?, last_seen_at = ? WHERE id = ?
        `).bind(existing.apple_definition || appleDefinition, capturedAt, capturedAt, id),
        encounter(),
      ]);
    } else {
      try {
        await this.db.batch([
          this.db.prepare(`
            INSERT INTO words (
              id, term, normalized_term, apple_definition, dictionary_json,
              examples_json, example_lookup_status, example_lookup_attempted_at,
              custom_meaning, custom_example, notes, tags_json, status,
              lookup_status, dictionary_lookup_attempted_at, encounter_count,
              created_at, updated_at, last_seen_at
            ) VALUES (?, ?, ?, ?, NULL, '[]', 'pending', NULL, '', '', '', '[]',
              'new', 'pending', NULL, 1, ?, ?, ?)
          `).bind(id, term, normalized, appleDefinition, capturedAt, capturedAt, capturedAt),
          encounter(),
        ]);
      } catch (error) {
        const raced = await this.db.prepare(`SELECT ${WORD_COLUMNS} FROM words WHERE normalized_term = ?`).bind(normalized).first<WordRow>();
        if (!raced) throw error;
        id = raced.id;
        created = false;
        await this.db.batch([
          this.db.prepare(`
            UPDATE words SET apple_definition = ?, encounter_count = encounter_count + 1,
              updated_at = ?, last_seen_at = ? WHERE id = ?
          `).bind(raced.apple_definition || appleDefinition, capturedAt, capturedAt, id),
          this.db.prepare(`
            INSERT INTO encounters (id, word_id, context, source_title, source_app, captured_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(crypto.randomUUID(), id, context, sourceTitle, sourceApp, capturedAt),
        ]);
      }
    }

    const persisted = await this.getWord(id);
    if (!persisted) throw new Error("保存した単語を読み直せませんでした。");
    const [dictionaryResult, exampleResult] = await Promise.all([
      !persisted.dictionary && ["pending", "unavailable"].includes(persisted.lookupStatus)
        ? this.dictionaryLookup(term)
        : null,
      ["pending", "unavailable"].includes(persisted.exampleLookupStatus)
        ? this.exampleLookup(term)
        : null,
    ]);
    const enrichedAt = this.now().toISOString();
    const updates: D1PreparedStatementLike[] = [];
    if (dictionaryResult) updates.push(this.dictionaryUpdate(id, dictionaryResult, enrichedAt));
    if (exampleResult) updates.push(this.exampleUpdate(id, exampleResult, enrichedAt));
    if (updates.length) await this.db.batch(updates);
    const word = await this.getWord(id);
    if (!word) throw new Error("保存した単語を読み直せませんでした。");
    return { word, created };
  }

  async refreshDictionary(id: string): Promise<PaperLexWord | null> {
    const current = await this.getWord(id);
    if (!current) return null;
    if (current.dictionary || ["complete", "not_found"].includes(current.lookupStatus)) return current;
    const result = await this.dictionaryLookup(current.term);
    await this.dictionaryUpdate(id, result, this.now().toISOString()).run();
    return this.getWord(id);
  }

  async refreshExamples(id: string): Promise<PaperLexWord | null> {
    const current = await this.getWord(id);
    if (!current) return null;
    if (["complete", "not_found"].includes(current.exampleLookupStatus)) return current;
    const result = await this.exampleLookup(current.term);
    await this.exampleUpdate(id, result, this.now().toISOString()).run();
    return this.getWord(id);
  }

  async updateWord(id: string, input: Record<string, unknown> = {}): Promise<PaperLexWord | null> {
    const current = await this.getWord(id);
    if (!current) return null;
    const customMeaning = input.customMeaning === undefined ? current.customMeaning : cleanOptionalText(input.customMeaning, 8_000, "自分の意味");
    const customExample = input.customExample === undefined ? current.customExample : cleanOptionalText(input.customExample, 4_000, "例文");
    const notes = input.notes === undefined ? current.notes : cleanOptionalText(input.notes, 12_000, "メモ");
    const tags = input.tags === undefined ? current.tags : cleanTags(input.tags);
    const status = input.status === undefined ? current.status : String(input.status) as WordStatus;
    if (!STATUSES.has(status)) throw new ValidationError("不正な復習状態です。");
    const updatedAt = this.now().toISOString();
    await this.db.prepare(`
      UPDATE words SET custom_meaning = ?, custom_example = ?, notes = ?,
        tags_json = ?, status = ?, updated_at = ? WHERE id = ?
    `).bind(customMeaning, customExample, notes, JSON.stringify(tags), status, updatedAt, id).run();
    return this.getWord(id);
  }

  async deleteWord(id: string): Promise<boolean> {
    const current = await this.getWord(id);
    if (!current) return false;
    await this.db.prepare("DELETE FROM words WHERE id = ?").bind(id).run();
    return true;
  }

  async exportBackup(): Promise<Record<string, unknown>> {
    const words = await this.listWords();
    return {
      format: "paperlex-backup",
      version: 1,
      exportedAt: this.now().toISOString(),
      words: await Promise.all(words.map((word) => this.getWord(word.id))),
    };
  }

  async importBackup(input: Record<string, unknown>): Promise<{ imported: number; encounters: number }> {
    if (input.format !== "paperlex-backup" || !Array.isArray(input.words)) {
      throw new ValidationError("PaperLexバックアップ形式ではありません。");
    }
    if (input.words.length > 1_000) throw new ValidationError("一度に取り込める単語は1000語までです。");
    let imported = 0;
    let encounterCount = 0;
    for (const raw of input.words) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("単語データが不正です。");
      const source = raw as Record<string, unknown>;
      const term = cleanTerm(source.term);
      const normalized = normalizeTerm(term);
      const existing = await this.db.prepare("SELECT id FROM words WHERE normalized_term = ?").bind(normalized).first<{ id: string }>();
      const id = existing?.id || validId(source.id) || crypto.randomUUID();
      const createdAt = validDate(source.createdAt) || this.now().toISOString();
      const updatedAt = validDate(source.updatedAt) || createdAt;
      const lastSeenAt = validDate(source.lastSeenAt) || updatedAt;
      const status = STATUSES.has(source.status as WordStatus) ? source.status as WordStatus : "new";
      const dictionary = validObject(source.dictionary) ? source.dictionary : null;
      const examples = Array.isArray(source.examples) ? source.examples.slice(0, 10) : [];
      const tags = cleanTags(source.tags);
      const statements: D1PreparedStatementLike[] = [this.db.prepare(`
        INSERT INTO words (
          id, term, normalized_term, apple_definition, dictionary_json,
          examples_json, example_lookup_status, example_lookup_attempted_at,
          custom_meaning, custom_example, notes, tags_json, status,
          lookup_status, dictionary_lookup_attempted_at, encounter_count,
          created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(normalized_term) DO UPDATE SET
          apple_definition = excluded.apple_definition,
          dictionary_json = excluded.dictionary_json,
          examples_json = excluded.examples_json,
          example_lookup_status = excluded.example_lookup_status,
          custom_meaning = excluded.custom_meaning,
          custom_example = excluded.custom_example,
          notes = excluded.notes,
          tags_json = excluded.tags_json,
          status = excluded.status,
          lookup_status = excluded.lookup_status,
          encounter_count = excluded.encounter_count,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at
      `).bind(
        id, term, normalized, cleanOptionalText(source.appleDefinition, 40_000, "Apple辞書の定義"),
        dictionary ? JSON.stringify(dictionary) : null, JSON.stringify(examples),
        examples.length ? "complete" : lookupStatus(source.exampleLookupStatus), null,
        cleanOptionalText(source.customMeaning, 8_000, "自分の意味"),
        cleanOptionalText(source.customExample, 4_000, "例文"),
        cleanOptionalText(source.notes, 12_000, "メモ"), JSON.stringify(tags), status,
        dictionary ? "complete" : lookupStatus(source.lookupStatus), null,
        Math.max(1, Number(source.encounterCount) || 1), createdAt, updatedAt, lastSeenAt,
      )];
      const encounters = Array.isArray(source.encounters) ? source.encounters.slice(0, 10_000) : [];
      for (const rawEncounter of encounters) {
        if (!rawEncounter || typeof rawEncounter !== "object" || Array.isArray(rawEncounter)) continue;
        const item = rawEncounter as Record<string, unknown>;
        statements.push(this.db.prepare(`
          INSERT OR IGNORE INTO encounters (id, word_id, context, source_title, source_app, captured_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          validId(item.id) || crypto.randomUUID(), id,
          cleanOptionalText(item.context, 4_000, "文脈"),
          cleanOptionalText(item.sourceTitle, 500, "出典名"),
          cleanOptionalText(item.sourceApp, 100, "アプリ名"),
          validDate(item.capturedAt) || lastSeenAt,
        ));
      }
      await this.db.batch(statements);
      imported += 1;
      encounterCount += encounters.length;
    }
    return { imported, encounters: encounterCount };
  }

  private dictionaryUpdate(id: string, result: Awaited<ReturnType<typeof lookupDictionary>>, attemptedAt: string): D1PreparedStatementLike {
    return this.db.prepare(`
      UPDATE words SET dictionary_json = CASE WHEN ? = 'complete' THEN ? ELSE dictionary_json END,
        lookup_status = ?, dictionary_lookup_attempted_at = ?, updated_at = ?
      WHERE id = ? AND dictionary_json IS NULL
    `).bind(result.status, result.dictionary ? JSON.stringify(result.dictionary) : null, result.status, attemptedAt, attemptedAt, id);
  }

  private exampleUpdate(id: string, result: Awaited<ReturnType<typeof lookupExamples>>, attemptedAt: string): D1PreparedStatementLike {
    return this.db.prepare(`
      UPDATE words SET examples_json = CASE WHEN ? = 'complete' THEN ? ELSE examples_json END,
        example_lookup_status = ?, example_lookup_attempted_at = ?, updated_at = ? WHERE id = ?
    `).bind(result.status, JSON.stringify(result.examples), result.status, attemptedAt, attemptedAt, id);
  }
}

export function rowToWord(row: WordRow): PaperLexWord {
  return {
    id: row.id,
    term: row.term,
    normalizedTerm: row.normalized_term,
    appleDefinition: row.apple_definition,
    dictionary: parseJson(row.dictionary_json, null, row.id, "dictionary_json"),
    examples: parseJson(row.examples_json, [], row.id, "examples_json"),
    exampleLookupStatus: row.example_lookup_status,
    customMeaning: row.custom_meaning,
    customExample: row.custom_example,
    notes: row.notes,
    tags: parseJson(row.tags_json, [], row.id, "tags_json"),
    status: row.status,
    lookupStatus: row.lookup_status,
    encounterCount: Number(row.encounter_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function rowToEncounter(row: EncounterRow): Record<string, unknown> {
  return { id: row.id, context: row.context, sourceTitle: row.source_title, sourceApp: row.source_app, capturedAt: row.captured_at };
}

function parseJson<T>(value: string | null, fallback: T, id: string, column: string): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { throw new Error(`Corrupt ${column} for word ${id}`); }
}

function validId(value: unknown): string {
  return typeof value === "string" && /^[0-9a-z-]{1,100}$/i.test(value) ? value : "";
}

function validDate(value: unknown): string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) return "";
  return new Date(value).toISOString();
}

function validObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function lookupStatus(value: unknown): LookupStatus {
  return ["pending", "complete", "not_found", "unavailable"].includes(String(value)) ? value as LookupStatus : "pending";
}
