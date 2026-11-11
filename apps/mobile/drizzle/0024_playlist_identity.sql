CREATE TABLE `playlist_identities` (
	`playlist_id` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playlist_identities_id_unique` ON `playlist_identities` (`id`);
--> statement-breakpoint
INSERT INTO playlist_identities(playlist_id,id) SELECT id,(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))) FROM playlists;
--> statement-breakpoint
CREATE TRIGGER playlist_identity AFTER INSERT ON playlists BEGIN
 INSERT INTO playlist_identities(playlist_id,id) VALUES(NEW.id,(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))));
END;
