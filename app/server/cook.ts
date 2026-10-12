// The Cook tab's server side: the sous-chef chat (POST /api/cook/ask,
// passcode, streamed) and the scaled, sectioned recipe view behind
// GET /api/recipes/entry (cookEntry, called from routes.ts).
import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type express from 'express';
import { marked } from 'marked';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { allowHit, clientIp, requirePasscode } from './auth.ts';
import { parseRecipe, SAFE_FILE, type RecipeMeta } from './parse.ts';
import { recipesDir, repoRoot } from './paths.ts';
import { frontmatterNumber, scaledSections, type RecipeScale, type SectionInsert } from './recipe-sections.ts';
import { modelFor } from './store.ts';

// --- recipe view (GET /api/recipes/entry) ---
// `{ meta, html }` is what the Recipes tab has always read. The Cook tab adds
// `sections` (scaled ingredient texts, prep, steps, notes HTML) and `scale`.
// `?servings=N` (whole number 1–24) scales the Ingredients deterministically
// (scale.ts); without it nothing scales. Prep and Steps are never scaled —
// recipes refer to ingredients by name there (recipes/README.md).

export const COOK_SERVINGS_MIN = 1;
export const COOK_SERVINGS_MAX = 24;

/** Parse `?servings=`: undefined → null (as written); invalid → NaN. */
export function parseServings(v: unknown): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= COOK_SERVINGS_MIN && n <= COOK_SERVINGS_MAX ? n : NaN;
}

export interface CookEntry {
  meta: RecipeMeta & { prep_min?: number };
  html: string;
  sections: {
    ingredients: string[]; prep: string[]; steps: string[]; notesHtml: string;
    inserts: Record<'ingredients' | 'prep' | 'steps', SectionInsert[]>;
  };
  scale: RecipeScale;
}

export function cookEntry(raw: string, file: string, servings: number | null): CookEntry {
  const { meta, body } = parseRecipe(raw, file);
  // prep_min arrives with the prep-first migration; read it here until
  // RecipeMeta carries it.
  const known = (meta as RecipeMeta & { prep_min?: number }).prep_min;
  const prepMin = known ?? frontmatterNumber(raw, 'prep_min');
  const s = scaledSections(body, meta.servings, servings);
  return {
    meta: prepMin === undefined ? meta : { ...meta, prep_min: prepMin },
    html: String(marked.parse(s.body)), // the scaled body when scaling; as written otherwise
    sections: {
      ingredients: s.sections.ingredients,
      prep: s.sections.prep,
      steps: s.sections.steps,
      notesHtml: s.sections.notesMd ? String(marked.parse(s.sections.notesMd)) : '',
      inserts: s.sections.inserts,
    },
    scale: s.scale,
  };
}

// --- cook chat (passcode; streams plain text) ---
// The Cook tab's sous-chef: kitchen Q&A about the recipe being cooked.
// Deliberately NOT a run — read-only, never touches git, and allowed while a
// run is active (a fold shouldn't block "can I sub shallots?"). Answers on the
// cook model (sonnet) with the recipe, preferences, and pantry embedded, so
// most questions need zero tool calls.

const COOK_PER_MIN = 10;
const COOK_SYSTEM = `You are the sous-chef inside the Meal Planner app. Someone in the household is at the stove, phone propped up, asking mid-cook. Household size and the usual serving count are in the preferences (provided); recipes are written at 4 servings.
- Lead with the answer, then only what changes their next move. Short paragraphs or tight bullets. No headers, no tables, no restating the recipe.
- Substitutions and technique: be decisive — best option first with amounts, temps, and times; at most one fallback.
- Respect the household's preferences, allergies, and hard-nos (provided) without being asked. Prefer suggesting what the pantry (provided) already holds.
- The recipe, preferences, and pantry are in the prompt. For anything else in the repo (past plans, other recipes) you may Read/Grep/Glob, but you can never write or run commands.
- Plain text only — no markdown syntax at all (no **bold**, no #headers, no tables). Bullets as plain "- " lines are fine. Answers should almost always fit on a phone screen without scrolling.`;

let cookActive = 0;

/**
 * The sous-chef's prompt. The Cook tab sends the servings it is showing; at a
 * factor ≠ 1 the recipe still goes in exactly as written, and the scaled
 * ingredient list the cook is looking at rides alongside as its own block.
 * (Swapping the scaled lines into the recipe — frontmatter still saying 4 —
 * got them multiplied a second time: "the written 6 tbsp doubled" → 12.)
 */
export function cookPrompt(p: { file: string; recipe: string; prefs: string; pantry: string; convo: string; servings: number | null }): string {
  let scaling = '';
  if (p.servings !== null && !Number.isNaN(p.servings)) {
    const { meta } = parseRecipe(p.recipe, p.file);
    const { scale, sections } = scaledSections(p.recipe, meta.servings, p.servings);
    if (scale.factor !== 1) {
      const list = sections.ingredients.map((t) => `- ${t}`).join('\n');
      scaling = `\n\n<scaled-ingredients servings="${scale.servings}" factor="${scale.factorText}">\n${list}\n</scaled-ingredients>\n\n`
        + `<scaling>The cook is making this at ${scale.servings} servings: ×${scale.factorText} the ${scale.baseServings} the recipe above is written for. `
        + `The scaled-ingredients block is exactly what their screen shows, already multiplied: quote those amounts as they are and never multiply them again. `
        + `Everything inside the recipe itself (its Ingredients, Prep and Steps) is as written for ${scale.baseServings}; multiply an amount from there by ${scale.factorText} when you cite it. `
        + `Mind pan size, batches and timing at this volume.</scaling>`;
    }
  }
  return `<recipe file="${p.file}">\n${p.recipe}\n</recipe>${scaling}\n\n<preferences>\n${p.prefs}\n</preferences>\n\n<pantry>\n${p.pantry}\n</pantry>\n\nConversation so far (answer the cook's last message):\n\n${p.convo}`;
}

function cookCanUseTool() {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
    if (toolName === 'Grep' || toolName === 'Glob') return allow;
    if (toolName === 'Read') {
      const p = path.resolve(repoRoot, String(input.file_path ?? ''));
      if (p === repoRoot || p.startsWith(repoRoot + path.sep)) return allow;
      return { behavior: 'deny', message: 'Cook chat can only read inside the meal-planner repo.' };
    }
    return { behavior: 'deny', message: 'Cook chat is read-only — answer from the provided context.' };
  };
}

export function registerCookRoutes(app: express.Express) {
  app.post('/api/cook/ask', requirePasscode, async (req, res) => {
    const file = String(req.body?.file ?? '');
    if (!SAFE_FILE.test(file)) return res.status(400).json({ error: 'bad filename' });
    const rawMsgs: unknown[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!rawMsgs.length || rawMsgs.length > 40) return res.status(400).json({ error: 'bad conversation' });
    const messages = rawMsgs.map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      return { role: o.role === 'assistant' ? 'assistant' : 'user', text: String(o.text ?? '').slice(0, 4000) };
    });
    const last = messages[messages.length - 1]!;
    if (last.role !== 'user' || !last.text.trim()) return res.status(400).json({ error: 'Ask something first.' });
    const ip = clientIp(req);
    if (!allowHit('cook', ip, COOK_PER_MIN)) return res.status(429).json({ error: `Easy there — ${COOK_PER_MIN} questions per minute, tops.` });
    if (cookActive >= 2) return res.status(409).json({ error: 'The sous-chef is mid-answer — give it a second.' });

    let recipe = '';
    try { recipe = await fs.readFile(path.join(recipesDir, file), 'utf8'); }
    catch { return res.status(404).json({ error: 'That recipe file doesn’t exist yet.' }); }
    const readOpt = async (p: string) => { try { return await fs.readFile(p, 'utf8'); } catch { return '(missing)'; } };
    const prefs = await readOpt(path.join(repoRoot, 'profile', 'preferences.md'));
    const pantry = await readOpt(path.join(repoRoot, 'profile', 'pantry.md'));

    const convo = messages.map((m) => `${m.role === 'user' ? 'Cook' : 'Sous-chef'}: ${m.text}`).join('\n\n');
    const prompt = cookPrompt({ file, recipe, prefs, pantry, convo, servings: parseServings(req.body?.servings) });

    cookActive++;
    const abort = new AbortController();
    let finished = false;
    let wrote = false;
    res.on('close', () => { if (!finished) abort.abort(); });

    const options: Options = {
      cwd: repoRoot,
      abortController: abort,
      // Grep/Glob as rules for the same control-channel reason as RUN_ALLOWED_TOOLS;
      // Read stays behind canUseTool for its inside-the-repo path check.
      allowedTools: ['Grep', 'Glob'],
      canUseTool: cookCanUseTool(),
      systemPrompt: COOK_SYSTEM,
      maxTurns: 8,
      ...modelFor('cook'),
      includePartialMessages: true,
    };

    try {
      let finalText = '';
      let failed: string | null = null;
      const q = query({ prompt, options });
      for await (const msg of q) {
        if (msg.type === 'stream_event' && msg.parent_tool_use_id === null) {
          const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
          if (ev.type === 'message_start' && wrote) res.write('\n\n');
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            if (!wrote) {
              res.status(200).set({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
              wrote = true;
            }
            res.write(ev.delta.text);
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success' && !msg.is_error) finalText = msg.result;
          else if (msg.subtype !== 'success') failed = `Claude run failed (${msg.subtype}).`;
        }
      }
      finished = true;
      if (wrote) res.end();
      else if (finalText) res.status(200).set({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).send(finalText);
      else res.status(502).json({ error: failed ?? 'The sous-chef came up empty — ask again.' });
    } catch (err) {
      finished = true;
      const message = err instanceof Error ? err.message : String(err);
      if (wrote) { res.write('\n\n[connection to Claude dropped — ask again for the rest]'); res.end(); }
      else if (!abort.signal.aborted) {
        const friendly = /401|invalid.*credential|authenticat/i.test(message)
          ? 'Claude authentication failed. Run `claude` in a terminal on the Mac, complete /login once, then try again.'
          : `Claude error: ${message}`;
        res.status(502).json({ error: friendly });
      }
    } finally {
      finished = true;
      cookActive--;
    }
  });
}
