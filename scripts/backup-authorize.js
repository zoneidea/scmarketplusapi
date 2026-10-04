// Run on the operator's computer. The token file must be copied securely to the API host.
require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const axios = require('axios');

async function main() {
  const clientFile = path.resolve(process.env.BACKUP_DRIVE_CLIENT_FILE || '.backup-secrets/drive-client.json');
  const tokenFile = path.resolve(process.env.BACKUP_DRIVE_TOKEN_FILE || '.backup-secrets/drive-token.json');
  const document = JSON.parse(await fs.readFile(clientFile, 'utf8'));
  const client = document.installed || document.web;
  if (!client?.client_id || !client.client_secret) throw new Error('Invalid OAuth client JSON');
  const redirect = 'http://127.0.0.1:53682/oauth/callback';
  const state = crypto.randomBytes(32).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let busy = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirect);
    if (url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state) {
      res.writeHead(400); res.end('Invalid OAuth callback'); return;
    }
    if (busy) { res.writeHead(409); res.end('Authorization is already processing'); return; }
    busy = true;
    try {
      const code = url.searchParams.get('code');
      if (!code) throw new Error('Authorization was not granted');
      const response = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
        client_id: client.client_id, client_secret: client.client_secret, code,
        code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect,
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
      if (!response.data.refresh_token) throw new Error('No refresh token returned; grant consent again');
      await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(tokenFile, JSON.stringify({ refresh_token: response.data.refresh_token }), { mode: 0o600 });
      await fs.chmod(tokenFile, 0o600);
      res.end('Google Drive connected. You may close this window.');
      console.log('Drive connected. Refresh token saved to the configured token file (not printed).');
    } catch {
      res.writeHead(500); res.end('Authorization failed. Restart the authorization command and try again.');
      console.error('Drive authorization failed. Check OAuth configuration and consent.');
      process.exitCode = 1;
    } finally { clearTimeout(timer); server.close(); }
  });
  const timer = setTimeout(() => { console.error('Authorization timed out'); server.close(); process.exitCode = 1; }, 10 * 60 * 1000);
  server.once('error', () => { clearTimeout(timer); console.error('Cannot listen on 127.0.0.1:53682'); process.exitCode = 1; });
  server.listen(53682, '127.0.0.1', () => {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect,
      response_type: 'code', scope: 'https://www.googleapis.com/auth/drive',
      access_type: 'offline', prompt: 'consent', state,
      code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    console.log('Open this URL on the same computer and sign in as the owner/editor of the backup folder:\n' + url.href);
  });
}
main().catch(() => { console.error('Cannot load OAuth client file. See docs/database-backup.md'); process.exitCode = 1; });
