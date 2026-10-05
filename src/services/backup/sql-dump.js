const mysql = require('mysql2');
const crypto = require('node:crypto');
const { addAbortSignal } = require('node:stream');
const identifier = value => '`' + String(value).replace(/`/g, '``') + '`';
function literal(value) {
  if (value === null) return 'NULL';
  if (Buffer.isBuffer(value)) return "X'" + value.toString('hex') + "'";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// Lock all base tables together for a consistent MyISAM and InnoDB snapshot.
// Keep one connection alive until every row and object definition has been streamed.
async function* sqlDump(config, signal) {
  signal?.throwIfAborted();
  const connection = mysql.createConnection({ ...config.mysql, charset: 'utf8mb4',
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  // Metadata reads use a separate connection: LOCK TABLES restricts the data connection.
  const metadata = mysql.createConnection({ ...config.mysql, charset: 'utf8mb4', dateStrings: true });
  metadata.on('error', () => {});
  let lockConnectionLost = false;
  connection.on('error', () => { lockConnectionLost = true; });
  connection.on('end', () => { lockConnectionLost = true; });
  const abort = () => { connection.destroy(); metadata.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  const db = identifier(config.database);
  const query = async (sql, values, target = metadata) => {
    signal?.throwIfAborted();
    if (lockConnectionLost) throw Object.assign(new Error('Database lock connection lost'), { code: 'BACKUP_LOCK_LOST' });
    let onAbort;
    try {
      return await Promise.race([
        target.promise().query(sql, values).then(([rows]) => rows),
        new Promise((resolve, reject) => {
          onAbort = () => reject(new Error('Database dump aborted'));
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
      ]);
    } finally { signal?.removeEventListener('abort', onAbort); }
  };
  try {
    await query('SET SESSION time_zone = \'+00:00\'');
    await query('SET SESSION time_zone = \'+00:00\'', undefined, connection);
    const listObjects = () => query('SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [config.database]);
    const objects = await listObjects();
    const tables = objects.filter(o => o.TABLE_TYPE === 'BASE TABLE');
    const views = objects.filter(o => o.TABLE_TYPE === 'VIEW');
    if (tables.length + views.length !== objects.length) throw new Error('Unsupported database object type; backup stopped');
    if (tables.length) await query('LOCK TABLES ' + tables.map(t => `${db}.${identifier(t.TABLE_NAME)} READ`).join(', '), undefined, connection);
    const checkObjects = async () => {
      if (JSON.stringify(await listObjects()) !== JSON.stringify(objects)) {
        throw Object.assign(new Error('Database object list changed during backup'), { code: 'BACKUP_SCHEMA_CHANGED' });
      }
    };
    await checkObjects();
    const sourceMode = (await query('SELECT @@SESSION.sql_mode AS mode'))[0].mode;
    const dataMode = "SET SQL_MODE='NO_BACKSLASH_ESCAPES,NO_AUTO_VALUE_ON_ZERO';\n";
    const createDb = (await query(`SHOW CREATE DATABASE ${db}`))[0]['Create Database'];
    yield `-- SCMarket full database backup (mysql2)\nSET NAMES utf8mb4;\nSET @OLD_SQL_MODE=@@SQL_MODE;\nSET SQL_MODE='NO_BACKSLASH_ESCAPES,NO_AUTO_VALUE_ON_ZERO';\nSET @OLD_TIME_ZONE=@@TIME_ZONE;\nSET TIME_ZONE='+00:00';\nSET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS;\nSET FOREIGN_KEY_CHECKS=0;\n${createDb.replace(/^CREATE DATABASE /, 'CREATE DATABASE IF NOT EXISTS ')};\nUSE ${db};\n`;
    for (const table of tables) {
      const name = identifier(table.TABLE_NAME);
      const columns = await query('SELECT COLUMN_NAME, DATA_TYPE, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [config.database, table.TABLE_NAME]);
      if (columns.some(c => /^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/i.test(c.DATA_TYPE))) throw new Error('Spatial columns require a dedicated exporter; backup stopped');
      const writable = columns.filter(c => !/\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/i.test(c.EXTRA));
      const ddl = (await query(`SHOW CREATE TABLE ${db}.${name}`))[0]['Create Table'];
      yield `SET SQL_MODE=${literal(sourceMode)};\nDROP TABLE IF EXISTS ${name};\n${ddl};\n${dataMode}`;
      const selected = writable.length ? writable.map(c => identifier(c.COLUMN_NAME)).join(',') : '1';
      const rows = connection.query({ sql: `SELECT ${selected} FROM ${db}.${name}`, rowsAsArray: true,
        typeCast: (field) => {
          // Numeric strings prevent precision loss; all other bytes are preserved as hex literals.
          if (['TINY','SHORT','LONG','LONGLONG','INT24','DECIMAL','NEWDECIMAL','FLOAT','DOUBLE','YEAR'].includes(field.type)) return field.string();
          return field.buffer();
        } }).stream({ highWaterMark: 16 });
      if (signal) addAbortSignal(signal, rows);
      let batch = [], batchBytes = 0;
      for await (const row of rows) {
        signal?.throwIfAborted();
        const statement = writable.length ? `INSERT INTO ${name} (${selected}) VALUES (${row.map((value, index) => {
          const encoded = literal(value);
          return Buffer.isBuffer(value) && !/^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)$/i.test(writable[index].DATA_TYPE)
            ? `CONVERT(${encoded} USING utf8mb4)` : encoded;
        }).join(',')});\n` : `INSERT INTO ${name} () VALUES ();\n`;
        batch.push(statement);
        batchBytes += Buffer.byteLength(statement);
        if (batchBytes >= 64 * 1024) {
          yield batch.join('');
          batch = []; batchBytes = 0;
        }
      }
      if (batch.length) yield batch.join('');
    }
    // Temporary view stand-ins allow references to views that are defined later.
    for (const view of views) {
      const columns = await query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [config.database, view.TABLE_NAME]);
      yield `DROP VIEW IF EXISTS ${identifier(view.TABLE_NAME)};\nCREATE VIEW ${identifier(view.TABLE_NAME)} AS SELECT ${columns.map(c => '1 AS ' + identifier(c.COLUMN_NAME)).join(',')};\n`;
    }
    // mysql/mariadb clients limit delimiters to 15 characters.
    const delimiter = '$$' + crypto.randomBytes(6).toString('hex');
    const emitObject = (ddl, mode = '') => `SET SQL_MODE=${literal(mode)};\nDELIMITER ${delimiter}\n${ddl}${delimiter}\nDELIMITER ;\nSET SQL_MODE='NO_BACKSLASH_ESCAPES,NO_AUTO_VALUE_ON_ZERO';\n`;
    const routines = await query('SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_TYPE, ROUTINE_NAME', [config.database]);
    for (const routine of routines) {
      const type = routine.ROUTINE_TYPE;
      if (!['FUNCTION', 'PROCEDURE'].includes(type)) throw new Error('Unsupported routine');
      const name = identifier(routine.ROUTINE_NAME);
      const definition = (await query(`SHOW CREATE ${type} ${db}.${name}`))[0];
      const ddl = definition['Create ' + (type === 'FUNCTION' ? 'Function' : 'Procedure')];
      if (!ddl) throw new Error('Cannot read routine definition; check SHOW CREATE privileges');
      yield `DROP ${type} IF EXISTS ${name};\n` + emitObject(ddl, definition.sql_mode);
    }
    for (const view of views) {
      const ddl = (await query(`SHOW CREATE VIEW ${db}.${identifier(view.TABLE_NAME)}`))[0]['Create View'];
      yield `SET SQL_MODE=${literal(sourceMode)};\nDROP VIEW ${identifier(view.TABLE_NAME)};\n${ddl};\n${dataMode}`;
    }
    for (const [type, table, schema, field, createKey] of [
      ['TRIGGER','TRIGGERS','TRIGGER_SCHEMA','TRIGGER_NAME','SQL Original Statement'],
      ['EVENT','EVENTS','EVENT_SCHEMA','EVENT_NAME','Create Event'],
    ]) {
      const objects = await query(`SELECT ${field} AS name FROM information_schema.${table} WHERE ${schema}=?`, [config.database]);
      for (const object of objects) {
        const name = identifier(object.name);
        const definition = (await query(`SHOW CREATE ${type} ${db}.${name}`))[0];
        if (!definition[createKey]) throw new Error(`Cannot read ${type} definition`);
        yield `SET TIME_ZONE=${literal(definition.time_zone || '+00:00')};\nDROP ${type} IF EXISTS ${name};\n` + emitObject(definition[createKey], definition.sql_mode) + "SET TIME_ZONE='+00:00';\n";
      }
    }
    await checkObjects();
    yield 'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;\nSET TIME_ZONE=@OLD_TIME_ZONE;\nSET SQL_MODE=@OLD_SQL_MODE;\n';
  } catch (error) {
    if (signal?.aborted) throw new Error('Database dump aborted');
    const code = /^[A-Z0-9_]+$/.test(error.code || '') ? ` (${error.code})` : '';
    throw new Error(`Node database dump failed${code}; check database permissions, connection and supported objects`);
  } finally {
    // Closing the socket releases the table locks on success, failure and cancellation.
    signal?.removeEventListener('abort', abort);
    connection.destroy(); metadata.destroy();
  }
}
module.exports = { sqlDump, identifier, literal };
