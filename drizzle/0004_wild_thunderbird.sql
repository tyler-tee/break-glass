CREATE TABLE `find_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`category_ids` text NOT NULL,
	`progress` text NOT NULL,
	`calls_used` integer DEFAULT 0 NOT NULL,
	`llm_calls` integer DEFAULT 0 NOT NULL,
	`error` text,
	CONSTRAINT "find_runs_status_check" CHECK("find_runs"."status" in ('running','done','failed'))
);
--> statement-breakpoint
ALTER TABLE `categories` ADD `hours_need` text DEFAULT 'overnight' NOT NULL CONSTRAINT "categories_hours_need_check" CHECK(`hours_need` in ('overnight','daytime'));--> statement-breakpoint
UPDATE `categories` SET `hours_need` = 'daytime' WHERE `slug` IN ('urgent-care', 'pediatrician');--> statement-breakpoint
ALTER TABLE `categories` DROP COLUMN `target_count`;--> statement-breakpoint
ALTER TABLE `locations` ADD `rank_verdict` text CONSTRAINT "locations_rank_verdict_check" CHECK(`rank_verdict` is null or `rank_verdict` in ('pick','backup','avoid'));--> statement-breakpoint
ALTER TABLE `locations` ADD `rank_position` integer;--> statement-breakpoint
ALTER TABLE `locations` ADD `rank_reason` text;--> statement-breakpoint
ALTER TABLE `locations` ADD `rank_flags` text;--> statement-breakpoint
ALTER TABLE `locations` ADD `ranked_by` text CONSTRAINT "locations_ranked_by_check" CHECK(`ranked_by` is null or `ranked_by` in ('llm','rules'));--> statement-breakpoint
ALTER TABLE `locations` ADD `ranked_at` integer;--> statement-breakpoint
ALTER TABLE `locations` ADD `short_address` text;--> statement-breakpoint
ALTER TABLE `locations` ADD `primary_type` text;--> statement-breakpoint
ALTER TABLE `locations` ADD `maps_uri` text;
