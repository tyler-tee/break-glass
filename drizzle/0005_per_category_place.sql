DROP INDEX `locations_place_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `locations_category_place_idx` ON `locations` (`category_id`,`place_id`);