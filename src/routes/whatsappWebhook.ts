import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const RANK: Record<string, number> = { Queued: 0, Sending: 1, Sent: 2, Delivered: 3, Read: 4, Failed: 5 };
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** Port of api/whatsapp_webhook.php — Meta verification handshake + signed delivery/inbound events. */
export async function registerWhatsAppWebhook(app: FastifyInstance) {
  const { db, crypto } = app.services;

  // The HMAC is computed over the exact raw bytes, so this scope keeps the body as a Buffer.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const verify = async (req: any, reply: any) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q.hub_mode ?? q['hub.mode'] ?? '';
    const token = q.hub_verify_token ?? q['hub.verify_token'] ?? '';
    const challenge = q.hub_challenge ?? q['hub.challenge'] ?? '';
    let matched = false;
    try {
      const rows = await db.query<{ webhook_verify_token: string }>('SELECT webhook_verify_token FROM whatsapp_accounts WHERE webhook_verify_token IS NOT NULL');
      matched = rows.some((r) => safeEq(r.webhook_verify_token, token));
    } catch { /* table missing → not matched */ }
    if (mode === 'subscribe' && matched && challenge !== '') return reply.status(200).type('text/plain').send(challenge);
    return reply.status(403).send();
  };

  const receive = async (req: any, reply: any) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
    const signature = String(req.headers['x-hub-signature-256'] ?? '');
    let verified = false;
    try {
      const rows = await db.query<{ app_secret_encrypted: string }>('SELECT app_secret_encrypted FROM whatsapp_accounts WHERE app_secret_encrypted IS NOT NULL');
      for (const row of rows) {
        let secret: string;
        try { secret = crypto.decrypt(row.app_secret_encrypted); } catch { continue; } // one unreadable secret must not block the others
        if (safeEq(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`, signature)) { verified = true; break; }
      }
    } catch { /* table missing → unverified */ }
    if (!verified) return reply.status(403).send();

    let event: any;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { event = null; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return reply.status(400).send();

    try {
      for (const entry of arr(event.entry)) {
        for (const change of arr(entry?.changes)) {
          for (const st of arr(change?.value?.statuses)) {
            const id = st?.id, meta = st?.status;
            if (!id || !meta) continue;
            const next = ucfirst(String(meta));
            if (!(next in RANK)) continue;
            try {
              const row = (await db.query<{ id: number; status: string }>('SELECT id, status FROM whatsapp_outbound_queue WHERE provider_message_id = ?', [id]))[0];
              if (row && RANK[next]! > (RANK[row.status] ?? -1)) await db.execute('UPDATE whatsapp_outbound_queue SET status = ? WHERE id = ?', [next, row.id]);
            } catch { /* table missing */ }
            try { await db.execute('UPDATE notification_logs SET status = ? WHERE provider_message_id = ?', [next, id]); } catch { /* enum has no Delivered/Read on older schemas */ }
          }
          for (const m of arr(change?.value?.messages)) {
            const from = m?.from, id = m?.id;
            const text = m?.text?.body ?? `[${m?.type ?? 'media'} message]`;
            if (!from || !id) continue;
            try {
              if ((await db.query('SELECT id FROM notification_logs WHERE provider_message_id = ? AND direction = \'Inbound\'', [id])).length > 0) continue;
              const normalized = String(from).replace(/\D/g, '').slice(-10);
              const c = (await db.query<{ id: number }>("SELECT id FROM customers WHERE RIGHT(REGEXP_REPLACE(mobile, '[^0-9]', ''), 10) = ? LIMIT 1", [normalized]))[0];
              await db.execute(
                "INSERT INTO notification_logs (customer_id, channel, recipient, message, status, direction, provider, provider_message_id) VALUES (?, 'WhatsApp', ?, ?, 'Sent', 'Inbound', 'meta', ?)",
                [c ? Number(c.id) : null, from, text, id]);
            } catch { /* columns missing */ }
          }
        }
      }
    } catch (e) {
      req.log.error(`WhatsApp webhook status processing error: ${(e as Error).message}`);
    }
    return reply.status(200).send();
  };

  for (const url of ['/api/whatsapp_webhook', '/api/whatsapp_webhook.php']) {
    app.get(url, verify);
    app.post(url, receive);
  }
}
