import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { Crypto } from '../src/lib/crypto.js';
import { datetimeIn } from '../src/lib/tzFormat.js';
import { hashPassword } from '../src/lib/password.js';
import { MetaCloudProvider, type SendResult, type WaConfig, type WhatsAppProvider } from '../src/whatsapp/provider.js';
import { WhatsAppService } from '../src/services/whatsappService.js';
import { resetAndSeed } from './helpers.js';

describe('phone normalisation + template rendering', () => {
  it.each([
    ['98765 43210', '919876543210'], ['09876543210', '919876543210'], ['+91 98765-43210', '919876543210'],
    ['919876543210', '919876543210'], ['+1 415 555 2671 9', '1415555267 19'.replace(' ', '')], ['12345', '12345'], ['', ''], ['abc', ''],
  ])('%s → %s', (raw, want) => expect(WhatsAppService.normalizePhoneNumber(raw)).toBe(want));

  it('renders known variables, blanks unknown ones and reports them once', () => {
    expect(WhatsAppService.renderTemplate('Hi {customer_name} {x} {x} {n}', { customer_name: 'A', n: 5 })).toEqual({ text: 'Hi A   5', missing: ['x'] });
    expect(WhatsAppService.renderTemplate('{a}{b}{c}', { a: null, b: true, c: false }).text).toBe('1');
  });
});

describe('MetaCloudProvider (fake fetch)', () => {
  const cfg: WaConfig = { phone_number_id: '123', api_version: 'v21.0', access_token: 'TOKEN' };
  const mk = (res: { status: number; body: unknown } | Error) => {
    const calls: { url: string; init: any }[] = [];
    const fetchFn = (async (url: string, init: any) => {
      calls.push({ url, init });
      if (res instanceof Error) throw res;
      return new Response(typeof res.body === 'string' ? res.body : JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof fetch;
    return { p: new MetaCloudProvider(fetchFn), calls };
  };

  it('sends a template with header document + body params and returns the message id', async () => {
    const { p, calls } = mk({ status: 200, body: { messages: [{ id: 'wamid.1' }] } });
    const r = await p.sendTemplate(cfg, '919876543210', 'inv', 'en', ['A', 'B'], { id: 'm1', filename: 'Invoice.pdf' });
    expect(r).toEqual({ success: true, provider_message_id: 'wamid.1', error: null });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer TOKEN');
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      messaging_product: 'whatsapp', to: '919876543210', type: 'template',
      template: { name: 'inv', language: { code: 'en' }, components: [
        { type: 'header', parameters: [{ type: 'document', document: { id: 'm1', filename: 'Invoice.pdf' } }] },
        { type: 'body', parameters: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }] },
    });
  });

  it('surfaces Meta errors, HTTP failures and transport errors without leaking the token', async () => {
    expect((await mk({ status: 400, body: { error: { message: 'Bad number' } } }).p.sendText(cfg, '1', 'x')).error).toBe('Bad number');
    expect((await mk({ status: 500, body: 'oops' }).p.sendText(cfg, '1', 'x')).error).toBe('Meta API request failed (HTTP 500).');
    const t = await mk(new Error('getaddrinfo ENOTFOUND')).p.sendText(cfg, '1', 'x');
    expect(t.error).toBe('Could not reach Meta API: getaddrinfo ENOTFOUND');
    expect(JSON.stringify(t)).not.toContain('TOKEN');
    expect((await mk({ status: 200, body: { error: { message: 'in 200' } } }).p.sendText(cfg, '1', 'x')).error).toBe('in 200');
  });

  it('validates config and media type instead of throwing', async () => {
    const { p, calls } = mk({ status: 200, body: {} });
    expect((await p.sendText({ ...cfg, api_version: '21' }, '1', 'x')).error).toMatch(/valid version string/);
    expect((await p.sendText({ ...cfg, phone_number_id: '' }, '1', 'x')).error).toBe('phone_number_id is required.');
    expect((await p.sendText({ ...cfg, access_token: '' }, '1', 'x')).error).toBe('No access token configured for this WhatsApp account.');
    expect((await p.sendMedia(cfg, '1', 'm', 'video')).error).toBe('Unsupported media type "video".');
    expect(calls).toHaveLength(0);
  });

  it('uploads media as multipart and testConnection does a GET', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-'));
    const f = join(dir, 'a.pdf');
    writeFileSync(f, '%PDF-1.4 hi');
    const up = mk({ status: 200, body: { id: 'media-9' } });
    expect(await up.p.uploadMedia(cfg, f, 'application/pdf')).toEqual({ success: true, media_id: 'media-9', error: null });
    expect(up.calls[0]!.url).toBe('https://graph.facebook.com/v21.0/123/media');
    expect(up.calls[0]!.init.body).toBeInstanceOf(FormData);
    expect((up.calls[0]!.init.body as FormData).get('messaging_product')).toBe('whatsapp');
    expect((await up.p.uploadMedia(cfg, join(dir, 'missing.pdf'), 'application/pdf')).error).toBe('Local file not found.');
    const t = mk({ status: 200, body: { id: '123' } });
    expect(await t.p.testConnection(cfg)).toEqual({ success: true, error: null });
    expect(t.calls[0]!.init.method).toBe('GET');
  });
});

const enabled = !!process.env.TEST_DB_NAME;
describe.skipIf(!enabled)('WhatsApp queue, webhook, invoice (real MariaDB schema, fake provider)', () => {
  const env = loadEnv({
    NODE_ENV: 'test', DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k', APP_TIMEZONE: 'Asia/Kolkata',
  } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  const crypto = new Crypto('k');
  const sent: { kind: string; args: unknown[] }[] = [];
  let outcome: SendResult = { success: true, provider_message_id: 'wamid.X', error: null };
  const provider: WhatsAppProvider = {
    async sendTemplate(...a) { sent.push({ kind: 'template', args: a.slice(1) }); return outcome; },
    async sendText(...a) { sent.push({ kind: 'text', args: a.slice(1) }); return outcome; },
    async sendMedia(...a) { sent.push({ kind: 'media', args: a.slice(1) }); return outcome; },
    async uploadMedia(_c, path, mime) { sent.push({ kind: 'upload', args: [existsSync(path), mime] }); return { success: true, media_id: 'media-1', error: null }; },
    async testConnection() { return { success: true, error: null }; },
  };
  const pdfDir = mkdtempSync(join(tmpdir(), 'wa-pdf-'));
  let pdfPath = '';
  const svc = buildServices(env, db, {
    provider,
    invoicePdf: { async generate() { pdfPath = join(pdfDir, `inv-${Date.now()}.pdf`); writeFileSync(pdfPath, '%PDF'); return { success: true, file_path: pdfPath }; } },
    challanPdf: { async generate() { pdfPath = join(pdfDir, `ch-${Date.now()}.pdf`); writeFileSync(pdfPath, '%PDF'); return { success: true, file_path: pdfPath }; } },
  });
  const wa = svc.whatsapp;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const SECRET = 'app-secret';

  beforeAll(async () => {
    app = await buildApp(svc);
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await close(); });

  beforeEach(async () => {
    sent.length = 0;
    outcome = { success: true, provider_message_id: 'wamid.X', error: null };
    await resetAndSeed(db);
    await db.execute("INSERT INTO whatsapp_accounts (id, store_id, account_name, waba_id, phone_number_id, access_token_encrypted, app_secret_encrypted, webhook_verify_token, api_version, is_active) VALUES (1, NULL, 'Main', 'w', 'p1', ?, ?, 'verify-me', 'v21.0', 1)", [crypto.encrypt('TOK'), crypto.encrypt(SECRET)]);
    await db.execute(
      `INSERT INTO notification_templates (template_key, channel, body, provider_template_name, language, template_param_order, is_active) VALUES
       ('order_ready', 'WhatsApp', 'Hi {customer_name}, {order_number} ready', NULL, NULL, NULL, 1),
       ('order_confirmation', 'WhatsApp', 'Hi {customer_name} {order_number}', 'conf_v1', 'en', '["customer_name","order_number"]', 1),
       ('invoice', 'WhatsApp', 'inv', 'invoice_v1', 'en', '["customer_name","invoice_number","grand_total","current_due","due_date"]', 1),
       ('challan_document', 'WhatsApp', 'challan', 'challan_v1', 'en', '["challan_number","order_numbers","order_count","with_amount"]', 1)`);
  });

  const queue = () => db.query<any>('SELECT * FROM whatsapp_outbound_queue ORDER BY id');

  it('enqueue: dedupes on event_ref, reports missing account/template', async () => {
    const a = await wa.enqueue(1, null, '9999999999', 'order_ready', { customer_name: 'V', order_number: 'O1' }, 'ref-1');
    expect(a).toMatchObject({ success: true, duplicate: false });
    expect(await wa.enqueue(1, null, '9999999999', 'order_ready', {}, 'ref-1')).toEqual({ success: true, queue_id: null, error: null, duplicate: true });
    expect((await wa.enqueue(1, null, '9999999999', 'nope', {})).error).toBe('No active WhatsApp template found for key "nope".');
    await db.execute('UPDATE whatsapp_accounts SET is_active = 0');
    expect((await wa.enqueue(1, null, '9999999999', 'order_ready', {}, 'ref-2')).error).toBe('No WhatsApp account configured for this store (or globally).');
    const rows = await queue();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to_number: '919999999999', status: 'Queued', message_type: 'template', template_key: 'order_ready' });
    expect(JSON.parse(rows[0].payload_json).text).toBe('Hi V, O1 ready');
  });

  it('worker: sends text / template / media, logs, and marks Sent', async () => {
    await wa.enqueue(1, null, '9999999999', 'order_ready', { customer_name: 'V', order_number: 'O1' }, 'r1');
    await wa.enqueue(1, null, '9999999999', 'order_confirmation', { customer_name: 'V', order_number: 'O2' }, 'r2');
    await wa.enqueueMedia(1, null, '9999999999', 1, 'm-1', 'image', 'cap', 'r3');
    expect(await wa.processQueueBatch(10)).toEqual({ processed: 3, sent: 3, failed: 0, error: null });
    expect(sent.map((s) => s.kind)).toEqual(['text', 'template', 'media']);
    expect(sent[1]!.args).toEqual(['919999999999', 'conf_v1', 'en', ['V', 'O2']]);
    expect(sent[2]!.args).toEqual(['919999999999', 'm-1', 'image', 'cap']);
    expect((await queue()).map((r) => [r.status, r.provider_message_id])).toEqual([['Sent', 'wamid.X'], ['Sent', 'wamid.X'], ['Sent', 'wamid.X']]);
    const logs = await db.query<any>("SELECT template_key, status, provider, provider_message_id FROM notification_logs WHERE channel = 'WhatsApp' ORDER BY id");
    expect(logs).toHaveLength(3);
    expect(logs[0]).toEqual({ template_key: 'order_ready', status: 'Sent', provider: 'meta', provider_message_id: 'wamid.X' });
    expect((await wa.processQueueBatch(10)).processed).toBe(0);
  });

  it('worker: failure backs off quadratically, retries when due, and stops at max_retries', async () => {
    outcome = { success: false, provider_message_id: null, error: 'Meta says no' };
    await wa.enqueue(1, null, '9999999999', 'order_ready', {}, 'r1');
    expect((await wa.processQueueBatch()).failed).toBe(1);
    let r = (await queue())[0];
    expect(r).toMatchObject({ status: 'Failed', retry_count: 1, error_message: 'Meta says no' });
    // PHP: date('Y-m-d H:i:s', time() + 300 * n²) on the APP_TIMEZONE clock (+5:30 vs the UTC NOW(); see docs/PARITY.md)
    const secsFromKolkataNow = (v: string) => (Date.parse(v.replace(' ', 'T') + 'Z') - Date.parse(datetimeIn('Asia/Kolkata', Date.now()).replace(' ', 'T') + 'Z')) / 1000;
    expect(Math.abs(secsFromKolkataNow(r.next_attempt_at) - 300)).toBeLessThan(5);
    // not due yet (PHP wrote the APP_TIMEZONE clock against a UTC NOW(); see docs/PARITY.md)
    expect((await wa.processQueueBatch()).processed).toBe(0);
    await db.execute('UPDATE whatsapp_outbound_queue SET next_attempt_at = NOW() - INTERVAL 1 MINUTE');
    expect((await wa.processQueueBatch()).failed).toBe(1);
    expect(Math.abs(secsFromKolkataNow((await queue())[0].next_attempt_at) - 1200)).toBeLessThan(5); // 2nd failure: 300 × 2²
    await db.execute('UPDATE whatsapp_outbound_queue SET next_attempt_at = NOW() - INTERVAL 1 MINUTE');
    expect((await wa.processQueueBatch()).failed).toBe(1);
    r = (await queue())[0];
    expect(r).toMatchObject({ status: 'Failed', retry_count: 3, next_attempt_at: null });
    expect((await wa.processQueueBatch()).processed).toBe(0); // permanent
    expect(await db.query("SELECT 1 FROM notification_logs WHERE status = 'Failed' AND channel = 'WhatsApp'")).toHaveLength(3);
  });

  it('worker: missing account / undecryptable credentials fail the row without crashing', async () => {
    await wa.enqueue(1, null, '9999999999', 'order_ready', {}, 'r1');
    await db.execute("UPDATE whatsapp_accounts SET access_token_encrypted = 'garbage'");
    expect(await wa.processQueueBatch()).toMatchObject({ processed: 1, failed: 1 });
    expect((await queue())[0]).toMatchObject({ status: 'Failed', error_message: 'Could not decrypt account credentials.' });
  });

  it('worker: a row already claimed by another run is skipped', async () => {
    await wa.enqueue(1, null, '9999999999', 'order_ready', {}, 'r1');
    const [row] = await queue();
    const racingDb = { ...db, query: async (sql: string, p?: unknown[]) => { const r = await db.query(sql, p); if (/FROM whatsapp_outbound_queue/.test(sql)) await db.execute("UPDATE whatsapp_outbound_queue SET status = 'Sending' WHERE id = ?", [row.id]); return r; } } as unknown as typeof db;
    const racing = new WhatsAppService(
      racingDb,
      crypto, provider, { appName: 'X', timezone: 'Asia/Kolkata' });
    expect(await racing.processQueueBatch()).toMatchObject({ processed: 1, sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it('webhook: verification handshake', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/whatsapp_webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=CH123' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('CH123');
    expect((await app.inject({ method: 'GET', url: '/api/whatsapp_webhook.php?hub_mode=subscribe&hub_verify_token=verify-me&hub_challenge=7' })).body).toBe('7');
    expect((await app.inject({ method: 'GET', url: '/api/whatsapp_webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CH' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/whatsapp_webhook?hub.mode=subscribe&hub.verify_token=verify-me' })).statusCode).toBe(403);
  });

  const hook = (payload: string, secret: string | null = SECRET) =>
    app.inject({ method: 'POST', url: '/api/whatsapp_webhook', headers: { 'content-type': 'application/json', ...(secret ? { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}` } : {}) }, payload });

  it('webhook: rejects bad / missing signatures, malformed JSON', async () => {
    const body = JSON.stringify({ entry: [] });
    expect((await hook(body, 'other-secret')).statusCode).toBe(403);
    expect((await hook(body, null)).statusCode).toBe(403);
    expect((await hook('not json')).statusCode).toBe(400);
    expect((await hook('[1,2]')).statusCode).toBe(400);
    expect((await hook(body)).statusCode).toBe(200);
  });

  it('webhook: status updates only move forward; inbound messages are logged once and matched to the customer', async () => {
    await wa.enqueue(1, null, '9999999999', 'order_ready', {}, 'r1');
    await wa.processQueueBatch(); // → Sent, provider id wamid.X
    const status = (s: string) => JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: s }] } }] }] });
    expect((await hook(status('read'))).statusCode).toBe(200);
    expect((await queue())[0].status).toBe('Read');
    await hook(status('delivered')); // older than Read → ignored
    expect((await queue())[0].status).toBe('Read');
    await hook(status('bogus'));
    expect((await queue())[0].status).toBe('Read');

    const inbound = JSON.stringify({ entry: [{ changes: [{ value: { messages: [
      { from: '919999999999', id: 'wamid.IN1', type: 'text', text: { body: 'hello' } },
      { from: '15550001111', id: 'wamid.IN2', type: 'image' },
      { from: '', id: 'wamid.IN3' }] } }] }] });
    await hook(inbound);
    await hook(inbound);
    const rows = await db.query<any>("SELECT customer_id, recipient, message, direction, provider FROM notification_logs WHERE direction = 'Inbound' ORDER BY id");
    expect(rows).toEqual([
      { customer_id: 1, recipient: '919999999999', message: 'hello', direction: 'Inbound', provider: 'meta' },
      { customer_id: null, recipient: '15550001111', message: '[image message]', direction: 'Inbound', provider: 'meta' },
    ]);
  });

  it('sendInvoice: template mode with header document, deletes the temp PDF, logs it', async () => {
    const o = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);
    expect(o.success).toBe(true);
    sent.length = 0;
    const r = await wa.sendInvoice(o.order_id as number, 1);
    expect(r).toEqual({ success: true, mode: 'template', error: null, code: null });
    expect(sent.map((s) => s.kind)).toEqual(['upload', 'template']);
    expect(sent[0]!.args).toEqual([true, 'application/pdf']);
    expect(existsSync(pdfPath)).toBe(false);
    const tpl = sent[1]!.args as any[];
    expect(tpl[1]).toBe('invoice_v1');
    expect(tpl[4]).toEqual({ id: 'media-1', filename: expect.stringMatching(/^Invoice-.+\.pdf$/) });
    expect(tpl[3]).toHaveLength(5);
    const log = (await db.query<any>("SELECT template_key, status, message, user_id FROM notification_logs WHERE template_key = 'invoice'"))[0];
    expect(log).toMatchObject({ status: 'Sent', user_id: 1 });
    expect(log.message).toMatch(/^\[document\] Invoice .+ \(template\)$/);
  });

  it('sendInvoice: free-form fallback, error codes', async () => {
    await db.execute("DELETE FROM notification_templates WHERE template_key = 'invoice'");
    const o = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);
    sent.length = 0;
    expect(await wa.sendInvoice(o.order_id as number, null)).toMatchObject({ success: true, mode: 'free_form' });
    expect(sent.map((s) => s.kind)).toEqual(['upload', 'media']);
    expect(await wa.sendInvoice(9999, null)).toEqual({ success: false, mode: null, error: 'Order not found.', code: 'not_found' });
    await db.execute("UPDATE customers SET mobile = '' WHERE id = 1");
    expect((await wa.sendInvoice(o.order_id as number, null)).code).toBe('no_mobile');
    await db.execute("UPDATE customers SET mobile = '9999999999' WHERE id = 1");
    outcome = { success: false, provider_message_id: null, error: 'x'.repeat(300) };
    const bad = await wa.sendInvoice(o.order_id as number, null);
    expect(bad).toMatchObject({ success: false, code: 'send_failed' });
    expect((await db.query<any>("SELECT error_message FROM notification_logs WHERE status = 'Failed' AND template_key = 'invoice'"))[0].error_message).toHaveLength(255);
    await db.execute('UPDATE whatsapp_accounts SET is_active = 0');
    expect((await wa.sendInvoice(o.order_id as number, null)).code).toBe('not_configured');
  });

  it('sendChallan: template mode, deletes the temp PDF, logs it against the single order', async () => {
    const o = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);
    const ch = await svc.challans.generate([o.order_id as number], true, { userId: 1 });
    expect(ch.success).toBe(true);
    sent.length = 0;
    const r = await wa.sendChallan(ch.challan_id as number, '9876543210', 1);
    expect(r).toEqual({ success: true, mode: 'template', error: null, code: null });
    expect(sent.map((s) => s.kind)).toEqual(['upload', 'template']);
    expect(sent[0]!.args).toEqual([true, 'application/pdf']);
    expect(existsSync(pdfPath)).toBe(false);
    const tpl = sent[1]!.args as any[];
    expect(tpl[0]).toBe('919876543210');
    expect(tpl[1]).toBe('challan_v1');
    expect(tpl[4]).toEqual({ id: 'media-1', filename: expect.stringMatching(/^Challan-.+\.pdf$/) });
    expect(tpl[3]).toHaveLength(4);
    const log = (await db.query<any>("SELECT template_key, status, message, user_id, order_id, customer_id FROM notification_logs WHERE template_key = 'challan_document'"))[0];
    expect(log).toMatchObject({ status: 'Sent', user_id: 1, order_id: o.order_id, customer_id: 1 });
    expect(log.message).toMatch(/^\[document\] Challan .+ \(template\)$/);
  });

  it('sendChallan: combined challan has no single order to attribute the log to', async () => {
    const o1 = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);
    const o2 = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);
    const ch = await svc.challans.generate([o1.order_id as number, o2.order_id as number], true, { userId: 1 });
    sent.length = 0;
    const r = await wa.sendChallan(ch.challan_id as number, '9876543210', 1);
    expect(r).toMatchObject({ success: true, mode: 'template' });
    const log = (await db.query<any>("SELECT order_id, customer_id FROM notification_logs WHERE template_key = 'challan_document'"))[0];
    expect(log).toMatchObject({ order_id: null, customer_id: null });
  });

  it('sendChallan: free-form fallback, error codes', async () => {
    await db.execute("DELETE FROM notification_templates WHERE template_key = 'challan_document'");
    const o = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);
    const ch = await svc.challans.generate([o.order_id as number], true, { userId: 1 });
    sent.length = 0;
    expect(await wa.sendChallan(ch.challan_id as number, '9876543210', null)).toMatchObject({ success: true, mode: 'free_form' });
    expect(sent.map((s) => s.kind)).toEqual(['upload', 'media']);
    expect(await wa.sendChallan(9999, '9876543210', null)).toEqual({ success: false, mode: null, error: 'Challan not found.', code: 'not_found' });
    expect((await wa.sendChallan(ch.challan_id as number, '', null)).code).toBe('no_mobile');
    outcome = { success: false, provider_message_id: null, error: 'x'.repeat(300) };
    const bad = await wa.sendChallan(ch.challan_id as number, '9876543210', null);
    expect(bad).toMatchObject({ success: false, code: 'send_failed' });
    expect((await db.query<any>("SELECT error_message FROM notification_logs WHERE status = 'Failed' AND template_key = 'challan_document'"))[0].error_message).toHaveLength(255);
    await db.execute('UPDATE whatsapp_accounts SET is_active = 0');
    expect((await wa.sendChallan(ch.challan_id as number, '9876543210', null)).code).toBe('not_configured');
  });

  it('mobile send-invoice route: auth, validation, error mapping', async () => {
    await db.execute('INSERT INTO permissions (id, permission_key, module) VALUES (1, \'billing.view\', \'x\')');
    await db.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (1, 1)');
    await db.execute('UPDATE users SET password_hash = ? WHERE id = 1', [await hashPassword('pw12345')]);
    const token = 'a'.repeat(64);
    await db.execute("INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (1, ?, NOW() + INTERVAL 1 DAY)", [createHash('sha256').update(token).digest('hex')]);
    const h = { authorization: `Bearer ${token}` };
    const o = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);
    const post = (payload: unknown, headers: any = h) => app.inject({ method: 'POST', url: '/api/mobile/whatsapp_send_invoice', headers, payload: payload as object });
    expect((await post({ order_id: 1 }, {})).statusCode).toBe(401);
    expect((await post({})).json().error).toMatchObject({ code: 'invalid_request', message: 'A valid order_id is required.' });
    expect((await post({ order_id: 999 })).statusCode).toBe(404);
    expect((await post({ order_id: o.order_id })).json()).toEqual({ success: true, data: { sent: true, mode: 'template' } });
    outcome = { success: false, provider_message_id: null, error: 'Meta says no' };
    const f = await post({ order_id: o.order_id });
    expect(f.statusCode).toBe(502);
    expect(f.json().error).toEqual({ code: 'send_failed', message: 'Meta says no' });
  });

  it('mobile send-challan route: auth, validation, error mapping, saves a number on request', async () => {
    await db.execute("INSERT INTO permissions (id, permission_key, module) VALUES (2, 'challans.manage', 'x')");
    await db.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (1, 2)');
    await db.execute('UPDATE users SET password_hash = ? WHERE id = 1', [await hashPassword('pw12345')]);
    const token = 'b'.repeat(64);
    await db.execute("INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (1, ?, NOW() + INTERVAL 1 DAY)", [createHash('sha256').update(token).digest('hex')]);
    const h = { authorization: `Bearer ${token}` };
    const o = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);
    const ch = await svc.challans.generate([o.order_id as number], true, { userId: 1 });
    const post = (payload: unknown, headers: any = h) => app.inject({ method: 'POST', url: '/api/mobile/challan_send_whatsapp', headers, payload: payload as object });

    expect((await post({ challan_id: ch.challan_id }, {})).statusCode).toBe(401);
    expect((await post({ challan_id: ch.challan_id })).json().error).toMatchObject({ code: 'invalid_request', message: 'A WhatsApp number is required.' });
    expect((await post({ challan_id: 999999, to_number: '9876543210' })).statusCode).toBe(404);

    expect((await post({ challan_id: ch.challan_id, to_number: '9876543210', save_number: true })).json()).toEqual({ success: true, data: { sent: true, mode: 'template' } });
    const detail = await app.inject({ method: 'GET', url: `/api/mobile/challan_detail?id=${ch.challan_id}`, headers: h });
    expect(detail.json().data.saved_whatsapp_numbers).toContain('9876543210');

    outcome = { success: false, provider_message_id: null, error: 'Meta says no' };
    const f = await post({ challan_id: ch.challan_id, to_number: '9876543210' });
    expect(f.statusCode).toBe(502);
    expect(f.json().error).toEqual({ code: 'send_failed', message: 'Meta says no' });
  });
});
