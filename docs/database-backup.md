# Full database backup to Google Drive

## Contract

- `POST /api/admin/backups/database` (preferred) or `GET /api/admin/backups/database` for URL-based cron services.
- Required header: `Authorization: Bearer <BACKUP_API_TOKEN>`. No URL/query token support, to avoid recording secrets in access logs.
- No request body or query parameters are needed. Database, Drive destination, and dump options are server-side only.
- `GET /api/admin/backups/status` uses the same header and returns today's locally recorded state.
- Trigger is synchronous: HTTP 200 means the Drive upload was verified, not merely queued. HTTP 401 unauthorized; 503 unconfigured; 409 another job holds the database lock; 500 failed.
- Configure the external cron to call **02:00 Asia/Bangkok daily**. There is no internal scheduler and no additional monthly job.
- Every backup contains the entire selected database: tables/data, views, triggers, routines and events. It includes existing `*_backup` tables. It does not back up other databases, database users/grants, uploaded images, or Firestore.
- Root Drive folder: `1HA4PoCVIansbHIc0xA4BQFTKLCUWu5h6`. Child folder `YYYY-MM`, file `full_scmarketplus_YYYY-MM-DD.sql.gz.enc`. Dates represent the day the job starts in Bangkok.
- Drive backups are never deleted or overwritten. Retry on the same date reuses a completed verified Drive file or a locally retained encrypted archive. A failed previous day needs operator handling; a new day's request is not a historical snapshot.

Successful response example:

```json
{
  "success": true,
  "status": "completed",
  "date": "2026-10-05",
  "database": "scmarketplus",
  "skipped": false,
  "result": {
    "fileId": "google-drive-file-id",
    "fileName": "full_scmarketplus_2026-10-05.sql.gz.enc",
    "size": 123456,
    "sha256": "encrypted-file-sha256",
    "md5": "encrypted-file-md5",
    "keyId": "encryption-key-fingerprint",
    "url": "https://drive.google.com/file/d/google-drive-file-id/view"
  }
}
```

`skipped: true` means today's verified file already exists. `/status` returns `not_started`, `running`, `completed`, or `failed`. State is stored on this host; it is not a queue. After a process crash a `running` record can be stale; calling the trigger again checks the database lock and retries safely. Logs are JSON Lines at `logs/database-backup.log`, recording starts, failures, verified result and checksums, without SQL contents or tokens. HTTP access logging, if enabled at a proxy, must redact Authorization.

## Host requirements and consistency

1. Node API's existing dependencies are sufficient; no new npm package is added.
2. Install a compatible `mariadb-dump`/`mysqldump`. Set `BACKUP_DUMP_BINARY` to its absolute path if it is not on the service PATH. MariaDB hosts should use a matching MariaDB client.
3. The dump account needs SELECT, SHOW VIEW, TRIGGER, EVENT, access to routines, and privileges for global read locks (`--lock-all-tables`; version-specific privileges may include RELOAD). Check grants on the deployment host. No new table or schema migration is required.
4. **The database mixes InnoDB and MyISAM. Dump uses a global read lock, which blocks writes across the database server for the duration of the dump.** The lock is released by the dump process before uploading to Drive. Schedule in a quiet period and measure duration before production use. Do not change to `--single-transaction` while MyISAM tables require a consistent snapshot.
5. Permit outbound HTTPS to Google OAuth and Drive APIs. Use HTTPS for the public backup endpoint.
6. Keep `.backups` and `.backup-secrets` outside any public static/document root and persistent across releases. The repository ignores them. Use a protected, persistent path through the environment variables.
7. Provision local disk for compressed encrypted dumps. Successful dumps are removed locally after verified upload; failed uploads retain the encrypted archive for retry. Monitor and manually manage local abandoned jobs. Nothing removes old Drive backups.
8. Set the reverse proxy and cron HTTP timeouts longer than `BACKUP_TIMEOUT_MS` (default 30 minutes), e.g. 35 minutes. A disconnected HTTP caller does not cancel the running job; retry sees a lock or a completed backup. A URL service with a fixed short timeout may report failure while the backup succeeds; check `/status`.

## Connect a personal My Drive (one time)

A Firebase service account shared onto a personal Drive folder is insufficient for owning backup files. This integration uses the Drive owner's OAuth refresh token.

1. In Google Cloud Console, select/create a project and enable **Google Drive API**.
2. Configure OAuth consent for your account. For an External app in Testing, add your Google account as a test user. Testing-mode Drive refresh tokens may expire after seven days; configure a suitable Production consent setup for unattended operation and follow any Google verification requirements.
3. Create an OAuth client of type **Desktop app**. Download its JSON to `.backup-secrets/drive-client.json` on your computer. The local helper uses `http://127.0.0.1:53682/oauth/callback` (loopback). If using a Web client instead, register that exact redirect URI.
4. Run `npm run backup:authorize` locally. Open the printed URL on the same computer, authorize the Google account that can edit the destination folder. The helper uses state and PKCE, saves the refresh token to `.backup-secrets/drive-token.json` with mode 0600, and never prints it.
5. Securely copy both files to the API host and configure `BACKUP_DRIVE_CLIENT_FILE` / `BACKUP_DRIVE_TOKEN_FILE`. Do not paste them in chat or commit them. Files contain credentials.
6. This implementation requests the full Drive scope to access the supplied existing folder without a Picker flow. Its code only reads metadata and creates folders/files under the configured destination; it does not delete Drive files. Do not make the folder publicly accessible merely to connect this service.

## Configuration and cron

Copy the `BACKUP_*` section of `.env.example` into the host `.env`.
Generate **two independent** random values using this command (run twice), one for the API token and one for the AES-256 key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep a secure off-host copy of `BACKUP_ENCRYPTION_KEY`. Losing the key means losing the ability to restore. If rotating it, retain all old keys and identify them by `result.keyId` in logs/Drive appProperties.

Example curl (set BACKUP_API_TOKEN in the cron environment or use a protected curl config):

```bash
curl --fail-with-body --max-time 2100 --request POST \
  --header "Authorization: Bearer ${BACKUP_API_TOKEN}" \
  https://api.scmarketplus.com/api/admin/backups/database
```

In a web cron service choose GET or POST, add the Authorization header and use timezone Asia/Bangkok at 02:00. If the service cannot set headers, use a host-side cron with curl; do not append secrets to the URL. The API does not create or manage the cron itself.

## Encryption and restore

The archive is gzip-compressed SQL encrypted with AES-256-GCM. Binary format: `SCBK1` (5 bytes), random 12-byte IV, ciphertext, 16-byte authentication tag. The 17-byte header is authenticated as AAD. Size/MD5 returned by Drive is compared to the uploaded encrypted file; SHA-256 and key fingerprint are also recorded.

Download a backup to a secure workstation, set the matching encryption key, then:

```bash
npm run backup:decrypt -- full_scmarketplus_2026-10-05.sql.gz.enc restored.sql.gz
```

The decrypt helper authenticates before publishing the output and refuses to overwrite an existing destination. It does not restore automatically.

**Restore only into an isolated test server first.** Dump uses `--databases`, so SQL contains CREATE DATABASE/USE for the original database and can replace existing tables on the target server. Do not pipe it into a live server to test.

```bash
gunzip -c restored.sql.gz | mariadb --host=ISOLATED_RESTORE_HOST --user=RESTORE_USER --password
```

Validate table counts, sample row counts, views/triggers/routines and application reads, then delete plaintext restore files securely according to your policy. Separate account-level grants and external files are outside this archive.

## Tests

`npm run test:backup` uses mocked Drive/dump transports and temporary files, with no Google uploads or production database writes. Local integration testing should run a real dump into encrypted local storage and restore into an isolated test server before production activation.

References:
- https://developers.google.com/workspace/drive/api/guides/manage-uploads
- https://developers.google.com/workspace/drive/api/guides/handle-errors
- https://developers.google.com/identity/protocols/oauth2/native-app
- https://mariadb.com/docs/server/clients-and-utilities/backup-restore-and-import-clients/mariadb-dump
