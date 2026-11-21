import type { FastifyInstance } from 'fastify';

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/**
 * Port of api/whatsapp_webhook.php (Rahul: "kya gya kya reply aaya"). Meta calls this URL directly (no Bearer token): GET = the one-time
 * verification handshake against the generated `whatsapp_webhook_verify_token` setting; POST = signed events -- a customer's message
 * (text/media/reaction), WhatsApp call events, and delivery/read/failed status updates of messages WE sent. The X-Hub-Signature-256 check
 * is the only thing stopping anyone who finds the URL from injecting fake messages. A staff push goes out for every reply / call.
 */
export async function registerWhatsAppWebhook(app: FastifyInstance) {
  const { db, whatsapp, firebase } = app.services;

  // The HMAC is computed over the exact raw bytes, so this scope keeps the body as a Buffer.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const verify = async (req: any, reply: any) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q.hub_mode ?? q['hub.mode'] ?? '';
    const token = q.hub_verify_token ?? q['hub.verify_token'] ?? '';
    const challenge = q.hub_challenge ?? q['hub.challenge'] ?? '';
    if (mode === 'subscribe' && (await whatsapp.verifyWebhookToken(token))) return reply.status(200).type('text/plain').send(challenge);
    return reply.status(403).send('Verification failed.');
  };

  const receive = async (req: any, reply: any) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
    const signature = String(req.headers['x-hub-signature-256'] ?? '');
    if (!(await whatsapp.verifyWebhookSignature(rawBody, signature))) return reply.status(403).send('Invalid signature.');

    let payload: any = {};
    try { payload = JSON.parse(rawBody.toString('utf8')) || {}; } catch { payload = {}; }
    const push = async (title: string, body: string, phone: string) => { try { await firebase.sendPushToAllStaff(title, body, { phone }); } catch (e) { req.log.error(`whatsapp_webhook push failed: ${(e as Error).message}`); } };

    for (const entry of arr(payload?.entry)) {
      for (const change of arr(entry?.changes)) {
        const value = change?.value ?? {};

        // Incoming messages (a customer's reply).
        for (const msg of arr(value.messages)) {
          const from = str(msg?.from);
          const providerId = str(msg?.id);
          const type = msg?.type === undefined || msg?.type === null ? 'text' : str(msg.type);
          let text: string | null = null;
          let mediaId: string | null = null;
          if (type === 'text') {
            text = str(msg?.text?.body);
          } else if (type === 'reaction') {
            // Customer reacted (emoji) to a message -- empty emoji = reaction removed.
            const reactedTo = str(msg?.reaction?.message_id);
            const emoji = str(msg?.reaction?.emoji);
            if (from !== '' && reactedTo !== '' && providerId !== '') await whatsapp.logInboundReaction(from, reactedTo, emoji, providerId);
            continue;
          } else if (msg?.[type]?.id !== undefined && msg?.[type]?.id !== null) {
            // image/document/audio/video/sticker -- Meta's media id, not downloaded here.
            mediaId = str(msg[type].id);
            text = str(msg[type].caption);
          }
          if (from !== '' && providerId !== '') {
            await whatsapp.logInboundMessage(from, type, text, mediaId, providerId);
            // A reply should reach staff instantly, not only once someone happens to open the app.
            try {
              const c = (await db.query<{ full_name: string }>('SELECT full_name FROM customers WHERE mobile = ? LIMIT 1', [from]))[0];
              const title = c?.full_name ? String(c.full_name) : from;
              await push(title, type === 'text' ? str(text) : `[${type}]`, from);
            } catch (e) { req.log.error(`whatsapp_webhook push failed: ${(e as Error).message}`); }
          }
        }

        // WhatsApp calls (only delivered if Calling is enabled for this number in Meta).
        for (const call of arr(value.calls)) {
          const p = await whatsapp.logCallEvent(call && typeof call === 'object' && !Array.isArray(call) ? call : {});
          if (p) {
            try {
              const c = (await db.query<{ full_name: string }>("SELECT full_name FROM customers WHERE RIGHT(REGEXP_REPLACE(mobile, '[^0-9]', ''), 10) = ? LIMIT 1", [p.phone.slice(-10)]))[0];
              await push(`${p.title} — ${c?.full_name ? String(c.full_name) : p.phone}`, p.body, p.phone);
            } catch (e) { req.log.error(`whatsapp_webhook call push failed: ${(e as Error).message}`); }
          }
        }

        // Status updates (delivered/read/failed) for messages THIS app sent earlier.
        for (const st of arr(value.statuses)) {
          const providerId = str(st?.id), status = str(st?.status);
          if (providerId !== '' && status !== '') await whatsapp.updateMessageStatus(providerId, status);
        }
      }
    }
    // Meta requires a 200 response regardless of what was inside, or it will retry/eventually disable the webhook.
    return reply.status(200).send('OK');
  };

  for (const url of ['/api/whatsapp_webhook', '/api/whatsapp_webhook.php']) {
    app.get(url, verify);
    app.post(url, receive);
  }
}
