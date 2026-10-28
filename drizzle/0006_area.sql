ALTER TABLE `categories` ADD `area` text DEFAULT 'health' NOT NULL CONSTRAINT "categories_area_check" CHECK(`area` in ('health','home'));--> statement-breakpoint
ALTER TABLE `protocols` ADD `area` text DEFAULT 'health' NOT NULL CONSTRAINT "protocols_area_check" CHECK(`area` in ('health','home'));
