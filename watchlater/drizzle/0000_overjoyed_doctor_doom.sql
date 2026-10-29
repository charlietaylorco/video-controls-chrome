CREATE TABLE `rs_budgets` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rs_budgets_owner" CHECK("rs_budgets"."owner_id" = 'owner')
);
--> statement-breakpoint
CREATE TABLE `rs_devices` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "rs_devices_owner_partition" CHECK("rs_devices"."owner_id" = 'owner')
);
--> statement-breakpoint
CREATE INDEX `rs_devices_owner` ON `rs_devices` (`owner_id`);--> statement-breakpoint
CREATE TABLE `rs_items` (
	`owner_id` text NOT NULL,
	`video_url` text NOT NULL,
	`saved_at` integer NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`local_updated_at` integer DEFAULT 0 NOT NULL,
	`cloud_updated_at` integer DEFAULT 0 NOT NULL,
	`content_edited` integer DEFAULT 0 NOT NULL,
	`channel_norm` text DEFAULT '' NOT NULL,
	`tags_norm` text DEFAULT '[]' NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`owner_id`, `video_url`),
	CONSTRAINT "rs_items_owner" CHECK("rs_items"."owner_id" = 'owner'),
	CONSTRAINT "rs_items_data_json" CHECK(json_valid("rs_items"."data"))
);
--> statement-breakpoint
CREATE INDEX `rs_items_recent` ON `rs_items` (`owner_id`,`saved_at`,`video_url`);--> statement-breakpoint
CREATE TABLE `rs_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rs_settings_owner" CHECK("rs_settings"."owner_id" = 'owner')
);
--> statement-breakpoint
CREATE TABLE `rs_tickets` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "rs_tickets_owner_partition" CHECK("rs_tickets"."owner_id" = 'owner')
);
--> statement-breakpoint
CREATE INDEX `rs_tickets_owner` ON `rs_tickets` (`owner_id`);