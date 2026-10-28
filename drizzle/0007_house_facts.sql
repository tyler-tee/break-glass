CREATE TABLE `house_fact_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fact_id` integer NOT NULL,
	`mime` text NOT NULL,
	`bytes` blob NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`caption` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`fact_id`) REFERENCES `house_facts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "house_fact_photos_mime_check" CHECK("house_fact_photos"."mime" in ('image/jpeg','image/png','image/webp'))
);
--> statement-breakpoint
CREATE INDEX `house_fact_photos_fact_sort_idx` ON `house_fact_photos` (`fact_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `house_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`system` text DEFAULT 'general' NOT NULL,
	`title` text NOT NULL,
	`where_note` text,
	`instructions` text,
	`org` text,
	`phone` text,
	`category_id` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "house_facts_kind_check" CHECK("house_facts"."kind" in ('shutoff','utility','contact','note'))
);
