CREATE TABLE `app_secrets` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `household_name` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `emergency_number` text DEFAULT '911' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `setup_completed_at` integer;