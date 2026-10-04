const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const express = require('express');
const { backupConfig, bangkokDate } = require('../src/config/backup');
const { createArchive, decryptArchive, checksums, optionValue } = require('../src/services/backup/archive');
const { BackupDrive } = require('../src/services/backup/drive');
const { runBackup } = require('../src/services/backup/job');
const { backupRouter } = require('../src/routes/backup.routes');

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scmarket-backup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function config(directory) {
  return backupConfig({ BACKUP_API_TOKEN: 't'.repeat(40), BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    BACKUP_DIRECTORY: directory, LOG_DIRECTORY: path.join(directory, 'logs') });
}

test('Bangkok date crosses UTC day and month; invalid config fails closed', () => {
  assert.equal(bangkokDate(new Date('2026-09-30T19:00:00Z')), '2026-10-01');
  assert.throws(() => backupConfig({}), /BACKUP_API_TOKEN/);
  assert.throws(() => backupConfig({ BACKUP_API_TOKEN: 't'.repeat(40) }), /ENCRYPTION/);
  assert.equal(optionValue('x"\\\n#'), '"x\\"\\\\\\n#"');
});

test('dump streams encrypted gzip, credentials removed, tampering rejected', async t => {
  const directory = await temporary(t);
  const executable = path.join(directory, 'fake-dump');
  await fs.writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write("CREATE TABLE sample (id INT);\\nINSERT INTO sample VALUES (1);\\n");\n', { mode: 0o700 });
  const cfg = { ...config(directory), dumpBinary: executable };
  const artifact = await createArchive(cfg, directory, new AbortController().signal);
  assert.equal((await checksums(artifact.path)).sha256, artifact.sha256);
  await assert.rejects(fs.access(path.join(directory, 'mysql.cnf')));
  assert.equal((await fs.stat(artifact.path)).mode & 0o777, 0o600);
  const restored = path.join(directory, 'restored.gz');
  await decryptArchive(artifact.path, restored, cfg.key);
  assert.match(zlib.gunzipSync(await fs.readFile(restored)).toString(), /INSERT INTO sample VALUES \(1\)/);
  await assert.rejects(decryptArchive(artifact.path, restored, cfg.key), /EEXIST/);
  const damaged = await fs.readFile(artifact.path); damaged[20] ^= 1;
  await fs.writeFile(artifact.path, damaged);
  const badOutput = path.join(directory, 'bad.gz');
  await assert.rejects(decryptArchive(artifact.path, badOutput, cfg.key));
  await assert.rejects(fs.access(badOutput));
});

test('dump failure never publishes an archive and removes plaintext credentials', async t => {
  const directory = await temporary(t);
  const executable = path.join(directory, 'failed-dump');
  await fs.writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write("partial SQL"); process.exitCode = 2;\n', { mode: 0o700 });
  await assert.rejects(createArchive({ ...config(directory), dumpBinary: executable }, directory, new AbortController().signal), /dump failed/);
  await assert.rejects(fs.access(path.join(directory, 'backup.sql.gz.enc')));
  await assert.rejects(fs.access(path.join(directory, 'mysql.cnf')));
});

test('Drive size/checksum verification rejects corrupted metadata', () => {
  const drive = new BackupDrive({}, undefined);
  const file = { id: 'id1', name: 'full.enc', size: '30', md5Checksum: 'abc', appProperties: { md5: 'abc', size: '30', sha256: 'a'.repeat(64), keyId: 'key' } };
  assert.equal(drive.verify(file).fileId, 'id1');
  assert.throws(() => drive.verify({ ...file, size: '31' }), /verification/);
  assert.equal(drive.offset('bytes=0-42', 100), 43);
  assert.throws(() => drive.offset('bytes=0-999', 100), /offset/);
});

test('Drive resumes from server offset after a lost upload response', async t => {
  const directory = await temporary(t), file = path.join(directory, 'file.enc');
  await fs.writeFile(file, Buffer.from('abcdefghij'));
  const artifact = { path: file, ...(await checksums(file)) };
  const drive = new BackupDrive({}, new AbortController().signal);
  let stage = 0;
  drive.request = async options => {
    stage++;
    if (stage === 1) return { status: 200, headers: { location: 'https://www.googleapis.com/upload/session' } };
    if (stage === 2) throw new Error('connection lost');
    if (stage === 3) { assert.equal(options.headers['Content-Range'], 'bytes */10'); return { status: 308, headers: { range: 'bytes=0-4' } }; }
    assert.equal(options.headers['Content-Range'], 'bytes 5-9/10');
    assert.equal(options.data.toString(), 'fghij');
    return { status: 200, data: { id: 'done' } };
  };
  drive.verifyUploaded = async (id, received) => { assert.equal(received.md5, artifact.md5); return { fileId: id }; };
  assert.equal((await drive.upload('month', 'file.enc', artifact, 'day', 'key')).fileId, 'done');
  assert.equal(stage, 4);
});

function fakeConnection(acquired = 1) {
  const connection = new EventEmitter();
  connection.released = false;
  connection.execute = async sql => { if (sql.includes('RELEASE_LOCK')) connection.released = true; return [[{ acquired }]]; };
  connection.ping = async () => {};
  connection.end = async () => {};
  return connection;
}
function fakeDependencies(directory) {
  const shared = { remote: null, dumps: 0, uploads: 0, fail: false, connections: [] };
  class Drive {
    async preflight() {}
    async monthFolder(month) { assert.equal(month, '2026-10'); return 'month'; }
    async findBackup() { return shared.remote; }
    verify(file) { return file; }
    async upload(folder, name, artifact) {
      shared.uploads++;
      if (shared.fail) throw new Error('Drive unavailable');
      assert.equal(name, 'full_scmarketplus_2026-10-05.sql.gz.enc');
      shared.remote = { fileId: 'file', fileName: name, size: artifact.size, sha256: artifact.sha256, md5: artifact.md5 };
      return shared.remote;
    }
  }
  return { shared, dependencies: { Drive, now: new Date('2026-10-04T19:00:00Z'),
    connect: async () => { const c = fakeConnection(); shared.connections.push(c); return c; },
    archive: async (cfg, dir) => { shared.dumps++; const file = path.join(dir, 'backup.sql.gz.enc'); await fs.writeFile(file, 'encrypted test artifact'); return { path: file, ...(await checksums(file)) }; },
  } };
}

test('daily job uploads once, releases lock, repeated calls do not dump again', async t => {
  const directory = await temporary(t), cfg = config(directory);
  const { shared, dependencies } = fakeDependencies(directory);
  const first = await runBackup(cfg, dependencies);
  const second = await runBackup(cfg, dependencies);
  assert.equal(first.status, 'completed'); assert.equal(second.skipped, true);
  assert.equal(shared.dumps, 1); assert.equal(shared.uploads, 1);
  assert.ok(shared.connections.every(c => c.released));
  await assert.rejects(fs.access(path.join(directory, 'scmarketplus', '2026-10-05', 'backup.sql.gz.enc')));
});

test('failed upload keeps encrypted artifact; retry uploads without dumping again', async t => {
  const directory = await temporary(t), cfg = config(directory);
  const { shared, dependencies } = fakeDependencies(directory); shared.fail = true;
  await assert.rejects(runBackup(cfg, dependencies), /Drive unavailable/);
  await fs.access(path.join(directory, 'scmarketplus', '2026-10-05', 'backup.sql.gz.enc'));
  shared.fail = false;
  await runBackup(cfg, dependencies);
  assert.equal(shared.dumps, 1); assert.equal(shared.uploads, 2);
});

test('concurrent job receives conflict before any dump or upload', async t => {
  const cfg = config(await temporary(t));
  await assert.rejects(runBackup(cfg, { connect: async () => fakeConnection(0) }), error => error.statusCode === 409);
});

test('cron routes require header token and reject query tokens', async t => {
  const app = express(); let calls = 0;
  app.use('/api/admin/backups', backupRouter({ env: { BACKUP_API_TOKEN: 't'.repeat(40) },
    run: async () => { calls++; return { status: 'completed' }; }, latest: async () => ({ status: 'not_started' }) }));
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/admin/backups`;
  assert.equal((await fetch(base + '/database')).status, 401);
  const headers = { Authorization: 'Bearer ' + 't'.repeat(40) };
  assert.equal((await fetch(base + '/database?token=secret', { headers })).status, 400);
  assert.equal((await fetch(base + '/database', { headers, method: 'HEAD' })).status, 405);
  const result = await fetch(base + '/database', { headers, method: 'POST' });
  assert.equal(result.status, 200); assert.equal((await result.json()).status, 'completed');
  assert.equal((await fetch(base + '/database', { headers })).status, 200);
  assert.equal(calls, 2);
});

test('dump timeout terminates even a child that ignores SIGTERM', async t => {
  const directory = await temporary(t);
  const executable = path.join(directory, 'hanging-dump');
  await fs.writeFile(executable, '#!/usr/bin/env node\nprocess.on("SIGTERM",()=>{}); setInterval(()=>{},1000);\n', { mode: 0o700 });
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 500);
  try {
    await assert.rejects(createArchive({ ...config(directory), dumpBinary: executable }, directory, control.signal));
    await assert.rejects(fs.access(path.join(directory, 'mysql.cnf')));
  } finally { clearTimeout(timer); }
});
