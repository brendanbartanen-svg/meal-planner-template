// Ask Claude (POST /api/ask): the header chat on every tab. Unlike the
// sous-chef (cook.ts) it reads the whole repo AND may change it — recipes,
// pantry, preferences — committing like a run. So it holds the one-run lock
// while it answers (withRunLock in runs.ts): the strip shows it, Stop aborts
// it, and no run, auto-fold, or git pull can overlap. Same tool gate, project
// settings (CLAUDE.md binds) and plan-tier model as a run; streams plain text
// like the cook chat. The server keeps no chat state: the client sends the
// whole transcript each turn.
//
// Stream trailer, after a turn that changed files: the model's own final
// `Changed: a, b` line, or — if it forgot — the server's `[changed] a, b`
// built from the Edit/Write tool calls that succeeded; then a `[git] pushed |
// committed | uncommitted` line from the git commands that succeeded. The
// sheet (public/js/80-ask.js) renders both as chips.
//
// A dropped connection (phone locked mid-answer) does NOT abort: a turn that
// is editing files finishes and commits. Its full text is kept in memory as
// the last answer, keyed by the client's turn id, for GET /api/ask/last.
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type express from 'express';
import path from 'node:path';
import { allowHit, clientIp, requirePasscode } from './auth.ts';
import { broadcast } from './bus.ts';
import { repoRoot } from './paths.ts';
import {
  activityLabel, busyLabel, canUseTool, MOCK_RUNS, NO_GIT, RUN_ALLOWED_TOOLS, run, RunBusyError, withRunLock,
  type RunEvent,
} from './runs.ts';
import { modelFor } from './store.ts';
import { fmtISO, todayUTC, weekIdForDate } from './weeks.ts';

const ASK_PER_MIN = 10;
const ASK_MAX_MESSAGES = 40;
const ASK_MAX_CHARS = 6000;
const TURN_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MOCK_MS = Math.max(400, Number(process.env.MEALAPP_MOCK_MS) || 4000);

// MEALAPP_NO_GIT=1 (runs.ts) drops the git allow-rules and denies Bash in the
// shared gate; the ask's prompt says so too.
const GIT_LINE = NO_GIT
  ? '- Git is disabled on this instance: never run git. After changing files, say the change is saved but uncommitted.'
  : '- After changing files, commit with a descriptive message and push (pull --rebase and retry once if the push is rejected).';

export const ASK_APPEND = `

You are the household's planning assistant inside the Meal Planner app (a local web UI), answering in its Ask Claude chat. Someone in the household is typing on a phone. You have the whole repo: every recipe, profile/preferences.md, profile/pantry.md, every week's plan, and CLAUDE.md, whose rules bind here.
- Answer briefly, in plain prose: lead with the answer; short paragraphs or "- " bullets; no headers, no tables. Your text streams to the phone as you write it, so don't narrate tool use. Read what you need first, then answer.
- This is a conversation, and they can reply. When a request is ambiguous, ask one short clarifying question instead of guessing.
- When asked to change something, edit the files in house format: recipes keep their frontmatter and sections (recipes/README.md); the pantry keeps its sections and its one-item "- " lines; preference changes go in as dated entries under "Learned preferences". Keep plan files in their exact structure (plans/TEMPLATE.md), because the app parses them, and never rewrite past weeks except to fill in logs.
- When a turn creates a new file under recipes/, end the answer with the line \`Picture: run /recipe-images on the Mac (after the grocery list, if a lock is coming).\` (before the Changed: line). Never try to make the picture yourself.
${GIT_LINE}
- End any turn that changed files with a final line exactly \`Changed: <comma-separated repo-relative paths>\` (for example \`Changed: recipes/red-lentil-soup.md, profile/pantry.md\`). A turn that changed nothing has no such line.`;

export interface AskMessage { role: 'user' | 'assistant'; text: string }
export interface AskBody { messages: AskMessage[]; turn: string | null }

/** Validate POST /api/ask's body; a string is the 400 error. */
export function parseAskBody(body: unknown): AskBody | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.messages;
  if (!Array.isArray(raw) || !raw.length || raw.length > ASK_MAX_MESSAGES) {
    return `messages must be a list of 1–${ASK_MAX_MESSAGES} messages.`;
  }
  const messages: AskMessage[] = [];
  for (const m of raw) {
    const o = (m ?? {}) as Record<string, unknown>;
    if (o.role !== 'user' && o.role !== 'assistant') return 'Each message needs role "user" or "assistant".';
    if (typeof o.text !== 'string') return 'Each message needs text.';
    if (o.text.length > ASK_MAX_CHARS) return `Messages are capped at ${ASK_MAX_CHARS} characters.`;
    messages.push({ role: o.role, text: o.text });
  }
  const last = messages[messages.length - 1]!;
  if (last.role !== 'user' || !last.text.trim()) return 'Ask something first.';
  let turn: string | null = null;
  if (b.turn !== undefined && b.turn !== null) {
    if (typeof b.turn !== 'string' || !TURN_RE.test(b.turn)) return 'bad turn id';
    turn = b.turn;
  }
  return { messages, turn };
}

// ---------- last answer (recovery after a dropped stream) ----------
let activeTurn: string | null = null;
let lastAnswer: { turn: string; text: string; at: number } | null = null;

// ---------- changed-file tracking ----------
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Repo-relative path for a tool's file_path, or null when it is outside the repo. */
function repoRel(p: unknown): string | null {
  const abs = path.resolve(repoRoot, String(p ?? ''));
  if (!abs.startsWith(repoRoot + path.sep)) return null;
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new Error('aborted'));
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
  signal.addEventListener('abort', onAbort, { once: true });
});

function askPrompt(messages: AskMessage[]): string {
  const today = todayUTC();
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][today.getUTCDay()];
  const week = weekIdForDate(today);
  const convo = messages.map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text}`).join('\n\n');
  return `Today is ${fmtISO(today)} (${day}), in week ${week} (plans/${week}.md).\n\n`
    + `Conversation so far in the Ask Claude chat (answer the user's last message):\n\n${convo}`;
}

export function registerAskRoutes(app: express.Express) {
  app.post('/api/ask', requirePasscode, async (req, res) => {
    const body = parseAskBody(req.body);
    if (typeof body === 'string') return res.status(400).json({ error: body });
    // busy before the rate limit, so retries during a run don't burn it
    if (run) { const busy = busyLabel(run); return res.status(409).json({ error: `Claude is busy: ${busy}`, busy }); }
    if (!allowHit('ask', clientIp(req), ASK_PER_MIN)) {
      return res.status(429).json({ error: `Easy there — ${ASK_PER_MIN} questions per minute, tops.` });
    }

    const changed = new Set<string>();
    const question = body.messages[body.messages.length - 1]!.text.replace(/\s+/g, ' ').trim();
    let emptyError: string | null = null;
    try {
      emptyError = await withRunLock('ask', `“${clip(question, 70)}”`, (signal, pushEvent) => streamAsk(body, signal, pushEvent, res, changed));
    } catch (err) {
      if (err instanceof RunBusyError) {
        if (!res.headersSent) res.status(409).json({ error: err.message, busy: err.busy });
        return;
      }
      console.log(`[mealapp] ask failed: ${String(err)}`);
      emptyError = 'Ask Claude failed — try again.';
    }
    if (changed.size) broadcast({ type: 'state-updated' }); // tabs refetch (recipes, pantry, plans)
    // The lock is released (and run-state broadcast) before the response ends,
    // so the asking client never sees its own finished answer as "Claude is busy".
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) res.end();
    else res.status(502).json({ error: emptyError ?? 'Claude came up empty — ask again.' });
  });

  // The full text of the last answer, for a client whose stream dropped
  // (phone locked mid-answer, page reloaded). In memory only: one answer.
  app.get('/api/ask/last', requirePasscode, (req, res) => {
    const turn = String(req.query.turn ?? '');
    if (!TURN_RE.test(turn)) return res.status(400).json({ error: 'bad turn id' });
    if (activeTurn === turn && run?.type === 'ask') return res.json({ active: true });
    if (lastAnswer?.turn === turn) return res.json(lastAnswer);
    res.status(404).json({ error: 'No answer was recorded for that question (the app may have restarted).' });
  });
}

/**
 * One Ask Claude turn, inside the run lock. Never throws, never ends `res`
 * (the route does, after the lock is released). Returns the error for a 502
 * when nothing was streamed, else null.
 */
async function streamAsk(
  body: AskBody,
  signal: AbortSignal,
  pushEvent: (ev: RunEvent) => void,
  res: express.Response,
  changed: Set<string>,
): Promise<string | null> {
  activeTurn = body.turn;
  let acc = '';          // everything sent, so the recovery copy matches the stream
  let wrote = false;
  let needSep = false;   // a new assistant message started after text: blank line before its text
  let modelText = '';    // the model's own text, to look for its Changed: line
  const live = () => !res.destroyed && !res.writableEnded;
  const out = (s: string) => {
    acc += s;
    if (!live()) return;
    if (!wrote) {
      res.status(200).set({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      wrote = true;
    }
    res.write(s);
  };
  const say = (s: string) => {
    if (needSep && acc) { out('\n\n'); }
    needSep = false;
    modelText += s;
    out(s);
  };

  let committed = false;
  let pushed = false;
  let finalText = '';
  let failed: string | null = null;
  let stopped = false;

  try {
    if (MOCK_RUNS) {
      // Same lock, strip, Stop and trailer path; no Claude, no files, no git.
      const steps = ['Reading: profile/pantry.md', 'Reading: profile/preferences.md', 'Scanning files'];
      for (const s of steps) { pushEvent({ kind: 'activity', text: `mock · ${s}` }); await sleep(MOCK_MS / (steps.length + 2), signal); }
      const q = body.messages[body.messages.length - 1]!.text.trim();
      const words = `Mock answer (MEALAPP_MOCK_RUNS): nothing was read, written or committed.\n\nYou asked: “${clip(q, 200)}”\n\n- A real answer streams here, word by word.\n- Changes would end with a **Changed:** line.`.split(/(?<= )/);
      for (const w of words) { say(w); await sleep(Math.max(15, (MOCK_MS * 2) / 5 / words.length), signal); }
    } else {
      const ac = new AbortController();
      if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true });
      const options: Options = {
        cwd: repoRoot,
        abortController: ac,
        permissionMode: 'acceptEdits',
        // the run gate, as rules + backstop (see RUN_ALLOWED_TOOLS in runs.ts)
        allowedTools: RUN_ALLOWED_TOOLS,
        canUseTool: canUseTool(),
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: ASK_APPEND },
        maxTurns: 30,
        ...modelFor('plan'),
        includePartialMessages: true,
      };
      const pendingWrites = new Map<string, string>();               // tool_use_id → repo path
      const pendingGit = new Map<string, 'commit' | 'push'>();       // tool_use_id → git verb
      for await (const msg of query({ prompt: askPrompt(body.messages), options })) {
        if (msg.type === 'stream_event' && msg.parent_tool_use_id === null) {
          const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
          if (ev.type === 'message_start' && acc) needSep = true;
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) say(ev.delta.text);
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type !== 'tool_use') continue;
            const input = (block.input ?? {}) as Record<string, unknown>;
            if (msg.parent_tool_use_id === null) {
              const label = activityLabel(block.name, input);
              if (label) pushEvent({ kind: 'activity', text: label });
            }
            if (WRITE_TOOLS.has(block.name)) {
              const p = repoRel(input.file_path ?? input.notebook_path);
              if (p) pendingWrites.set(block.id, p);
            } else if (block.name === 'Bash') {
              const cmd = String(input.command ?? '');
              if (/^\s*git\s+commit\b/.test(cmd)) pendingGit.set(block.id, 'commit');
              else if (/^\s*git\s+push\b/.test(cmd)) pendingGit.set(block.id, 'push');
            }
          }
        } else if (msg.type === 'user') {
          // tool results: count a write / commit / push only once it succeeded
          const content = msg.message.content;
          if (!Array.isArray(content)) continue;
          for (const b of content) {
            if (typeof b !== 'object' || b === null || b.type !== 'tool_result') continue;
            if (b.is_error) continue;
            const p = pendingWrites.get(b.tool_use_id);
            if (p) changed.add(p);
            const g = pendingGit.get(b.tool_use_id);
            if (g === 'commit') committed = true;
            if (g === 'push') pushed = true;
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success' && !msg.is_error) finalText = msg.result;
          else if (msg.subtype !== 'success') failed = `Claude stopped early (${msg.subtype}).`;
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted) stopped = true;
    else if (/401|invalid.*credential|authenticat/i.test(message)) {
      failed = 'Claude authentication failed. Run `claude` in a terminal on the Mac, complete /login once, then try again.';
    } else failed = `Claude error: ${message}`;
  }

  // nothing streamed (no partial messages arrived): fall back to the result text
  if (!acc && finalText && !stopped) say(finalText);
  if (stopped) out(acc ? '\n\n(Stopped.)' : '(Stopped before an answer.)');
  else if (failed && (acc || changed.size)) out(`${acc ? '\n\n' : ''}(${failed})`); // else: a 502 below

  // trailer: the changed files, then what git did with them
  const modelLine = /^\s*[*_`]*Changed:/m.test(modelText);
  if (changed.size && !modelLine) out(`${acc ? '\n\n' : ''}[changed] ${[...changed].join(', ')}`);
  if (changed.size || modelLine) out(`\n[git] ${pushed ? 'pushed' : committed ? 'committed' : 'uncommitted'}`);

  if (body.turn) lastAnswer = { turn: body.turn, text: acc, at: Date.now() };
  activeTurn = null;
  return wrote ? null : (failed ?? 'Claude came up empty — ask again.');
}
