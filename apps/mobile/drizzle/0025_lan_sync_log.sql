CREATE TABLE `sync_ack` (
	`peer` text NOT NULL,
	`operation_id` text NOT NULL,
	PRIMARY KEY(`peer`, `operation_id`),
	FOREIGN KEY (`operation_id`) REFERENCES `sync_operation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_head` (
	`entity` text NOT NULL,
	`field` text NOT NULL,
	`operation_id` text NOT NULL,
	PRIMARY KEY(`entity`, `field`, `operation_id`),
	FOREIGN KEY (`operation_id`) REFERENCES `sync_operation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_like` (
	`song_id` text PRIMARY KEY NOT NULL,
	`liked` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`sequence` integer NOT NULL,
	`payload` text NOT NULL,
	`applied` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_actor_sequence` ON `sync_operation` (`actor`,`sequence`);--> statement-breakpoint
CREATE TABLE `sync_revision` (
	`actor` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL
);
