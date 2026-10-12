// Web Push HTTP routes (see push.README.md). Subscribing and per-type toggles
// are captures (open, rate-limited, attributed); removing a device needs the
// passcode (SPEC §9: deletes). Every route degrades to 503 when initPush
// failed at boot, so a broken vapid.json never takes the app down.
import type express from 'express';
import { allowHit, CAPTURES_PER_MIN, clientIp, requirePasscode, whoFor } from './auth.ts';
import * as push from './push.ts';

const OFF = { error: 'Push notifications are off on the server.' };
const TOO_MANY = { error: 'Too many requests. Try again in a minute.' };

function fail(res: express.Response, e: unknown) {
  res.status(e instanceof TypeError ? 400 : 500).json({ error: (e as Error).message });
}

export function registerPushRoutes(app: express.Express) {
  // The VAPID public key: the client's applicationServerKey.
  app.get('/api/push/key', (_req, res) => {
    if (!push.pushReady()) return res.status(503).json(OFF);
    res.json({ publicKey: push.publicKey() });
  });

  // Devices (no keys, no endpoint URL) + the per-type labels for the toggles.
  app.get('/api/push', (_req, res) => {
    res.json({
      ready: push.pushReady(),
      subscriptions: push.pushReady() ? push.listSubscriptions() : [],
      labels: push.PUSH_TYPE_LABELS,
    });
  });

  // body: { subscription: PushSubscription.toJSON(), label? }. Upserts by endpoint.
  app.post('/api/push/subscribe', async (req, res) => {
    if (!push.pushReady()) return res.status(503).json(OFF);
    if (!allowHit('push', clientIp(req), CAPTURES_PER_MIN)) return res.status(429).json(TOO_MANY);
    try {
      res.json(await push.addSubscription(req.body?.subscription, {
        label: req.body?.label, ua: req.get('user-agent'), by: await whoFor(req),
      }));
    } catch (e) { fail(res, e); }
  });

  // body: { types: { tonight: false, … } } — merged, strictly validated.
  app.put('/api/push/:id/types', async (req, res) => {
    if (!push.pushReady()) return res.status(503).json(OFF);
    if (!allowHit('push-types', clientIp(req), CAPTURES_PER_MIN)) return res.status(429).json(TOO_MANY);
    try {
      const s = await push.setTypes(String(req.params.id), req.body?.types);
      if (s) res.json(s); else res.status(404).json({ error: 'No such device.' });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/push/:id', requirePasscode, async (req, res) => {
    if (!push.pushReady()) return res.status(503).json(OFF);
    try { res.json({ ok: await push.removeSubscription(String(req.params.id)) }); } catch (e) { fail(res, e); }
  });
}
