const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { backupConfig, bangkokDate } = require('../../config/backup');
const { BackupDrive } = require('./drive');
const { createArchive, checksums } = require('./archive');

async function readState(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read backup state file'); }
}
async function writeState(file, state) {
  const temporary = file + '.' + crypto.randomUUID();
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
}
async function log(config, event, data) {
  await fs.mkdir(config.logDirectory, { recursive: true });
  await fs.appendFile(path.join(config.logDirectory, 'database-backup.log'),
    JSON.stringify({ time: new Date().toISOString(), event, ...data }) + '\n', { mode: 0o600 });
}
function location(config, date) { return path.join(config.directory, config.database, date); }
async function latestBackup(config = backupConfig()) {
  const date = bangkokDate();
  const state = await readState(path.join(location(config, date), 'state.json'));
  return state ? publicState(state) : { status: 'not_started', date, database: config.database };
}
function publicState(state) {
  const { status, date, database, startedAt, completedAt, failedAt, error, result } = state;
  return { status, date, database, startedAt, completedAt, failedAt, error, result };
}
async function runBackup(config = backupConfig(), dependencies = {}) {
  const connect = dependencies.connect || mysql.createConnection;
  const archive = dependencies.archive || createArchive;
  const Drive = dependencies.Drive || BackupDrive;
  const date = bangkokDate(dependencies.now || new Date());
  const directory = location(config, date), stateFile = path.join(directory, 'state.json');
  const backupKey = crypto.createHash('sha256').update(`scmarket-full-v1:${config.database}:${date}`).digest('hex');
  const lockName = 'backup:' + crypto.createHash('sha256').update(config.database).digest('hex').slice(0, 48);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Backup time limit exceeded')), config.timeoutMs);
  timer.unref();
  let connection, heartbeat, locked = false, state;
  try {
    connection = await connect(config.mysql);
    connection.on('error', () => controller.abort(new Error('Backup database lock connection lost')));
    const [rows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (Number(rows[0].acquired) !== 1) throw Object.assign(new Error('A database backup is already running'), { statusCode: 409 });
    locked = true;
    heartbeat = setInterval(() => connection.ping().catch(() => controller.abort(new Error('Backup database lock connection lost'))), 30000);
    heartbeat.unref();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    state = await readState(stateFile) || {};
    state = { ...state, status: 'running', date, database: config.database, startedAt: new Date().toISOString(),
      completedAt: undefined, failedAt: undefined, error: undefined };
    await writeState(stateFile, state);
    await log(config, 'started', { date, database: config.database });
    const drive = new Drive(config, controller.signal);
    await drive.preflight();
    const folder = await drive.monthFolder(date.slice(0, 7));
    const existing = await drive.findBackup(folder, backupKey);
    let result, skipped = false;
    if (existing) {
      result = drive.verify(existing);
      skipped = true;
    } else {
      controller.signal.throwIfAborted();
      // If an earlier upload failed, reuse the same encrypted snapshot for this date.
      const artifactPath = path.join(directory, 'backup.sql.gz.enc');
      let artifact;
      if (state.artifact) {
        artifact = { ...state.artifact, path: artifactPath };
        const actual = await checksums(artifact.path);
        if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size || actual.md5 !== artifact.md5) throw new Error('Local backup archive checksum mismatch');
      } else {
        // Only this SQL-lock holder may clean incomplete files left by a terminated process.
        await fs.rm(path.join(directory, 'mysql.cnf'), { force: true });
        await fs.rm(artifactPath + '.partial', { force: true });
        await fs.rm(artifactPath, { force: true });
        artifact = await archive(config, directory, controller.signal);
        state.artifact = { size: artifact.size, md5: artifact.md5, sha256: artifact.sha256, keyId: config.keyId };
        await writeState(stateFile, state);
      }
      result = await drive.upload(folder, `full_${config.database}_${date}.sql.gz.enc`, artifact, backupKey, state.artifact.keyId);
    }
    controller.signal.throwIfAborted();
    state = { ...state, status: 'completed', completedAt: new Date().toISOString(), result, artifact: undefined };
    await writeState(stateFile, state);
    await log(config, 'completed', { date, database: config.database, skipped, ...result });
    await fs.rm(path.join(directory, 'backup.sql.gz.enc'), { force: true });
    return { ...publicState(state), skipped };
  } catch (error) {
    // Do not serialize Axios/MySQL errors: they may contain credentials or SQL.
    const message = controller.signal.aborted ? 'Backup timed out or database lock connection was lost' :
      (error.sql || error.config || error.sqlMessage ? 'Backup database or remote request failed' : error.message);
    if (state) {
      state = { ...state, status: 'failed', failedAt: new Date().toISOString(), error: message };
      await writeState(stateFile, state).catch(() => {});
    }
    await log(config, 'failed', { date, database: config.database, message }).catch(() => {});
    throw Object.assign(new Error(message), { statusCode: error.statusCode || 500 });
  } finally {
    clearTimeout(timer); clearInterval(heartbeat);
    if (connection) {
      if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
      await connection.end().catch(() => {});
    }
  }
}
module.exports = { runBackup, latestBackup, readState, writeState };
