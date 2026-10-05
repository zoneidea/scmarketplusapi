const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { createArchive, decryptArchive } = require('../src/services/backup/archive');
const { sqlDump, identifier, literal } = require('../src/services/backup/sql-dump');

test('SQL encodes identifiers, binary, null and large numbers without loss', () => {
  assert.equal(identifier('a`b'), '`a``b`');
  assert.equal(literal(Buffer.from([0,39,92,255])), "X'00275cff'");
  assert.equal(literal(null), 'NULL');
  assert.equal(literal('18446744073709551615'), "'18446744073709551615'");
});

test('native dump restores tables, exact values, generated columns, views and stored objects', {
  skip: !process.env.BACKUP_INTEGRATION_MYSQL,
}, async () => {
  const name = 'scbackup_test_' + crypto.randomBytes(6).toString('hex');
  assert.match(name, /^scbackup_test_[a-f0-9]+$/);
  const connection = await mysql.createConnection({host:'127.0.0.1',user:'root',password:''});
  const user = 'scb_' + crypto.randomBytes(6).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'scbackup-native-'));
  try {
    await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
    await connection.query(`USE \`${name}\``);
    await connection.query("CREATE USER ?@'localhost' IDENTIFIED BY ?", [user,password]);
    await connection.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO ?@'localhost'`, [user]);
    await connection.changeUser({user,password,database:name});
    const [grants] = await connection.query('SHOW GRANTS');
    assert.ok(!JSON.stringify(grants).includes('RELOAD'));
    await connection.query('CREATE TABLE data (id BIGINT UNSIGNED PRIMARY KEY, amount DECIMAL(30,10), txt LONGTEXT, rawdata BLOB, dt DATETIME, stamp TIMESTAMP NULL, bits BIT(12), n INT, generated INT AS (n+1) STORED) ENGINE=InnoDB');
    await connection.query("CREATE TABLE latin_text (txt VARCHAR(100) CHARACTER SET latin1 DEFAULT 'a\\\\b')");
    await connection.query("INSERT INTO latin_text VALUES ('café')");
    await connection.query('CREATE TABLE audit (id INT) ENGINE=MyISAM');
    await connection.query('INSERT INTO data(id,amount,txt,rawdata,dt,stamp,bits,n) VALUES (?,?,?,?,?,?,?,?)',
      ['18446744073709551615','12345678901234567890.1234567890',"ไทย 😀 '\\\n\u0000",Buffer.from([0,255,39,92]),'2026-10-05 01:02:03','2026-10-05 01:02:03',Buffer.from([10,255]),4]);
    await connection.query('INSERT INTO audit VALUES (1),(2)');
    await connection.query('CREATE VIEW z_view AS SELECT id,txt FROM data');
    await connection.query('CREATE VIEW a_view AS SELECT * FROM z_view');
    await connection.query('CREATE PROCEDURE sample_proc() BEGIN SELECT 1; SELECT 2; END');
    await connection.query('CREATE FUNCTION sample_func() RETURNS INT DETERMINISTIC RETURN 7');
    await connection.query('CREATE TRIGGER sample_trigger AFTER INSERT ON audit FOR EACH ROW SET @backup_test_seen=NEW.id');
    await connection.query('CREATE EVENT sample_event ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1');
    const select = 'SELECT CAST(id AS CHAR) id,CAST(amount AS CHAR) amount,HEX(txt) txt,HEX(rawdata) rawdata,CAST(dt AS CHAR) dt,UNIX_TIMESTAMP(stamp) stamp,HEX(bits) bits,n,generated FROM data';
    const [before] = await connection.query(select);
    const cfg={database:name,mysql:{host:'127.0.0.1',user,password,database:name},key:crypto.randomBytes(32)};
    const control = new AbortController();
    const abortedDump = sqlDump(cfg, control.signal);
    await abortedDump.next(); // The generator holds table read locks at this point.
    control.abort();
    await assert.rejects(abortedDump.next(), /aborted/);
    await connection.query('SET SESSION lock_wait_timeout=2');
    await connection.query('INSERT INTO audit VALUES (3)');
    await connection.query('DELETE FROM audit WHERE id=3');
    const changingDump = sqlDump(cfg, new AbortController().signal);
    await changingDump.next();
    await connection.query('CREATE TABLE added_during_backup (id INT)');
    await assert.rejects(async () => { for await (const chunk of changingDump) { void chunk; } }, /BACKUP_SCHEMA_CHANGED/);
    await connection.query('DROP TABLE added_during_backup');
    const artifact=await createArchive(cfg,dir,new AbortController().signal);
    const gz=path.join(dir,'restore.gz'); await decryptArchive(artifact.path,gz,cfg.key);
    const sql=zlib.gunzipSync(await fs.readFile(gz));
    await connection.query(`DROP DATABASE \`${name}\``);
    await new Promise((resolve,reject)=>{
      const child=spawn(process.env.BACKUP_INTEGRATION_MYSQL,['--host=127.0.0.1','--user=root','--default-character-set=utf8mb4'],{stdio:['pipe','ignore','pipe']});
      let error=''; child.stderr.on('data',chunk=>error+=chunk); child.on('error',reject);
      child.on('close',code=>code===0?resolve():reject(new Error(error))); child.stdin.end(sql);
    });
    await connection.query(`USE \`${name}\``);
    const [after]=await connection.query(select); assert.deepEqual(after,before);
    const [rows]=await connection.query('SELECT * FROM audit'); assert.equal(rows.length,2);
    const [latin]=await connection.query('SELECT txt FROM latin_text'); assert.equal(latin[0].txt,'café');
    const [views]=await connection.query('SELECT * FROM a_view'); assert.equal(views.length,1);
    const [functions]=await connection.query('SELECT sample_func() AS v'); assert.equal(functions[0].v,7);
    await connection.query('CALL sample_proc()');
    await connection.query('INSERT INTO audit VALUES (9)');
    const [trigger]=await connection.query('SELECT @backup_test_seen AS v'); assert.equal(trigger[0].v,9);
    const [events]=await connection.query('SHOW EVENTS'); assert.equal(events.length,1); assert.equal(events[0].Status,'DISABLED');
  } finally {
    const cleanup = await mysql.createConnection({host:'127.0.0.1',user:'root',password:''});
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await cleanup.query("DROP USER IF EXISTS ?@'localhost'", [user]);
    } finally {
      await cleanup.end();
      await connection.end(); await fs.rm(dir,{recursive:true,force:true});
    }
  }
});
