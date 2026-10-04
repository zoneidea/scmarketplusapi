require('dotenv').config({ quiet: true });
const { decryptArchive } = require('../src/services/backup/archive');
async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: npm run backup:decrypt -- input.sql.gz.enc output.sql.gz');
  const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || '', 'base64');
  await decryptArchive(source, destination, key);
  console.log('Archive authenticated and decrypted. Output is gzip-compressed SQL.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
