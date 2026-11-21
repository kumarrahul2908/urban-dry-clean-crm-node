import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { Crypto } from '../src/lib/crypto.js';
import { WhatsAppService } from '../src/services/whatsappService.js';
import type { SendResult, WhatsAppProvider } from '../src/whatsapp/provider.js';
import { resetAndSeed } from './helpers.js';

const enabled = !!process.env.TEST_DB_NAME;
describe.skipIf(!enabled)('WhatsApp challan / workshop invoice / bulk templates (fake provider)', () => {
  const env = loadEnv({ NODE_ENV: 'test', DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306', DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '', APP_SECRET_KEY: 'k', APP_TIMEZONE: 'Asia/Kolkata' } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  const crypto = new Crypto('k');
  const dir = mkdtempSync(join(tmpdir(), 'wad-'));
  const calls: { kind: string; args: unknown[] }[] = [];
  let tplStatus = 'APPROVED';
  const ok: SendResult = { success: true, provider_message_id: 'wamid.Z', error: null };
  const provider: WhatsAppProvider = {
    async sendTemplate(...a) { calls.push({ kind: 'template', args: a.slice(1) }); return ok; },
    async sendText(...a) { calls.push({ kind: 'text', args: a.slice(1) }); return ok; },
    async sendMedia(...a) { calls.push({ kind: 'media', args: a.slice(1) }); return ok; },
    async uploadMedia() { calls.push({ kind: 'upload', args: [] }); return { success: true, media_id: 'm1', error: null }; },
    async testConnection() { return { success: true, error: null }; },
    async createDocumentTemplate() { return { success: true, status: 'PENDING', error: null }; },
    async createTextTemplate(...a) { calls.push({ kind: 'createText', args: a.slice(1) }); return { success: true, status: tplStatus, id: 'T1', error: null }; },
    async listTemplateStatuses() { return { success: true, templates: { challan_document: { status: 'APPROVED', id: '9', reason: null } }, error: null }; },
  };
  const pdf = (name: string) => { const p = join(dir, `${name}-${Date.now()}-${Math.random()}.pdf`); writeFileSync(p, '%PDF'); return p; };
  const wa = new WhatsAppService(db, crypto, provider, {
    appName: 'X', timezone: 'Asia/Kolkata', mediaDir: join(dir, 'media'),
    challanPdf: { async generate() { return { success: true, file_path: pdf('c'), error: null }; } },
    workshopBillPdf: { async generate() { return { success: true, file_path: pdf('w'), error: null, bill_number: 'DW-1', filename: 'Invoice-DW-1.pdf' }; } },
  });
  afterAll(async () => { await close(); });
  beforeEach(async () => {
    calls.length = 0; tplStatus = 'APPROVED';
    await resetAndSeed(db);
    await db.execute("INSERT INTO whatsapp_accounts (id, store_id, account_name, waba_id, phone_number_id, access_token_encrypted, api_version, is_active) VALUES (1, NULL, 'Main', 'w', 'p1', ?, 'v21.0', 1)", [crypto.encrypt('TOK')]);
  });

  it('sendChallan: free-form fallback, template mode, error codes, logs', async () => {
    for (const n of ['A1', 'A2']) await db.execute("INSERT INTO orders (order_number, short_order_code, customer_id, store_id, price_list_id, status_id, order_mode, order_date, due_date, grand_total) VALUES (?, ?, 1, 1, (SELECT id FROM price_lists ORDER BY id LIMIT 1), (SELECT id FROM order_statuses ORDER BY id LIMIT 1), 'piece', NOW(), CURDATE(), 100)", [n, n]);
    const o = (await db.query<any>('SELECT id FROM orders ORDER BY id LIMIT 2')).map((r) => r.id);
    const free = await wa.sendChallan(o, '98765 43210', true, 'CUS-000001', 1);
    expect(free).toEqual({ success: true, mode: 'free_form', error: null, code: null });
    expect(calls.map((c) => c.kind)).toEqual(['upload', 'media']);
    expect(calls[1]!.args).toEqual(['919876543210', 'm1', 'document', 'Challan CUS-000001']);
    expect(await db.query("SELECT 1 FROM whatsapp_messages WHERE direction='outbound' AND message_text = '[document] Challan CUS-000001' AND status='sent'")).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM notification_logs WHERE template_key='challan_document' AND status='Sent'")).toHaveLength(1);
    calls.length = 0;
    await db.execute("INSERT INTO notification_templates (template_key, channel, body, provider_template_name, language, template_param_order, is_active) VALUES ('challan_document','WhatsApp','b','chl_v1','en','[\"challan_number\",\"order_number\",\"grand_total\"]',1)");
    const tpl = await wa.sendChallan([o[0]], '9876543210', false, 'CUS-000002', 1);
    expect(tpl.mode).toBe('template');
    expect(calls[1]!.kind).toBe('template');
    expect((calls[1]!.args as any[])[1]).toBe('chl_v1');
    expect((calls[1]!.args as any[])[3][0]).toBe('CUS-000002');
    expect((calls[1]!.args as any[])[4]).toEqual({ id: 'm1', filename: 'Challan-CUS-000002.pdf' });
    expect(await wa.sendChallan([], '9876543210', true, 'X', 1)).toMatchObject({ code: 'not_found' });
    expect(await wa.sendChallan([999], '9876543210', true, 'X', 1)).toMatchObject({ code: 'not_found' });
    expect(await wa.sendChallan(o, 'abc', true, 'X', 1)).toMatchObject({ code: 'no_mobile' });
    await db.execute('UPDATE whatsapp_accounts SET is_active = 0');
    expect(await wa.sendChallan(o, '9876543210', true, 'X', 1)).toMatchObject({ code: 'not_configured' });
  });

  it('bulk template: validation, Meta variables, stored row, status sync, campaign queue', async () => {
    expect((await wa.createBulkTemplate('', 'MARKETING', 'x')).success).toBe(false);
    expect((await wa.createBulkTemplate('A', 'MARKETING', 'Hi {bogus} there')).error).toMatch(/variables allowed/);
    expect((await wa.createBulkTemplate('A', 'MARKETING', '{customer_name} hi')).error).toMatch(/shuru ya khatam/);
    expect((await wa.createBulkTemplate('A', 'MARKETING', 'Hi {customer_name}{business_name} yo')).error).toMatch(/ek ke baad ek/);
    const r = await wa.createBulkTemplate('Diwali Offer!', 'marketing', 'Namaste {customer_name}, offer from {business_name} ok');
    expect(r).toMatchObject({ success: true, status: 'APPROVED' });
    const [name, , category, metaBody, examples] = calls.find((c) => c.kind === 'createText')!.args as any[];
    expect(name).toMatch(/^udc_diwali_offer_[0-9a-f]{5}$/);
    expect(category).toBe('MARKETING');
    expect(metaBody).toBe('Namaste {{1}}, offer from {{2}} ok');
    expect(examples).toHaveLength(2);
    const row = (await db.query<any>('SELECT * FROM notification_templates WHERE id = ?', [r.template_id]))[0];
    expect(row).toMatchObject({ provider_template_name: name, meta_status: 'APPROVED', category: 'MARKETING', template_param_order: '["customer_name","business_name"]' });

    await db.execute("INSERT INTO notification_templates (template_key, channel, body, language, template_param_order, is_active) VALUES ('challan_document','WhatsApp','b','en','[\"a\"]',1)");
    expect(await wa.syncTemplateStatuses()).toEqual({ success: true, error: null, updated: 1 });
    expect((await db.query<any>("SELECT provider_template_name, meta_status FROM notification_templates WHERE template_key='challan_document'"))[0]).toEqual({ provider_template_name: 'challan_document', meta_status: 'APPROVED' });

    await db.execute("UPDATE customers SET communication_preference = 'WhatsApp'");
    const c = await db.query<any>('SELECT id FROM customers ORDER BY id LIMIT 2');
    const s = await wa.startBulkCampaign('Camp', r.template_id!, null, c.map((x: any) => x.id), null, 1);
    expect(s.success).toBe(true);
    expect(s.queued! + s.skipped!).toBe(c.length);
    expect((await db.query('SELECT 1 FROM whatsapp_outbound_queue WHERE campaign_id IS NOT NULL')).length).toBe(s.queued);
    expect((await wa.startBulkCampaign('', 1, null, [], null, 1)).error).toMatch(/naam/);
    expect((await wa.startBulkCampaign('C', 999, null, [], null, 1)).error).toMatch(/Template nahi mila/);
    expect((await wa.startBulkCampaign('C', r.template_id!, 'nope', [], null, 1)).error).toMatch(/Segment galat/);
  });

  it('attachments: only JPEG/PNG/PDF; the sent copy is kept and can be served again', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    expect(await wa.sendUploadedAttachment(0, '9876543210', null, '', 1)).toEqual({ success: false, error: 'Select a valid file.' });
    expect((await wa.sendUploadedAttachment(0, '9876543210', { buffer: Buffer.from('hello') }, '', 1)).error).toMatch(/detected: text\/plain/);
    const r = await wa.sendUploadedAttachment(0, '9876543210', { buffer: png }, 'cap', 1);
    expect(r.success).toBe(true);
    const row = (await db.query<any>("SELECT id, media_url, message_type FROM whatsapp_messages WHERE direction='outbound'"))[0];
    expect(row.message_type).toBe('image');
    expect(row.media_url).toMatch(/^local:[0-9a-f]{32}\.png$/);
    const m = await wa.messageMedia(row.id);
    expect(m!.contentType).toBe('image/png');
    expect(m!.body.equals(png)).toBe(true);
    expect(await wa.messageMedia(9999)).toBeNull();
  });
});
