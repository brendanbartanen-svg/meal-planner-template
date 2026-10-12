// Routes for the Recipes tab's Ideas section (ideas.ts) and "Add a recipe"
// import (import.ts). Same trust model as routes.ts: GETs are open; idea
// decisions and photo/PDF uploads are open but rate-limited and attributed;
// anything that starts a run needs the passcode and refuses while another run
// is active.
//   GET  /api/ideas             batches from profile/ideas.md + decisions + which queued ones a plan carries
//   POST /api/ideas/:id         { status: 'queued' | 'dismissed' | null, note? }  (id = idea slug or imported recipe slug)
//   POST /api/runs/ideas        new batch of eight (plan model)
//   GET  /api/imports           recent import records (newest first)
//   POST /api/imports/upload    multipart `files` (1–3 images/PDFs) → an import record, no run yet
//   POST /api/runs/import       { source: { url } | { shareId } | { uploadId } } → fetch/resolve, then the import run
//   GET  /api/starter           the template's starter-recipes/ ({ available: false } when the folder is absent)
//   POST /api/starter/import    { files: string[] } → copy into recipes/ + commit (passcode; 409 while a run holds the lock)
import type express from 'express';
import { allowHit, CAPTURES_PER_MIN, clientIp, requirePasscode, whoFor } from './auth.ts';
import { IDEA_ID, loadIdeasState, readIdeas, resolveIdeaId, scheduledQueued, setIdeaState } from './ideas.ts';
import {
  ImportError, IMPORT_ID, initImports, listRecords, markRunning, publicRecord, readRecord, receiveUpload,
  recipeFiles, recordFromShare, recordFromUrl, sourceBlock, type ImportRecord,
} from './import.ts';
import { busyLabel, run, RunBusyError, startRun } from './runs.ts';
import { importStarter, listStarter, StarterError } from './starter.ts';
import { typicalMs } from './store.ts';

const UPLOADS_PER_MIN = 10;
const IMPORT_FETCHES_PER_MIN = 6;
const STARTER_PER_MIN = 30; // same budget as pantry edits

// routes.ts keeps its guardNoRun private; same check, same message.
function guardNoRun(res: express.Response): boolean {
  if (run) { const busy = busyLabel(run); res.status(409).json({ error: `Claude is busy: ${busy}`, busy }); return false; }
  return true;
}

const errStatus = (e: unknown) => (e instanceof ImportError ? e.status : 500);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerRecipesRoutes(app: express.Express) {
  initImports();

  // ---------- ideas ----------

  app.get('/api/ideas', async (_req, res) => {
    try {
      const [{ exists, batches }, state] = await Promise.all([readIdeas(), loadIdeasState()]);
      res.json({ exists, batches, state, scheduled: await scheduledQueued(state), typicalMs: typicalMs('ideas') });
    } catch (err) { res.status(500).json({ error: errMsg(err) }); }
  });

  app.post('/api/ideas/:id', async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!IDEA_ID.test(id)) return res.status(400).json({ error: 'bad id' });
    if (!allowHit('ideas', clientIp(req), CAPTURES_PER_MIN)) return res.status(429).json({ error: `Easy there — ${CAPTURES_PER_MIN} updates per minute, tops.` });
    const status = req.body?.status ?? null;
    if (status !== null && status !== 'queued' && status !== 'dismissed') return res.status(400).json({ error: 'status must be queued, dismissed, or null' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().replace(/\s+/g, ' ').slice(0, 300) : '';
    try {
      if (status === null) { // undo: clearing works even if the idea or recipe has since gone
        await setIdeaState(id, null);
        return res.json({ ok: true, id, entry: null });
      }
      const target = await resolveIdeaId(id);
      if (!target) return res.status(404).json({ error: 'No idea or recipe with that id.' });
      const by = await whoFor(req);
      const entry = await setIdeaState(id, {
        status,
        name: target.kind === 'idea' ? target.idea.name : target.name,
        ...(by ? { by } : {}),
        ...(note ? { note } : {}),
      });
      res.json({ ok: true, id, entry });
    } catch (err) { res.status(500).json({ error: errMsg(err) }); }
  });

  app.post('/api/runs/ideas', requirePasscode, (_req, res) => {
    if (!guardNoRun(res)) return;
    void startRun('ideas', '');
    res.json({ ok: true });
  });

  // ---------- starter library (template only) ----------

  app.get('/api/starter', async (_req, res) => {
    try { res.json(await listStarter()); } catch (err) { res.status(500).json({ error: errMsg(err) }); }
  });

  app.post('/api/starter/import', requirePasscode, async (req, res) => {
    if (!allowHit('starter', clientIp(req), STARTER_PER_MIN)) return res.status(429).json({ error: `Easy there — ${STARTER_PER_MIN} imports per minute, tops.` });
    if (!guardNoRun(res)) return;
    const files = req.body?.files;
    if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) return res.status(400).json({ error: '`files` must be a list of file names' });
    try {
      const by = await whoFor(req);
      res.json({ ok: true, ...(await importStarter(files, by)) });
    } catch (err) {
      if (err instanceof RunBusyError) return void res.status(409).json({ error: `Claude is busy: ${err.busy}`, busy: err.busy });
      if (err instanceof StarterError) return void res.status(err.status).json({ error: err.message });
      console.log(`[mealapp] starter import failed: ${errMsg(err)}`);
      res.status(500).json({ error: `Couldn’t import: ${errMsg(err)}` });
    }
  });

  // ---------- import ----------

  app.get('/api/imports', async (_req, res) => {
    try { res.json({ imports: (await listRecords()).map(publicRecord), typicalMs: typicalMs('import') }); }
    catch (err) { res.status(500).json({ error: errMsg(err) }); }
  });

  app.post('/api/imports/upload', async (req, res) => {
    if (!allowHit('import-upload', clientIp(req), UPLOADS_PER_MIN)) return res.status(429).json({ error: 'Too many uploads; try again in a minute.' });
    try {
      const rec = await receiveUpload(req, await whoFor(req));
      res.json({ ok: true, import: publicRecord(rec) });
    } catch (err) {
      if (errStatus(err) === 500) console.error('[import] upload failed:', err);
      res.status(errStatus(err)).json({ error: errMsg(err) });
    }
  });

  app.post('/api/runs/import', requirePasscode, async (req, res) => {
    if (!guardNoRun(res)) return;
    const src = (req.body?.source ?? {}) as { url?: unknown; shareId?: unknown; uploadId?: unknown };
    let rec: ImportRecord | null = null;
    try {
      if (typeof src.url === 'string' && src.url.trim()) {
        if (!allowHit('import-fetch', clientIp(req), IMPORT_FETCHES_PER_MIN)) return res.status(429).json({ error: 'Too many page fetches; try again in a minute.' });
        rec = await recordFromUrl(src.url.trim(), await whoFor(req));
      } else if (typeof src.shareId === 'string' && src.shareId) {
        rec = await recordFromShare(src.shareId, await whoFor(req));
      } else if (typeof src.uploadId === 'string' && IMPORT_ID.test(src.uploadId)) {
        rec = await readRecord(src.uploadId);
        if (!rec || rec.kind !== 'upload') return res.status(404).json({ error: 'That upload is gone; pick the file again.' });
      } else {
        return res.status(400).json({ error: 'Give a link, a shared item, or an uploaded file to import.' });
      }
    } catch (err) {
      if (errStatus(err) === 500) console.error('[import] prepare failed:', err);
      return res.status(errStatus(err)).json({ error: errMsg(err) });
    }
    const block = await sourceBlock(rec);
    const before = await recipeFiles();
    // re-check after the fetch/awaits; markRunning + startRun take the lock in this same tick
    if (!guardNoRun(res)) return;
    markRunning(rec, before);
    void startRun('import', '', block);
    res.json({ ok: true, import: publicRecord(rec) });
  });
}
