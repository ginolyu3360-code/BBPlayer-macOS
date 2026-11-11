CREATE TABLE `history_source_snapshots` (
	`history_id` integer PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`source_key` text NOT NULL,
	`payload` text NOT NULL,
	`evidence` text NOT NULL,
	FOREIGN KEY (`history_id`) REFERENCES `play_history`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`song_id`) REFERENCES `library_songs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `library_songs` (
	`id` text PRIMARY KEY NOT NULL,
	`active_source_key` text,
	FOREIGN KEY (`active_source_key`) REFERENCES `tracks`(`unique_key`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_songs_active_source_key_unique` ON `library_songs` (`active_source_key`);--> statement-breakpoint
CREATE TABLE `song_sources` (
	`source_key` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	FOREIGN KEY (`source_key`) REFERENCES `tracks`(`unique_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`song_id`) REFERENCES `library_songs`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
INSERT INTO library_songs(id,active_source_key) SELECT (lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),unique_key FROM tracks;
--> statement-breakpoint
INSERT INTO song_sources(source_key,song_id) SELECT active_source_key,id FROM library_songs;
--> statement-breakpoint
INSERT INTO history_source_snapshots(history_id,song_id,source_key,payload,evidence) SELECT h.id,s.song_id,t.unique_key,json_object('sourceKey',t.unique_key,'title',t.title,'artist',a.name,'source',t.source,'bvid',b.bvid,'cid',b.cid,'localPath',l.local_path),'observedAtMigration' FROM play_history h JOIN tracks t ON t.id=h.track_id JOIN song_sources s ON s.source_key=t.unique_key LEFT JOIN artists a ON a.id=t.artist_id LEFT JOIN bilibili_metadata b ON b.track_id=t.id LEFT JOIN local_metadata l ON l.track_id=t.id;
--> statement-breakpoint
CREATE TRIGGER track_song_identity AFTER INSERT ON tracks BEGIN
 INSERT INTO library_songs(id,active_source_key) VALUES((lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))),NEW.unique_key);
 INSERT INTO song_sources(source_key,song_id) SELECT NEW.unique_key,id FROM library_songs WHERE active_source_key=NEW.unique_key;
END;
--> statement-breakpoint
CREATE TRIGGER history_source_identity AFTER INSERT ON play_history BEGIN
 INSERT INTO history_source_snapshots(history_id,song_id,source_key,payload,evidence) SELECT h.id,s.song_id,t.unique_key,json_object('sourceKey',t.unique_key,'title',t.title,'artist',a.name,'source',t.source,'bvid',b.bvid,'cid',b.cid,'localPath',l.local_path),'recordedAtPlayback' FROM play_history h JOIN tracks t ON t.id=h.track_id JOIN song_sources s ON s.source_key=t.unique_key LEFT JOIN artists a ON a.id=t.artist_id LEFT JOIN bilibili_metadata b ON b.track_id=t.id LEFT JOIN local_metadata l ON l.track_id=t.id WHERE h.id=NEW.id;
END;
