const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');

const MAGIC = Buffer.from('SCBK1');
function optionValue(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
}
async function checksums(file) {
  const sha = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { size += chunk.length; sha.update(chunk); md5.update(chunk); }
  return { size, sha256: sha.digest('hex'), md5: md5.digest('hex') };
}
async function createArchive(config, directory, signal) {
  const credentials = path.join(directory, 'mysql.cnf');
  const destination = path.join(directory, 'backup.sql.gz.enc');
  const partial = destination + '.partial';
  const options = ['[client]', ...['host', 'port', 'user', 'password'].map(k => `${k}=${optionValue(config.mysql[k])}`)].join('\n') + '\n';
  await fsp.writeFile(credentials, options, { mode: 0o600, flag: 'wx' });
  let child;
  try {
    const iv = crypto.randomBytes(12);
    const header = Buffer.concat([MAGIC, iv]);
    await fsp.writeFile(partial, header, { mode: 0o600, flag: 'wx' });
    const cipher = crypto.createCipheriv('aes-256-gcm', config.key, iv);
    cipher.setAAD(header);
    // Global read lock is required for a consistent dump including MyISAM tables.
    child = spawn(config.dumpBinary, [
      `--defaults-extra-file=${credentials}`, '--protocol=TCP', '--lock-all-tables',
      '--routines', '--events', '--triggers', '--hex-blob', '--quick',
      '--default-character-set=utf8mb4', '--databases', config.database,
    ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
    child.stderr.resume(); // Never log SQL, credentials, or complete child-process errors.
    const exited = new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Cannot start database dump; check dump binary and timeout')));
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Database dump failed (exit ${code}); check database privileges and dump client compatibility`)));
    });
    let bytes = 0;
    const counter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(null, chunk); } });
    const streamed = pipeline(child.stdout, counter, zlib.createGzip(), cipher,
      fs.createWriteStream(partial, { flags: 'a', mode: 0o600 }), { signal });
    streamed.catch(() => child.kill('SIGKILL'));
    const results = await Promise.allSettled([exited, streamed]);
    const failure = results.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
    if (bytes === 0) throw new Error('Database dump produced no output');
    await fsp.appendFile(partial, cipher.getAuthTag());
    await fsp.rename(partial, destination);
    return { path: destination, ...(await checksums(destination)) };
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await fsp.rm(credentials, { force: true });
    await fsp.rm(partial, { force: true });
  }
}

// Write only authenticated output: a bad key or damaged archive never replaces the destination.
async function decryptArchive(source, destination, key) {
  const handle = await fsp.open(source, 'r');
  const partial = destination + '.' + crypto.randomUUID() + '.partial';
  try {
    const { size } = await handle.stat();
    if (size < 34 || key.length !== 32) throw new Error('Invalid archive or encryption key');
    const header = Buffer.alloc(17), tag = Buffer.alloc(16);
    await handle.read(header, 0, 17, 0);
    await handle.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, 5).equals(MAGIC)) throw new Error('Unsupported archive format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(5));
    decipher.setAAD(header); decipher.setAuthTag(tag);
    await pipeline(fs.createReadStream(source, { start: 17, end: size - 17 }), decipher,
      fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    // link fails if the destination already exists (never overwrite an existing restore file).
    await fsp.link(partial, destination);
  } finally { await handle.close(); await fsp.rm(partial, { force: true }); }
}
module.exports = { createArchive, decryptArchive, checksums, optionValue };
