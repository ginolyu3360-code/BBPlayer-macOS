# Personal macOS and Android build

This implementation uses the native macOS application in `apps/macos` and an independent Android personal application (`com.bbplayer.personal`). Local build and automated checks do not establish physical-device acceptance. Installation, publishing and Git operations are separate actions.

## Library and originals

Songs have stable library identities, independent of their Bilibili source keys. Replacing a source updates saved playlist references while retaining old sources and listening-event snapshots. Playback already in progress continues its current source. Existing downloads and source-specific lyrics are not silently reassigned.

Local audio references user-selected originals; editing title/artist changes the database only. Missing files remain in the library and can be relinked. Android keeps a read grant when the picker/provider supports it. Backup archives contain references, not original audio; moved files or lost grants may need relinking.

History snapshots retain the metadata available at the event. Older migration snapshots are explicitly distinguished from new playback snapshots. A missing CID remains unknown; it is not inferred from a title or presented as observed evidence. Known CIDs are retained in playback requests without changing a default-video source key.

## Backup and restore

Use the backup page in either application. macOS and Android archives use different native schemas and cannot be restored into each other; paired LAN synchronization is the cross-platform transfer path. Automatic backups run at the first launch of a local day when portable library content changes, retaining ten automatic archives. Manual exports are not pruned. Protective backups precede destructive migrations, source replacement and relinking; full restore keeps its latest pre-restore protection.

Archives include library metadata, order, histories, lyrics, local likes and allowed preferences. Android also packages managed cover bytes and remaps their references. Audio, temporary caches, account credentials, paired-device credentials and transport logs are excluded. macOS currently has no managed cover-image editor; safe remote cover metadata is retained.

1. Merge preserves current order and appends new entries. Choose current or imported versions for metadata conflicts. Duplicate history is not added twice. A source assigned to a different stable song identity is rejected.
2. Full restore validates a private staged copy, stops writers and replaces the library with rollback protection. Android requires restarting the application after success.

Legacy Android archives without stable playlist identities support full restore; they cannot safely be merged by playlist title or device-local numeric IDs. Upgrade and export again to obtain a mergeable archive.

## Local-network pairing

1. Enable device synchronization in macOS settings and generate a pairing invitation.
2. In Android settings, open device synchronization. Paste the invitation, or use a system QR reader capable of opening the personal application's link. Discovery supplies address hints; it does not establish trust.
3. Confirm that the Mac is the initial authority. Android first creates a protection backup, pauses playback and replaces the network portion of its local playlists. Original audio, mixed-playlist local entries and actual listening history remain on the phone.
4. Initial receipt blocks ordinary edits. Retry an interrupted transfer, or cancel it. Completion or cancellation after partial receipt requires one restart so old JavaScript work cannot overwrite the new baseline.
5. Subsequent foreground edits debounce for two seconds; foreground polling runs every thirty seconds. Both devices must remain reachable on the same local network. A proxy must permit direct LAN traffic.

Only local-playlist network entries, application-local likes and explicit source-specific lyric choices are synchronized. Original audio, downloads, history, progress, preferences and credentials stay on each device. Concurrent conflicting versions remain selectable; deletion versus editing retains the item until resolution. New network entries append, network reordering preserves local entries, and replay does not revive tombstones.

The Mac serves TLS using a separate Keychain identity. Android pins the invited leaf certificate and permits only literal private/link-local/loopback addresses. Connections do not change global proxy, TLS or cookie settings. Invitations expire after five minutes, are single-use and have bounded attempts. Revoke devices in Mac settings. A restored library pauses synchronization; explicitly establish a new baseline and pair again. Silent startup does not request Keychain interaction.

## Playback and presentation

The watchdog runs independently of JavaScript/media progress callbacks: twelve seconds of a frozen clock or twenty seconds of initial loading can trigger three bounded retries with one-, three- and six-second backoff. Pause, switching, sleep gaps, seeking and offline buffering are excluded. Thirty healthy seconds reset the budget. It observes playback state and clock progression, not the sound emitted by a speaker.

Highest available ordinary AAC remains the default. Optional lossless or Dolby preferences select a source only when offered and supported by a decoder. Actual parsing/decoding failure can fall back to AAC. The applications do not transcode; existing downloads retain their recorded specification. Quality changes apply to later source loads/queue additions, and existing restored Android queue URLs retain their original selection. Real account entitlements and output-device capabilities still require device acceptance.

The optional ten-band equalizer is disabled by default. It supports 31/62/125/250/500/1000/2000/4000/8000/16000 Hz, ±12 dB, flat/bass/voice/bright presets and custom gains. Coefficients and bypass changes are smoothed, with headroom based on combined filter response. Unsupported formats keep unprocessed audio. Android prohibits compressed bypass/offload while EQ is enabled. macOS handles supported Float32 tap formats with up to eight channels; Android handles PCM16/Float32 with up to eight channels. Bands beyond the current Nyquist limit are bypassed. Live device behavior has not yet been accepted.

The Mac mini player uses the same engine and queue, with seek, volume, pinning, expandable queue and display-bound recovery. Open it from the playback menu or menu bar (Command–Shift–M). Android retains its in-app minibar and existing notification/lock-screen integration; no additional system-overlay mini-player permission is introduced.

Lyric appearance settings provide size, spacing, translation proportions, highlighting, edge masking, clear/compact/large presets, preview and reset. Appearance stays local to each device; timed lyric content remains source-specific.

## Local build and verification

Run JavaScript checks from the repository root:

```sh
pnpm type-check
pnpm lint
node --test apps/mobile/tests/*.test.mjs
```

Use `swift test --package-path apps/macos` and `apps/macos/scripts/build-app.sh release` for macOS. Packaging uses the existing persistent signing configuration when available and does not install the application. Do not use the install/update script without its separate commit/push/install authorization.

For Android, the already provisioned Java and Android SDK must be selected through the command environment. The signing helper requires the four `BBPLAYER_PERSONAL_*` signing variables, obtained from the separately protected local signing configuration; never put passwords or private keys in this repository.

```sh
node apps/mobile/scripts/personal-android.mjs config
node apps/mobile/scripts/personal-android.mjs prebuild
node apps/mobile/scripts/personal-android.mjs build
```

The helper neither installs nor publishes. Use the locked pnpm dependencies. Personal builds disable inherited account-sharing, telemetry/upload and over-the-air update paths. Missing signing credentials fail closed for release packaging. The personal-only Gradle configuration uses `android.lint.useK2Uast=false` for the existing analyzer compatibility issue; lint remains enabled.

Physical pairing twice, hotspot/proxy combinations, hardware media controls, decoding on the target phone, multi-display interaction, real UI acceptance and four-hour endurance remain deferred. Refer to the current validation records for automated results and known lint failures; do not infer these device results from successful builds.
