import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const words = sqliteTable(
  "words",
  {
    id: text("id").primaryKey(),
    term: text("term").notNull(),
    normalizedTerm: text("normalized_term").notNull(),
    appleDefinition: text("apple_definition").notNull().default(""),
    dictionaryJson: text("dictionary_json"),
    examplesJson: text("examples_json").notNull().default("[]"),
    exampleLookupStatus: text("example_lookup_status").notNull().default("pending"),
    exampleLookupAttemptedAt: text("example_lookup_attempted_at"),
    customMeaning: text("custom_meaning").notNull().default(""),
    customExample: text("custom_example").notNull().default(""),
    notes: text("notes").notNull().default(""),
    tagsJson: text("tags_json").notNull().default("[]"),
    status: text("status", { enum: ["new", "learning", "mastered"] }).notNull().default("new"),
    lookupStatus: text("lookup_status").notNull().default("pending"),
    dictionaryLookupAttemptedAt: text("dictionary_lookup_attempted_at"),
    encounterCount: integer("encounter_count").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_words_normalized_term").on(table.normalizedTerm),
    index("idx_words_created_at").on(table.createdAt),
    index("idx_words_last_seen_at").on(table.lastSeenAt),
  ],
);

export const encounters = sqliteTable(
  "encounters",
  {
    id: text("id").primaryKey(),
    wordId: text("word_id").notNull().references(() => words.id, { onDelete: "cascade" }),
    context: text("context").notNull().default(""),
    sourceTitle: text("source_title").notNull().default(""),
    sourceApp: text("source_app").notNull().default(""),
    capturedAt: text("captured_at").notNull(),
  },
  (table) => [index("idx_encounters_word_id_captured_at").on(table.wordId, table.capturedAt)],
);
