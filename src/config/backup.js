const path = require('node:path');
const crypto = require('node:crypto');

function backupConfig(env = process.env) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 503 }); };
  if (!env.BACKUP_API_TOKEN || env.BACKUP_API_TOKEN.length < 32) fail('Configure BACKUP_API_TOKEN (at least 32 characters)');
  const encodedKey = env.BACKUP_ENCRYPTION_KEY || '';
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) fail('Configure BACKUP_ENCRYPTION_KEY as 32 random bytes in base64');
  const database = env.BACKUP_MYSQL_DATABASE || env.MYSQL_DATABASE || 'scmarketplus';
  if (!/^[a-zA-Z0-9_]+$/.test(database)) fail('Unsupported backup database name');
  const folderId = env.BACKUP_DRIVE_FOLDER_ID || '1HA4PoCVIansbHIc0xA4BQFTKLCUWu5h6';
  if (!/^[a-zA-Z0-9_-]+$/.test(folderId)) fail('Invalid BACKUP_DRIVE_FOLDER_ID');
  const timeoutMs = Number(env.BACKUP_TIMEOUT_MS || 1800000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000) fail('Invalid BACKUP_TIMEOUT_MS');
  const port = Number(env.BACKUP_MYSQL_PORT || env.MYSQL_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Invalid backup MySQL port');
  return {
    database, folderId, key, timeoutMs,
    keyId: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
    directory: path.resolve(env.BACKUP_DIRECTORY || '.backups'),
    logDirectory: path.resolve(env.LOG_DIRECTORY || 'logs'),
    oauthClientFile: path.resolve(env.BACKUP_DRIVE_CLIENT_FILE || '.backup-secrets/drive-client.json'),
    oauthTokenFile: path.resolve(env.BACKUP_DRIVE_TOKEN_FILE || '.backup-secrets/drive-token.json'),
    mysql: {
      host: env.BACKUP_MYSQL_HOST || env.MYSQL_HOST || '127.0.0.1', port,
      user: env.BACKUP_MYSQL_USER || env.MYSQL_USER || 'root',
      password: env.BACKUP_MYSQL_PASSWORD ?? env.MYSQL_PASSWORD ?? '', database,
      connectTimeout: 10000,
    },
  };
}

function bangkokDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
module.exports = { backupConfig, bangkokDate };
