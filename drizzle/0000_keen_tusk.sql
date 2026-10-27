CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`search_terms` text NOT NULL,
	`target_count` integer DEFAULT 5
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE TABLE `location_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`location_id` integer NOT NULL,
	`detected_at` integer NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`resolved_at` integer,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `location_changes_location_resolved_idx` ON `location_changes` (`location_id`,`resolved_at`);--> statement-breakpoint
CREATE TABLE `location_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`location_id` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`payload` text NOT NULL,
	`hash` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `location_snapshots_location_fetched_idx` ON `location_snapshots` (`location_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`place_id` text,
	`name` text NOT NULL,
	`address` text,
	`phone` text,
	`website` text,
	`lat` real,
	`lng` real,
	`distance_mi` real,
	`rating` real,
	`rating_count` integer,
	`business_status` text,
	`hours` text,
	`after_hours_notes` text,
	`walk_ins` integer,
	`insurance_notes` text,
	`admin_notes` text,
	`status` text DEFAULT 'candidate' NOT NULL,
	`last_verified_at` integer,
	`consecutive_fetch_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "locations_status_check" CHECK("locations"."status" in ('candidate','approved','warn','rejected')),
	CONSTRAINT "locations_business_status_check" CHECK("locations"."business_status" is null or "locations"."business_status" in ('OPERATIONAL','CLOSED_TEMPORARILY','CLOSED_PERMANENTLY'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `locations_place_id_unique` ON `locations` (`place_id`);--> statement-breakpoint
CREATE INDEX `locations_category_status_idx` ON `locations` (`category_id`,`status`);--> statement-breakpoint
CREATE TABLE `protocol_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`protocol_version_id` integer NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`fetched_at` integer,
	`content_hash` text,
	FOREIGN KEY (`protocol_version_id`) REFERENCES `protocol_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `protocol_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`protocol_id` integer NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`body_md` text NOT NULL,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	`reviewed_at` integer,
	`review_notes` text,
	FOREIGN KEY (`protocol_id`) REFERENCES `protocols`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "protocol_versions_status_check" CHECK("protocol_versions"."status" in ('draft','in_review','published','superseded','rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocol_versions_protocol_version_idx` ON `protocol_versions` (`protocol_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_published` ON `protocol_versions` (`protocol_id`) WHERE status = 'published';--> statement-breakpoint
CREATE TABLE `protocols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`tags` text,
	`needs_rereview` integer DEFAULT false NOT NULL,
	`rereview_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocols_slug_unique` ON `protocols` (`slug`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`home_label` text,
	`home_lat` real,
	`home_lng` real,
	`home_tz` text DEFAULT 'America/Denver' NOT NULL,
	`default_radius_mi` real DEFAULT 15,
	`location_refresh_cron` text DEFAULT '0 3 * * 0',
	`protocol_refresh_cron` text DEFAULT '0 4 1 * *',
	CONSTRAINT "settings_single_row" CHECK(id = 1)
);
