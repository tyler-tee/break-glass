CREATE TABLE `places_usage` (
	`month` text PRIMARY KEY NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
