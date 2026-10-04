const express = require('express');
const crypto = require('node:crypto');
const { runBackup, latestBackup } = require('../services/backup/job');

function backupRouter({ run = runBackup, latest = latestBackup, env = process.env } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = env.BACKUP_API_TOKEN;
    if (!token || token.length < 32) return res.status(503).json({ success: false, message: 'Backup API is not configured' });
    const supplied = req.get('authorization') || '';
    const actual = crypto.createHash('sha256').update(supplied).digest();
    const expected = crypto.createHash('sha256').update(`Bearer ${token}`).digest();
    if (!crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ success: false, message: 'Unauthorized' });
    next();
  });
  const trigger = async (req, res) => {
    // Do not allow database names, destination folders, shell options, or tokens in the URL.
    if (Object.keys(req.query).length) return res.status(400).json({ success: false, message: 'Query parameters are not supported; use Authorization header' });
    req.setTimeout(0); res.setTimeout(0);
    try { const result = await run(); res.status(200).json({ success: true, ...result }); }
    catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
  };
  router.head('/database', (req, res) => res.sendStatus(405));
  router.get('/database', trigger);
  router.post('/database', trigger);
  router.get('/status', async (req, res) => {
    try { res.json({ success: true, ...(await latest()) }); }
    catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
  });
  return router;
}
module.exports = { backupRouter };
