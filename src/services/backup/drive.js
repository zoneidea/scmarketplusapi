const fs = require('node:fs/promises');
const axios = require('axios');
const { setTimeout: delay } = require('node:timers/promises');

const API = 'https://www.googleapis.com/drive/v3';
const FIELDS = 'id,name,size,md5Checksum,appProperties,webViewLink';
const quote = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function readOAuth(clientFile, tokenFile) {
  try {
    const document = JSON.parse(await fs.readFile(clientFile, 'utf8'));
    const client = document.installed || document.web;
    const token = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
    if (!client?.client_id || !client.client_secret || !token.refresh_token) throw new Error();
    return { client, token };
  } catch { throw new Error('Configure Google Drive OAuth files; run npm run backup:authorize first'); }
}
class BackupDrive {
  constructor(config, signal, http = axios) {
    this.config = config; this.signal = signal; this.http = http;
    this.accessToken = null; this.expiresAt = 0;
  }
  async token() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const { client, token } = await readOAuth(this.config.oauthClientFile, this.config.oauthTokenFile);
    let response;
    try {
      response = await this.http.request({ method: 'POST', url: 'https://oauth2.googleapis.com/token',
        data: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret,
          refresh_token: token.refresh_token, grant_type: 'refresh_token' }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000,
        signal: this.signal, maxRedirects: 0, validateStatus: () => true });
    } catch { throw new Error('Google OAuth connection failed'); }
    if (response.status !== 200 || !response.data.access_token) throw new Error('Google OAuth authorization failed; reconnect the Drive account');
    this.accessToken = response.data.access_token;
    this.expiresAt = Date.now() + Math.max(0, Number(response.data.expires_in || 3600) - 60) * 1000;
    return this.accessToken;
  }
  async request(options) {
    let response;
    try {
      response = await this.http.request({ ...options,
        headers: { ...options.headers, Authorization: `Bearer ${await this.token()}` },
        timeout: 60000, signal: this.signal, maxRedirects: 0,
        maxBodyLength: Infinity, validateStatus: () => true });
    } catch { throw new Error('Google Drive network request failed'); }
    if (response.status === 401) this.expiresAt = 0;
    return response;
  }
  async json(options, retry = false) {
    for (let attempt = 0; attempt < (retry ? 3 : 1); attempt++) {
      let response;
      try { response = await this.request(options); } catch (error) {
        if (!retry || attempt === 2 || this.signal?.aborted) throw error;
      }
      if (response && response.status >= 200 && response.status < 300) return response.data;
      const status = response?.status;
      if (status && ![401, 429].includes(status) && status < 500) throw new Error(`Google Drive request failed (HTTP ${status}); check folder permissions and storage quota`);
      if (!retry || attempt === 2) throw new Error(`Google Drive request failed (HTTP ${status || 'network'})`);
      await delay(500 * 2 ** attempt, undefined, { signal: this.signal });
    }
  }
  async preflight() {
    const root = await this.json({ method: 'GET', url: `${API}/files/${this.config.folderId}`,
      params: { fields: 'id,mimeType,trashed,capabilities(canAddChildren)', supportsAllDrives: true } }, true);
    if (root.trashed || root.mimeType !== 'application/vnd.google-apps.folder' || !root.capabilities?.canAddChildren) {
      throw new Error('The OAuth user cannot upload to the configured Drive folder');
    }
  }
  async list(q, fields = FIELDS) {
    const files = []; let pageToken;
    do {
      const result = await this.json({ method: 'GET', url: `${API}/files`, params: {
        q, fields: `nextPageToken,files(${fields})`, pageSize: 100, pageToken,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      } }, true);
      files.push(...(result.files || [])); pageToken = result.nextPageToken;
    } while (pageToken);
    return files;
  }
  async monthFolder(month) {
    const q = `'${quote(this.config.folderId)}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder' and name='${quote(month)}'`;
    const folders = await this.list(q, 'id,name');
    if (folders.length > 1) throw new Error(`Multiple Drive folders named ${month}; resolve duplicates before backing up`);
    if (folders.length) return folders[0].id;
    const folder = await this.json({ method: 'POST', url: `${API}/files`, params: { fields: 'id', supportsAllDrives: true },
      data: { name: month, mimeType: 'application/vnd.google-apps.folder', parents: [this.config.folderId] } });
    return folder.id;
  }
  async findBackup(folder, backupKey) {
    const files = await this.list(`'${quote(folder)}' in parents and trashed=false and appProperties has { key='backupKey' and value='${quote(backupKey)}' }`);
    if (files.length > 1) throw new Error('Multiple backups found for this database and date; manual review required');
    return files[0] || null;
  }
  verify(file, expected) {
    const props = file.appProperties || {};
    if (!file.id || !file.md5Checksum || file.md5Checksum !== props.md5 || String(file.size) !== props.size ||
        !/^[a-f0-9]{64}$/.test(props.sha256 || '') ||
        (expected && (file.md5Checksum !== expected.md5 || String(file.size) !== String(expected.size)))) {
      throw new Error('Drive backup size/checksum verification failed');
    }
    return { fileId: file.id, fileName: file.name, size: Number(file.size), sha256: props.sha256,
      md5: file.md5Checksum, keyId: props.keyId, url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view` };
  }
  async upload(folder, name, artifact, backupKey, keyId) {
    const response = await this.request({ method: 'POST', url: 'https://www.googleapis.com/upload/drive/v3/files',
      params: { uploadType: 'resumable', supportsAllDrives: true, fields: FIELDS },
      headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(artifact.size) },
      data: { name, parents: [folder], appProperties: { backupKey, md5: artifact.md5,
        size: String(artifact.size), sha256: artifact.sha256, keyId } } });
    if (response.status !== 200 || !response.headers.location) throw new Error(`Cannot start Drive upload (HTTP ${response.status})`);
    const session = new URL(response.headers.location);
    if (session.protocol !== 'https:' || !(session.hostname === 'googleapis.com' || session.hostname.endsWith('.googleapis.com'))) throw new Error('Invalid Drive upload session URL');
    const handle = await fs.open(artifact.path, 'r');
    let offset = 0, failures = 0;
    try {
      while (offset < artifact.size) {
        this.signal?.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(8 * 1024 * 1024, artifact.size - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead !== chunk.length) throw new Error('Backup archive changed during upload');
        let result;
        try {
          result = await this.request({ method: 'PUT', url: session.href,
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.length),
              'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/${artifact.size}` }, data: chunk });
        } catch { result = null; }
        if (result?.status === 200 || result?.status === 201) return await this.verifyUploaded(result.data.id, artifact);
        if (result?.status === 308) {
          const next = this.offset(result.headers.range, artifact.size);
          if (next > offset) { offset = next; failures = 0; continue; }
        } else if (result && result.status !== 401 && result.status !== 429 && result.status < 500) {
          throw new Error(`Drive upload failed (HTTP ${result.status})`);
        }
        if (++failures > 5) throw new Error('Drive upload retry limit reached; call the backup API again');
        await delay(500 * 2 ** (failures - 1), undefined, { signal: this.signal });
        // A lost response does not imply lost bytes. Ask Drive where to resume.
        const probe = await this.request({ method: 'PUT', url: session.href, headers: {
          'Content-Length': '0', 'Content-Range': `bytes */${artifact.size}` }, data: Buffer.alloc(0) });
        if (probe.status === 200 || probe.status === 201) return await this.verifyUploaded(probe.data.id, artifact);
        if (probe.status === 308) offset = this.offset(probe.headers.range, artifact.size);
        else if (probe.status === 404) throw new Error('Drive upload session expired; call the backup API again');
      }
      throw new Error('Drive has not confirmed upload completion');
    } finally { await handle.close(); }
  }
  offset(range, size) {
    if (!range) return 0;
    const match = /^bytes=0-(\d+)$/.exec(range);
    const offset = match ? Number(match[1]) + 1 : NaN;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error('Invalid Drive upload offset');
    return offset;
  }
  async verifyUploaded(id, artifact) {
    if (!id) throw new Error('Drive did not return an uploaded file ID');
    const metadata = await this.json({ method: 'GET', url: `${API}/files/${encodeURIComponent(id)}`,
      params: { fields: FIELDS, supportsAllDrives: true } }, true);
    return this.verify(metadata, artifact);
  }
}
module.exports = { BackupDrive, readOAuth };
