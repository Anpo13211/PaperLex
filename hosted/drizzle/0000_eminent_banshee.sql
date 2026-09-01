CREATE TABLE `encounters` (
	`id` text PRIMARY KEY NOT NULL,
	`word_id` text NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`source_title` text DEFAULT '' NOT NULL,
	`source_app` text DEFAULT '' NOT NULL,
	`captured_at` text NOT NULL,
	FOREIGN KEY (`word_id`) REFERENCES `words`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_encounters_word_id_captured_at` ON `encounters` (`word_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `words` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`normalized_term` text NOT NULL,
	`apple_definition` text DEFAULT '' NOT NULL,
	`dictionary_json` text,
	`examples_json` text DEFAULT '[]' NOT NULL,
	`example_lookup_status` text DEFAULT 'pending' NOT NULL,
	`example_lookup_attempted_at` text,
	`custom_meaning` text DEFAULT '' NOT NULL,
	`custom_example` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`lookup_status` text DEFAULT 'pending' NOT NULL,
	`dictionary_lookup_attempted_at` text,
	`encounter_count` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_words_normalized_term` ON `words` (`normalized_term`);--> statement-breakpoint
CREATE INDEX `idx_words_created_at` ON `words` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_words_last_seen_at` ON `words` (`last_seen_at`);--> statement-breakpoint
PRAGMA optimize;
