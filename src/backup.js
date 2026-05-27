import {
  mkdirSync, readdirSync, readFileSync,
  writeFileSync, unlinkSync, statSync,
} from 'fs';
import { join, resolve } from 'path';
import { Router } from 'express';

export const backupRouter = Router();

const DATA_DIR   = resolve(process.env.DATA_DIR || './data');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const MAX_KEEP   = 20;

const ensureDir = () => mkdirSync(BACKUP_DIR, { recursive: true });

const listFiles = () => {
  ensureDir();
  return readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
};

const prune = () => {
  for (const f of listFiles().slice(MAX_KEEP)) {
    try { unlinkSync(join(BACKUP_DIR, f)); } catch { /* ignore */ }
  }
};

const safeFilename = f =>
  /^backup-[\d\-T]+\.json$/.test(f);

backupRouter.post('/', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'payload non valido' });
  }
  try {
    ensureDir();
    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `backup-${ts}.json`;
    const filepath = join(BACKUP_DIR, filename);
    writeFileSync(filepath, JSON.stringify(body));
    prune();
    res.json({ ok: true, filename, savedAt: new Date().toISOString(), count: listFiles().length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

backupRouter.get('/list', (_req, res) => {
  try {
    const backups = listFiles().map(f => {
      const fp = join(BACKUP_DIR, f);
      let size = 0;
      try { size = statSync(fp).size; } catch { /* ignore */ }
      const iso = f.replace('backup-', '').replace('.json', '')
        .replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4');
      return { filename: f, size, savedAt: iso,
        downloadUrl: `/api/backup/download/${encodeURIComponent(f)}` };
    });
    res.json({ ok: true, count: backups.length, backups });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

backupRouter.get('/latest', (_req, res) => {
  const files = listFiles();
  if (!files.length) return res.status(404).json({ ok: false, error: 'nessun backup trovato' });
  try {
    const data = readFileSync(join(BACKUP_DIR, files[0]), 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${files[0]}"`);
    res.send(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

backupRouter.get('/download/:filename', (req, res) => {
  const { filename } = req.params;
  if (!safeFilename(filename)) {
    return res.status(400).json({ ok: false, error: 'filename non valido' });
  }
  try {
    const data = readFileSync(join(BACKUP_DIR, filename), 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(data);
  } catch {
    res.status(404).json({ ok: false, error: 'file non trovato' });
  }
});
