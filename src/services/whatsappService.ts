import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, basename } from 'node:path';
import type { Db } from '../db/pool.js';
import type { Crypto } from '../lib/crypto.js';
import { numberFormat2, phpEmpty } from '../lib/php.js';
import { datetimeIn, dMonY } from '../lib/tzFormat.js';
import { todayIn } from '../lib/dates.js';
import { getSetting } from './settings.js';
import { CustomerSegments } from './customerSegments.js';
import { sniffImage } from '../storage/imageSniff.js';
import type { SendResult, WaConfig, WhatsAppProvider } from '../whatsapp/provider.js';

type Row = Record<string, any>;

export interface EnqueueResult { success: boolean; queue_id: number | null; error: string | null; duplicate: boolean }

/** Produces the invoice PDF for an order (InvoicePdfService::generate). Injected so the WhatsApp layer stays testable. */
export interface InvoicePdfGenerator {
  generate(orderId: number): Promise<{ success: boolean; file_path?: string; error?: string }>;
}
export interface ChallanPdfGenerator {
  generate(orderIds: number[], withAmount: boolean, challanNumber: string, combineFormat?: string): Promise<{ success: boolean; file_path: string | null; error: string | null }>;
}
export interface WorkshopBillPdfGenerator {
  generate(billId: number): Promise<{ success: boolean; file_path: string | null; error: string | null; bill_number: string | null; filename: string | null }>;
}
/** A file the caller streams to the browser/app (the PHP code echoes headers + bytes itself). */
export interface MediaPayload { contentType: string; body: Buffer; disposition?: string; cacheControl?: string; nosniff?: boolean }
export const MEDIA_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'application/pdf': 'pdf',
};
/** Variables a bulk template body may use; each is filled per customer at send time. */
export const BULK_VARIABLES: Record<string, string> = { customer_name: 'Rahul', business_name: 'Urban Dry Clean' };

const phpStr = (v: unknown): string => (v === null || v === undefined || v === false ? '' : v === true ? '1' : String(v));
const mbSubstr255 = (s: string) => Array.from(s).slice(0, 255).join('');
const isDup = (e: any) => e?.sqlState === '23000';
const isMissingTable = (e: any) => /doesn't exist|Base table or view not found/.test(String(e?.message ?? ''));

/** Port of includes/WhatsAppService.php (Meta Cloud provider, queue, templates, invoice sending). */
export class WhatsAppService {
  constructor(
    private readonly db: Db,
    private readonly crypto: Crypto,
    private readonly provider: WhatsAppProvider,
    private readonly opts: { appName: string; timezone: string; invoicePdf?: InvoicePdfGenerator; challanPdf?: ChallanPdfGenerator; workshopBillPdf?: WorkshopBillPdfGenerator; mediaDir?: string; log?: (m: string) => void; now?: () => number },
  ) {}

  private log(m: string) { (this.opts.log ?? console.error)(m); }
  private now() { return (this.opts.now ?? Date.now)(); }
  /** PHP date('Y-m-d') in APP_TIMEZONE. */
  today() { return todayIn(this.opts.timezone, new Date(this.now())); }
  private businessName() { return getSetting(this.db, 'business_name', this.opts.appName); }

  static normalizePhoneNumber(raw: string): string {
    let digits = raw.replace(/\D+/g, '');
    if (digits === '') return digits;
    if (digits.length >= 13 || (digits.length === 12 && digits.startsWith('91'))) return digits;
    if (digits.length === 11 && digits[0] === '0') digits = digits.slice(1);
    if (digits.length === 10) return '91' + digits;
    return digits;
  }

  async resolveAccountForStore(storeId: number | null): Promise<Row | null> {
    try {
      if (storeId !== null) {
        const r = await this.db.query<Row>('SELECT * FROM whatsapp_accounts WHERE store_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1', [storeId]);
        if (r[0]) return r[0];
      }
      const g = await this.db.query<Row>('SELECT * FROM whatsapp_accounts WHERE store_id IS NULL AND is_active = 1 ORDER BY id DESC LIMIT 1');
      return g[0] ?? null;
    } catch {
      return null;
    }
  }

  private decryptAccountConfig(account: Row): WaConfig {
    return {
      phone_number_id: account.phone_number_id,
      api_version: account.api_version,
      access_token: this.crypto.decrypt(account.access_token_encrypted),
      app_id: account.app_id ?? null,
      app_secret: !phpEmpty(account.app_secret_encrypted) ? this.crypto.decrypt(account.app_secret_encrypted) : null,
      waba_id: account.waba_id ?? null,
    };
  }

  async testAccountConnection(accountId: number): Promise<{ success: boolean; error: string | null }> {
    let account: Row | undefined;
    try {
      account = (await this.db.query<Row>('SELECT * FROM whatsapp_accounts WHERE id = ?', [accountId]))[0];
    } catch {
      return { success: false, error: 'The whatsapp_accounts table does not exist yet — it must be created before any account can be tested.' };
    }
    if (!account) return { success: false, error: 'Account not found.' };
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch {
      return { success: false, error: 'Could not read the stored credentials for this account. They may need to be re-entered.' };
    }
    return this.provider.testConnection(config);
  }

  private async logNotification(sql: string, params: unknown[], what: string) {
    try { await this.db.execute(sql, params); } catch (e) { this.log(`WhatsAppService::${what} logging failed: ${(e as Error).message}`); }
  }

  async sendTestMessage(accountId: number, toNumber: string, text: string, userId: number | null): Promise<SendResult | { success: false; error: string }> {
    toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
    let account: Row | undefined;
    try {
      account = (await this.db.query<Row>('SELECT * FROM whatsapp_accounts WHERE id = ? AND is_active = 1', [accountId]))[0];
    } catch {
      return { success: false, error: 'The whatsapp_accounts table does not exist yet.' };
    }
    if (!account) return { success: false, error: 'Account not found or inactive.' };
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return { success: false, error: 'Could not read the stored credentials for this account.' }; }
    const result = await this.provider.sendText(config, toNumber, text);
    await this.logNotification(
      "INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, recipient, message, status, error_message) VALUES (NULL, NULL, ?, 'whatsapp_test_message', 'WhatsApp', ?, ?, ?, ?)",
      [userId, toNumber, text, result.success ? 'Sent' : 'Failed', result.success ? null : result.error], 'sendTestMessage');
    return result;
  }

  async sendDirectReply(customerId: number, toNumber: string, text: string, userId: number | null): Promise<SendResult | { success: false; error: string }> {
    toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
    const account = await this.resolveAccountForStore(null);
    if (!account) return { success: false, error: 'No WhatsApp account is configured.' };
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return { success: false, error: 'Could not read the stored credentials for this account.' }; }
    const result = await this.provider.sendText(config, toNumber, text);
    await this.logNotification(
      "INSERT INTO notification_logs (customer_id, user_id, template_key, channel, recipient, message, status, error_message) VALUES (?, ?, 'inbox_reply', 'WhatsApp', ?, ?, ?, ?)",
      [customerId, userId, toNumber, text, result.success ? 'Sent' : 'Failed', result.success ? null : result.error], 'sendDirectReply');
    await this.logOutboundMessage(toNumber, 'text', text, null, result.provider_message_id ?? null, result.success ? 'sent' : 'failed');
    return result;
  }

  static renderTemplate(body: string, variables: Record<string, unknown>): { text: string; missing: string[] } {
    const missing: string[] = [];
    const text = body.replace(/\{([a-z_]+)\}/g, (_m, name: string) => {
      if (Object.prototype.hasOwnProperty.call(variables, name)) return phpStr(variables[name]);
      missing.push(name);
      return '';
    });
    return { text, missing: [...new Set(missing)] };
  }

  async enqueue(customerId: number, orderId: number | null, toNumber: string, templateKey: string, variables: Record<string, unknown>, eventRef: string | null = null, campaignId: number | null = null): Promise<EnqueueResult> {
    toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
    let storeId: number | null = null;
    if (orderId) {
      try {
        const r = await this.db.query<Row>('SELECT store_id FROM orders WHERE id = ?', [orderId]);
        storeId = r[0]?.store_id ? Number(r[0].store_id) : null;
      } catch { /* store resolution failure shouldn't block the enqueue attempt below */ }
    }
    const account = await this.resolveAccountForStore(storeId);
    if (!account) return { success: false, queue_id: null, error: 'No WhatsApp account configured for this store (or globally).', duplicate: false };
    try {
      const template = (await this.db.query<Row>("SELECT * FROM notification_templates WHERE template_key = ? AND channel = 'WhatsApp' AND is_active = 1", [templateKey]))[0];
      if (!template) return { success: false, queue_id: null, error: `No active WhatsApp template found for key "${templateKey}".`, duplicate: false };
      const rendered = WhatsAppService.renderTemplate(template.body, variables);
      if (rendered.missing.length > 0) this.log(`WhatsAppService::enqueue — unresolved variables for ${templateKey}: ${rendered.missing.join(',')}`);
      let templateParams: string[] | null = null;
      if (!phpEmpty(template.provider_template_name) && !phpEmpty(template.template_param_order)) {
        let order: unknown = null;
        try { order = JSON.parse(template.template_param_order); } catch { /* invalid JSON → [] */ }
        const names = Array.isArray(order) ? order : [];
        templateParams = names.map((n) => phpStr(variables[String(n)]));
      }
      const payload = JSON.stringify({
        text: rendered.text,
        provider_template_name: template.provider_template_name ?? null,
        language: template.language ?? 'en',
        template_params: templateParams,
      });
      const res = await this.db.execute(
        "INSERT INTO whatsapp_outbound_queue (account_id, customer_id, order_id, to_number, message_type, template_key, payload_json, event_ref, campaign_id, status) VALUES (?,?,?,?,'template',?,?,?,?,'Queued')",
        [account.id, customerId, orderId, toNumber, templateKey, payload, eventRef, campaignId]);
      return { success: true, queue_id: res.insertId, error: null, duplicate: false };
    } catch (e) {
      if (isDup(e)) return { success: true, queue_id: null, error: null, duplicate: true };
      if (isMissingTable(e)) return { success: false, queue_id: null, error: 'whatsapp_outbound_queue table does not exist yet.', duplicate: false };
      return { success: false, queue_id: null, error: 'Could not queue the message.', duplicate: false };
    }
  }

  async uploadMediaOnce(storeId: number | null, localFilePath: string, mimeType: string): Promise<{ success: boolean; media_id: string | null; account_id: number | null; error: string | null }> {
    const account = await this.resolveAccountForStore(storeId);
    if (!account) return { success: false, media_id: null, account_id: null, error: 'No WhatsApp account is configured.' };
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch {
      return { success: false, media_id: null, account_id: null, error: 'Could not read the stored credentials for this account.' };
    }
    const up = await this.provider.uploadMedia(config, localFilePath, mimeType);
    if (!up.success) return { success: false, media_id: null, account_id: Number(account.id), error: up.error };
    return { success: true, media_id: up.media_id, account_id: Number(account.id), error: null };
  }

  async enqueueMedia(customerId: number, orderId: number | null, toNumber: string, accountId: number, mediaId: string, mediaType: string, caption: string, eventRef: string | null = null, campaignId: number | null = null): Promise<EnqueueResult> {
    toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
    try {
      const res = await this.db.execute(
        "INSERT INTO whatsapp_outbound_queue (account_id, customer_id, order_id, to_number, message_type, template_key, payload_json, event_ref, campaign_id, status) VALUES (?,?,?,?,'media',NULL,?,?,?,'Queued')",
        [accountId, customerId, orderId, toNumber, JSON.stringify({ media_id: mediaId, media_type: mediaType, caption }), eventRef, campaignId]);
      return { success: true, queue_id: res.insertId, error: null, duplicate: false };
    } catch (e) {
      if (isDup(e)) return { success: true, queue_id: null, error: null, duplicate: true };
      return { success: false, queue_id: null, error: 'Could not queue the media message.', duplicate: false };
    }
  }

  async processQueueBatch(limit = 20): Promise<{ processed: number; sent: number; failed: number; error: string | null }> {
    let processed = 0, sent = 0, failed = 0;
    let rows: Row[];
    try {
      rows = await this.db.query<Row>(
        `SELECT * FROM whatsapp_outbound_queue
         WHERE status = 'Queued' OR (status = 'Failed' AND retry_count < max_retries AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
         ORDER BY id ASC LIMIT ?`, [limit]);
    } catch {
      return { processed: 0, sent: 0, failed: 0, error: 'whatsapp_outbound_queue table does not exist yet.' };
    }
    for (const row of rows) {
      processed++;
      const claim = await this.db.execute("UPDATE whatsapp_outbound_queue SET status = 'Sending' WHERE id = ? AND status IN ('Queued','Failed')", [row.id]);
      if (claim.affectedRows === 0) continue; // another worker run already claimed it
      const account = (await this.db.query<Row>('SELECT * FROM whatsapp_accounts WHERE id = ?', [row.account_id]))[0];
      if (!account) {
        await this.db.execute("UPDATE whatsapp_outbound_queue SET status='Failed', error_message='Account no longer exists.' WHERE id=?", [row.id]);
        failed++;
        continue;
      }
      let config: WaConfig;
      try { config = this.decryptAccountConfig(account); } catch {
        await this.db.execute("UPDATE whatsapp_outbound_queue SET status='Failed', error_message='Could not decrypt account credentials.' WHERE id=?", [row.id]);
        failed++;
        continue;
      }
      let payload: Row = {};
      try { const p = JSON.parse(row.payload_json); if (p && typeof p === 'object' && !Array.isArray(p)) payload = p; } catch { /* {} */ }
      let result: SendResult;
      if (row.message_type === 'media') {
        result = await this.provider.sendMedia(config, row.to_number, payload.media_id ?? '', payload.media_type ?? 'image', payload.caption ?? '');
      } else if (row.message_type === 'template' && !phpEmpty(payload.provider_template_name) && payload.template_params !== undefined && payload.template_params !== null) {
        result = await this.provider.sendTemplate(config, row.to_number, payload.provider_template_name, payload.language ?? 'en', payload.template_params);
      } else {
        result = await this.provider.sendText(config, row.to_number, payload.text ?? '');
      }
      if (result.success) {
        await this.db.execute("UPDATE whatsapp_outbound_queue SET status='Sent', provider_message_id=?, sent_at=NOW() WHERE id=?", [result.provider_message_id, row.id]);
        sent++;
      } else {
        const retryCount = Number(row.retry_count) + 1;
        const permanent = retryCount >= Number(row.max_retries);
        // PHP: date('Y-m-d H:i:s', time() + 5*60*n²) in APP_TIMEZONE, compared against the DB's NOW() (see docs/PARITY.md).
        const next = permanent ? null : datetimeIn(this.opts.timezone, this.now() + 5 * 60 * retryCount * retryCount * 1000);
        await this.db.execute("UPDATE whatsapp_outbound_queue SET status='Failed', retry_count=?, next_attempt_at=?, error_message=? WHERE id=?", [retryCount, next, result.error, row.id]);
        failed++;
      }
      await this.logNotification(
        "INSERT INTO notification_logs (customer_id, order_id, template_key, channel, recipient, message, status, provider, provider_message_id, error_message) VALUES (?,?,?,'WhatsApp',?,?,?, 'meta', ?, ?)",
        [row.customer_id, row.order_id, row.template_key, row.to_number, payload.text ?? '', result.success ? 'Sent' : 'Failed', result.provider_message_id ?? null, result.success ? null : result.error],
        'processQueueBatch');
    }
    return { processed, sent, failed, error: null };
  }

  async maybeNotifyOrderReady(orderId: number): Promise<void> {
    try {
      const c = (await this.db.query<Row>("SELECT COUNT(*) AS total, SUM(item_status IN ('Ready','Packed')) AS ready_or_further FROM order_items WHERE order_id = ?", [orderId]))[0];
      if (!c || Number(c.total) === 0 || Number(c.total) !== Number(c.ready_or_further)) return;
      const o = (await this.db.query<Row>('SELECT COALESCE(o.short_order_code, o.order_number) AS order_number, o.grand_total, c.id AS customer_id, c.full_name, c.mobile FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]))[0];
      if (!o || phpEmpty(o.mobile)) return;
      await this.enqueue(Number(o.customer_id), orderId, o.mobile, 'order_ready',
        { customer_name: o.full_name, order_number: o.order_number, business_name: await this.businessName() }, `order_ready:${orderId}`);
    } catch (e) {
      this.log(`WhatsAppService::maybeNotifyOrderReady failed: ${(e as Error).message}`);
    }
  }

  async notifyWorkshopCompleted(workshopItemId: number): Promise<void> {
    try {
      const r = (await this.db.query<Row>(
        `SELECT o.id AS order_id, COALESCE(o.short_order_code, o.order_number) AS order_number, c.id AS customer_id, c.full_name, c.mobile
         FROM workshop_items wi
         LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id
         LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id
         LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id
         JOIN orders o ON o.id = COALESCE(oi1.order_id, oi2.order_id)
         JOIN customers c ON c.id = o.customer_id
         WHERE wi.id = ?`, [workshopItemId]))[0];
      if (!r || phpEmpty(r.mobile)) return;
      await this.enqueue(Number(r.customer_id), Number(r.order_id), r.mobile, 'workshop_completed',
        { customer_name: r.full_name, order_number: r.order_number, business_name: await this.businessName() }, `workshop_completed:${r.order_id}`);
    } catch (e) {
      this.log(`WhatsAppService::notifyWorkshopCompleted failed: ${(e as Error).message}`);
    }
  }

  async sendMediaMessage(customerId: number, toNumber: string, localFilePath: string, mimeType: string, mediaType: string, caption: string, userId: number | null): Promise<{ success: boolean; error?: string | null; provider_message_id?: string | null }> {
    toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
    const account = await this.resolveAccountForStore(null);
    if (!account) return { success: false, error: 'No WhatsApp account is configured.' };
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return { success: false, error: 'Could not read the stored credentials for this account.' }; }
    const up = await this.provider.uploadMedia(config, localFilePath, mimeType);
    if (!up.success) return { success: false, error: `Media upload failed: ${up.error}` };
    const result = await this.provider.sendMedia(config, toNumber, up.media_id ?? '', mediaType, caption);
    // Keep a copy of what we sent so the chat (app + web) can show it again like WhatsApp does.
    const keptRef = result.success ? await this.keepOutboundMedia(localFilePath) : null;
    await this.logNotification(
      "INSERT INTO notification_logs (customer_id, user_id, template_key, channel, recipient, message, status, error_message) VALUES (?, ?, 'media_send', 'WhatsApp', ?, ?, ?, ?)",
      [customerId || null, userId, toNumber, `[${mediaType}] ${caption}`, result.success ? 'Sent' : 'Failed', result.success ? null : result.error], 'sendMediaMessage');
    await this.logOutboundMessage(toNumber, mediaType, `[${mediaType}] ${caption}`, keptRef, result.provider_message_id ?? null, result.success ? 'sent' : 'failed');
    return result;
  }

  /** Folder for the copies of media WE sent and the cache of customer media fetched from Meta (never under the public /uploads root). */
  private mediaRoot(): string { return this.opts.mediaDir ?? join(process.cwd(), 'whatsapp_media'); }
  private outboundDir() { return join(this.mediaRoot(), 'out'); }
  private inboundDir() { return join(this.mediaRoot(), 'in'); }

  /** Copies a just-sent local file into the outbound store; returns the 'local:<name>' reference or null. */
  private async keepOutboundMedia(localFilePath: string): Promise<string | null> {
    const ext = extname(localFilePath).slice(1).toLowerCase();
    if (!['jpg', 'png', 'pdf'].includes(ext)) return null;
    try {
      await mkdir(this.outboundDir(), { recursive: true });
      const name = `${randomBytes(16).toString('hex')}.${ext}`;
      await copyFile(localFilePath, join(this.outboundDir(), name));
      return `local:${name}`;
    } catch { return null; }
  }

  /**
   * Staff attachment from a chat thread (web + mobile): validates a just-uploaded file (real type by content, 10 MB cap;
   * JPEG/PNG/PDF only), stores it briefly, sends it through sendMediaMessage() and removes the local copy.
   * `file` is null/empty when nothing valid was chosen. Free-form media only delivers inside WhatsApp's 24h reply window.
   */
  async sendUploadedAttachment(customerId: number, toNumber: string, file: { buffer: Buffer } | null, caption: string, userId: number | null): Promise<{ success: boolean; error?: string | null; provider_message_id?: string | null }> {
    if (!file || file.buffer.length === 0) return { success: false, error: 'Select a valid file.' };
    if (file.buffer.length > 10 * 1024 * 1024) return { success: false, error: 'File is too large (max 10 MB).' };
    const head = file.buffer.subarray(0, 16);
    const kind = sniffImage(head);
    let realMime: string | null = kind === 'jpg' ? 'image/jpeg' : kind === 'png' ? 'image/png' : null;
    if (!realMime && file.buffer.subarray(0, 5).toString('latin1') === '%PDF-') realMime = 'application/pdf';
    if (!realMime) {
      const detected = kind === 'webp' ? 'image/webp' : kind === 'gif' ? 'image/gif' : 'application/octet-stream';
      return { success: false, error: `File type not allowed (detected: ${detected}). Only JPEG/PNG images and PDF documents are supported.` };
    }
    const [mediaType, ext] = realMime === 'application/pdf' ? ['document', 'pdf'] : realMime === 'image/png' ? ['image', 'png'] : ['image', 'jpg'];
    const dir = join(this.mediaRoot(), 'tmp');
    await mkdir(dir, { recursive: true });
    const dest = join(dir, `${randomBytes(16).toString('hex')}.${ext}`);
    try { await writeFile(dest, file.buffer, { mode: 0o640 }); } catch { return { success: false, error: 'Could not store the uploaded file.' }; }
    try {
      return await this.sendMediaMessage(customerId, toNumber, dest, realMime, mediaType!, Array.from(caption).slice(0, 1000).join(''), userId);
    } finally { await unlink(dest).catch(() => {}); }
  }

  async sendTemplateNow(toNumber: string, templateName: string, language: string, params: string[], logKey: string, userId: number | null, logText: string): Promise<{ success: boolean; error?: string | null }> {
    toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
    let result: { success: boolean; error?: string | null };
    const account = await this.resolveAccountForStore(null);
    if (!account) result = { success: false, error: 'No WhatsApp account is configured.' };
    else {
      try {
        result = await this.provider.sendTemplate(this.decryptAccountConfig(account), toNumber, templateName, language, [...params]);
      } catch {
        result = { success: false, error: 'Could not read the stored credentials for this account.' };
      }
    }
    await this.logNotification(
      "INSERT INTO notification_logs (customer_id, user_id, template_key, channel, recipient, message, status, error_message) VALUES (NULL, ?, ?, 'WhatsApp', ?, ?, ?, ?)",
      [userId, logKey, toNumber, logText, result.success ? 'Sent' : 'Failed', result.success ? null : mbSubstr255(phpStr(result.error))], 'sendTemplateNow');
    return result;
  }

  async sendInvoice(orderId: number, userId: number | null): Promise<{ success: boolean; mode: string | null; error: string | null; code: string | null }> {
    const fail = (error: string, code: string) => ({ success: false, mode: null, error, code });
    const order = (await this.db.query<Row>(
      `SELECT o.id, o.customer_id, o.store_id, o.order_number, o.short_order_code, o.invoice_number, o.grand_total, o.total_paid, o.current_due, o.due_date, c.full_name, c.mobile
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, [orderId]))[0];
    if (!order) return fail('Order not found.', 'not_found');
    if (phpStr(order.mobile).trim() === '') return fail('This customer has no mobile number on file.', 'no_mobile');
    const account = await this.resolveAccountForStore(order.store_id ? Number(order.store_id) : null);
    if (!account) return fail('No WhatsApp account is configured.', 'not_configured');
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return fail('Could not read the stored credentials for this account.', 'not_configured'); }
    if (!this.opts.invoicePdf) return fail('Could not generate the invoice PDF.', 'pdf_failed');
    const pdf = await this.opts.invoicePdf.generate(orderId);
    if (!pdf.success || !pdf.file_path) return fail(pdf.error ?? 'Could not generate the invoice PDF.', 'pdf_failed');

    const number = phpStr(phpEmpty(order.invoice_number) ? (order.short_order_code ?? order.order_number) : order.invoice_number);
    const filename = `Invoice-${number.replace(/[^A-Za-z0-9_-]+/g, '-')}.pdf`;
    const upload = await this.provider.uploadMedia(config, pdf.file_path, 'application/pdf');
    await unlink(pdf.file_path).catch(() => {});
    const toNumber = WhatsAppService.normalizePhoneNumber(phpStr(order.mobile));
    let mode: string | null = null;
    let result: SendResult;
    if (!upload.success) {
      result = { success: false, provider_message_id: null, error: `Media upload failed: ${upload.error}` };
    } else {
      const template = (await this.db.query<Row>("SELECT * FROM notification_templates WHERE template_key = 'invoice' AND channel = 'WhatsApp' AND is_active = 1 LIMIT 1"))[0];
      const name = phpStr(order.full_name).trim();
      const values: Record<string, string> = {
        customer_name: name === '' || name === '0' ? 'Customer' : name,
        invoice_number: number,
        order_number: phpStr(order.short_order_code ?? order.order_number),
        grand_total: numberFormat2(Number(order.grand_total)),
        total_paid: numberFormat2(Number(order.total_paid)),
        current_due: numberFormat2(Math.max(0, Number(order.current_due))),
        due_date: order.due_date ? dMonY(String(order.due_date)) : '-',
      };
      let paramOrder: unknown[] = [];
      if (template) { try { const p = JSON.parse(phpStr(template.template_param_order)); if (Array.isArray(p)) paramOrder = p; } catch { /* [] */ } }
      if (template && !phpEmpty(template.provider_template_name) && paramOrder.length > 0) {
        mode = 'template';
        const params = paramOrder.map((k) => {
          const v = (values[String(k)] ?? '').replace(/\s+/g, ' ');
          return v === '' || v === '0' ? '-' : v;
        });
        result = await this.provider.sendTemplate(config, toNumber, template.provider_template_name, phpEmpty(template.language) ? 'en' : template.language, params, { id: upload.media_id ?? '', filename });
      } else {
        mode = 'free_form';
        result = await this.provider.sendMedia(config, toNumber, upload.media_id ?? '', 'document', `Invoice ${number}`);
      }
    }
    await this.logNotification(
      "INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, recipient, message, status, provider, provider_message_id, error_message) VALUES (?, ?, ?, 'invoice', 'WhatsApp', ?, ?, ?, 'meta', ?, ?)",
      [order.customer_id, orderId, userId, toNumber, `[document] Invoice ${number}${mode ? ` (${mode})` : ''}`, result.success ? 'Sent' : 'Failed', result.provider_message_id ?? null, result.success ? null : mbSubstr255(phpStr(result.error))],
      'sendInvoice');
    await this.logOutboundMessage(toNumber, 'document', `[document] Invoice ${number}`, null, result.provider_message_id ?? null, result.success ? 'sent' : 'failed');
    return { success: result.success, mode, error: result.success ? null : result.error, code: result.success ? null : 'send_failed' };
  }

  // ---- document sends: challan + workshop invoice -------------------------------------------------
  private cleanParams(paramOrder: unknown[], values: Record<string, string>): string[] {
    // Meta refuses empty parameters and line breaks inside them.
    return paramOrder.map((k) => { const v = (values[String(k)] ?? '').replace(/\s+/g, ' '); return v === '' || v === '0' ? '-' : v; });
  }
  private async activeTemplate(key: string): Promise<{ template: Row | undefined; paramOrder: unknown[] }> {
    const template = (await this.db.query<Row>("SELECT * FROM notification_templates WHERE template_key = ? AND channel = 'WhatsApp' AND is_active = 1 LIMIT 1", [key]))[0];
    let paramOrder: unknown[] = [];
    if (template) { try { const p = JSON.parse(phpStr(template.template_param_order)); if (Array.isArray(p)) paramOrder = p; } catch { /* [] */ } }
    return { template, paramOrder };
  }
  /** date('d/m/Y', strtotime($d)) for a stored 'YYYY-MM-DD[ ...]' value. */
  private static dmySlash(d: unknown): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(phpStr(d));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : phpStr(d);
  }

  /**
   * Sends an already-generated challan (one OR several orders) as a PDF to WHATEVER number is given -- a challan routinely goes to someone
   * other than the customer (branch, accountant, driver). Account + logged customer/order = the FIRST order.
   */
  async sendChallan(orderIdsIn: number[], toNumberIn: string, withAmount: boolean, challanNumber: string, userId: number | null, combineFormat = 'aggregated'): Promise<{ success: boolean; mode: string | null; error: string | null; code: string | null }> {
    const fail = (error: string, code: string) => ({ success: false, mode: null, error, code });
    const orderIds = [...new Set(orderIdsIn.map((x) => Math.trunc(Number(x)) || 0))];
    if (!orderIds.length) return fail('No orders given.', 'not_found');
    const ip = orderIds.map(() => '?').join(',');
    const orders = await this.db.query<Row>(`SELECT o.id, o.customer_id, o.store_id, o.order_number, o.short_order_code, o.grand_total FROM orders o WHERE o.id IN (${ip}) ORDER BY FIELD(o.id, ${ip})`, [...orderIds, ...orderIds]);
    if (!orders.length) return fail('Order(s) not found.', 'not_found');
    const primary = orders[0]!;
    const toNumber = WhatsAppService.normalizePhoneNumber(toNumberIn);
    if (toNumber === '') return fail('Enter a valid mobile number.', 'no_mobile');
    const account = await this.resolveAccountForStore(primary.store_id ? Number(primary.store_id) : null);
    if (!account) return fail('No WhatsApp account is configured.', 'not_configured');
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return fail('Could not read the stored credentials for this account.', 'not_configured'); }
    if (!this.opts.challanPdf) return fail('Could not generate the challan PDF.', 'pdf_failed');
    const pdf = await this.opts.challanPdf.generate(orderIds, withAmount, challanNumber, combineFormat);
    if (!pdf.success || !pdf.file_path) return fail(pdf.error ?? 'Could not generate the challan PDF.', 'pdf_failed');
    const filename = 'Challan-' + challanNumber.replace(/[^A-Za-z0-9_-]+/g, '-') + '.pdf';
    const upload = await this.provider.uploadMedia(config, pdf.file_path, 'application/pdf');
    await unlink(pdf.file_path).catch(() => {});

    let mode: string | null = null;
    let result: SendResult;
    if (!upload.success) {
      result = { success: false, provider_message_id: null, error: `Media upload failed: ${upload.error}` };
    } else {
      const { template, paramOrder } = await this.activeTemplate('challan_document');
      const values: Record<string, string> = {
        order_number: orders.map((o) => phpStr(phpEmpty(o.short_order_code) ? o.order_number : o.short_order_code)).join(', '),
        challan_number: challanNumber,
        grand_total: numberFormat2(orders.reduce((a, o) => a + (parseFloat(phpStr(o.grand_total)) || 0), 0)),
      };
      if (template && !phpEmpty(template.provider_template_name) && paramOrder.length > 0) {
        mode = 'template';
        result = await this.provider.sendTemplate(config, toNumber, template.provider_template_name, phpEmpty(template.language) ? 'en' : template.language, this.cleanParams(paramOrder, values), { id: upload.media_id ?? '', filename });
      } else {
        // The new Meta template needs its own approval (often 24+ hours): this free-form fallback is what sends the PDF meanwhile.
        mode = 'free_form';
        result = await this.provider.sendMedia(config, toNumber, upload.media_id ?? '', 'document', `Challan ${challanNumber}`);
      }
    }
    await this.logNotification(
      "INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, recipient, message, status, provider, provider_message_id, error_message) VALUES (?, ?, ?, 'challan_document', 'WhatsApp', ?, ?, ?, 'meta', ?, ?)",
      [primary.customer_id, primary.id, userId, toNumber, `[document] Challan ${challanNumber}${mode ? ` (${mode})` : ''}`, result.success ? 'Sent' : 'Failed', result.provider_message_id ?? null, result.success ? null : mbSubstr255(phpStr(result.error))], 'sendChallan');
    await this.logOutboundMessage(toNumber, 'document', `[document] Challan ${challanNumber}`, null, result.provider_message_id ?? null, result.success ? 'sent' : 'failed');
    return { success: result.success, mode, error: result.success ? null : result.error, code: result.success ? null : 'send_failed' };
  }

  /** Submits the "challan_document" template to Meta for review (sample = a real challan PDF). Never switches sending to template mode itself. */
  async submitChallanTemplate(): Promise<{ success: boolean; status?: string | null; error: string | null }> {
    const account = await this.resolveAccountForStore(null);
    if (!account) return { success: false, error: 'No WhatsApp account is configured.' };
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return { success: false, error: 'Could not read the stored credentials for this account.' }; }
    if (phpEmpty(config.waba_id)) return { success: false, error: 'No WABA ID saved for this account yet -- add it in Admin > WhatsApp Settings first (Meta Business Settings > WhatsApp Accounts shows it).' };
    const sampleOrderId = Number((await this.db.query<Row>('SELECT id FROM orders ORDER BY id DESC LIMIT 1'))[0]?.id ?? 0);
    const pdf = sampleOrderId && this.opts.challanPdf ? await this.opts.challanPdf.generate([sampleOrderId], true, 'UDC-CH-000001') : { success: false, file_path: null, error: null };
    if (!pdf.success || !pdf.file_path) return { success: false, error: 'Could not generate a sample challan PDF for the template example (need at least one order on this system).' };
    const template = (await this.db.query<Row>("SELECT * FROM notification_templates WHERE template_key = 'challan_document' AND channel = 'WhatsApp' LIMIT 1"))[0];
    const bodyText = template ? phpStr(template.body).split('{challan_number}').join('{{1}}').split('{order_number}').join('{{2}}').split('{grand_total}').join('{{3}}') : 'Hello, please find the challan {{1}} for order {{2}} attached. Total amount: Rs.{{3}}.';
    const result = await this.provider.createDocumentTemplate(config, 'challan_document', 'en', 'UTILITY', bodyText, ['UDC-CH-000001', 'A0005', '1500.00'], pdf.file_path, 'application/pdf');
    await unlink(pdf.file_path).catch(() => {});
    return result;
  }

  /** Sends a WORKSHOP invoice (workshop_bills row) as a PDF document: approved template 'workshop_invoice_document' when set, else a free-form document message. */
  async sendWorkshopInvoice(billId: number, toNumberIn: string, userId: number | null): Promise<{ success: boolean; mode: string | null; error: string | null; code: string | null }> {
    const fail = (error: string, code: string) => ({ success: false, mode: null, error, code });
    const bill = (await this.db.query<Row>('SELECT wb.id, wb.bill_number, wb.grand_total, wb.due_date, wb.status, wb.snapshot_json, wb.is_combined, s.store_name FROM workshop_bills wb LEFT JOIN stores s ON s.id = wb.store_id WHERE wb.id = ?', [billId]))[0];
    if (!bill) return fail('Invoice not found.', 'not_found');
    if (bill.status === 'Void') return fail('This invoice is void and cannot be sent.', 'void');
    const toNumber = WhatsAppService.normalizePhoneNumber(toNumberIn);
    if (toNumber === '') return fail('Enter a valid mobile number.', 'no_mobile');
    const account = await this.resolveAccountForStore(null);
    if (!account) return fail('No WhatsApp account is configured.', 'not_configured');
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return fail('Could not read the stored credentials for this account.', 'not_configured'); }
    if (!this.opts.workshopBillPdf) return fail('Could not generate the invoice PDF.', 'pdf_failed');
    const pdf = await this.opts.workshopBillPdf.generate(billId);
    if (!pdf.success || !pdf.file_path) return fail(pdf.error ?? 'Could not generate the invoice PDF.', 'pdf_failed');
    const upload = await this.provider.uploadMedia(config, pdf.file_path, 'application/pdf');
    await unlink(pdf.file_path).catch(() => {});

    let snap: Row = {};
    try { snap = JSON.parse(phpStr(bill.snapshot_json)) || {}; } catch { snap = {}; }
    const billTo = phpStr(snap.bill_to ?? (Number(bill.is_combined) ? 'All stores' : bill.store_name));
    let mode: string | null = null;
    let result: SendResult;
    const values: Record<string, string> = {
      bill_number: phpStr(bill.bill_number), bill_to: billTo, grand_total: numberFormat2(parseFloat(phpStr(bill.grand_total)) || 0),
      due_date: bill.due_date ? WhatsAppService.dmySlash(bill.due_date) : '-',
    };
    if (!upload.success) {
      result = { success: false, provider_message_id: null, error: `Media upload failed: ${upload.error}` };
    } else {
      const { template, paramOrder } = await this.activeTemplate('workshop_invoice_document');
      if (template && !phpEmpty(template.provider_template_name) && paramOrder.length > 0) {
        mode = 'template';
        result = await this.provider.sendTemplate(config, toNumber, template.provider_template_name, phpEmpty(template.language) ? 'en' : template.language, this.cleanParams(paramOrder, values), { id: upload.media_id ?? '', filename: pdf.filename ?? undefined });
      } else {
        mode = 'free_form';
        result = await this.provider.sendMedia(config, toNumber, upload.media_id ?? '', 'document', `Invoice ${bill.bill_number} - Rs.${values.grand_total}`);
      }
    }
    await this.logNotification(
      "INSERT INTO notification_logs (customer_id, user_id, template_key, channel, recipient, message, status, provider, provider_message_id, error_message) VALUES (NULL, ?, 'workshop_invoice_document', 'WhatsApp', ?, ?, ?, 'meta', ?, ?)",
      [userId, toNumber, `[document] Workshop invoice ${bill.bill_number}${mode ? ` (${mode})` : ''}`, result.success ? 'Sent' : 'Failed', result.provider_message_id ?? null, result.success ? null : mbSubstr255(phpStr(result.error))], 'sendWorkshopInvoice');
    await this.logOutboundMessage(toNumber, 'document', `[document] Workshop invoice ${bill.bill_number}`, null, result.provider_message_id ?? null, result.success ? 'sent' : 'failed');
    return { success: result.success, mode, error: result.success ? null : result.error, code: result.success ? null : 'send_failed' };
  }

  /** Submits the "workshop_invoice_document" template (PDF header + 4 body values) to Meta for review; our own row stays free-form until Meta approves. */
  async submitWorkshopInvoiceTemplate(): Promise<{ success: boolean; status?: string | null; error: string | null }> {
    const account = await this.resolveAccountForStore(null);
    if (!account) return { success: false, error: 'No WhatsApp account is configured.' };
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return { success: false, error: 'Could not read the stored credentials for this account.' }; }
    if (phpEmpty(config.waba_id)) return { success: false, error: 'No WABA ID saved for this account yet.' };
    const billId = Number((await this.db.query<Row>("SELECT id FROM workshop_bills WHERE status <> 'Void' ORDER BY id DESC LIMIT 1"))[0]?.id ?? 0);
    if (!billId) return { success: false, error: 'Need at least one workshop invoice on the system to use as the template sample.' };
    const pdf = this.opts.workshopBillPdf ? await this.opts.workshopBillPdf.generate(billId) : { success: false, file_path: null, error: null };
    if (!pdf.success || !pdf.file_path) return { success: false, error: pdf.error ?? 'Could not generate the sample PDF.' };
    const bodyText = 'Hello, please find workshop invoice {{1}} for {{2}} attached.\nAmount payable: Rs.{{3}}. Due date: {{4}}.\nThank you.';
    const result = await this.provider.createDocumentTemplate(config, 'workshop_invoice_document', 'en', 'UTILITY', bodyText, ['DW-00001', 'Main Branch', '4,750.00', '30/11/2026'], pdf.file_path, 'application/pdf');
    await unlink(pdf.file_path).catch(() => {});
    // Our own row: active, params in order, but provider_template_name stays NULL until Meta approves.
    try {
      const exists = (await this.db.query<Row>("SELECT id FROM notification_templates WHERE template_key = 'workshop_invoice_document' AND channel = 'WhatsApp' LIMIT 1"))[0];
      if (!exists) {
        await this.db.execute("INSERT INTO notification_templates (template_key, channel, subject, body, provider_template_name, language, template_param_order, is_active) VALUES ('workshop_invoice_document', 'WhatsApp', NULL, ?, NULL, 'en', ?, 1)",
          [bodyText.replace('{{1}}', '{bill_number}').replace('{{2}}', '{bill_to}').replace('{{3}}', '{grand_total}').replace('{{4}}', '{due_date}'), JSON.stringify(['bill_number', 'bill_to', 'grand_total', 'due_date'])]);
      }
    } catch (e) { this.log(`submitWorkshopInvoiceTemplate row insert failed: ${(e as Error).message}`); }
    return result;
  }

  // ---- bulk messaging + self-service Meta templates (Rahul, 21 Nov 2026) ---------------------------------
  /** Creates a text template in the CRM AND submits it to Meta for approval. {customer_name}/{business_name} become Meta's {{1}}, {{2}}... in order. */
  async createBulkTemplate(labelIn: string, categoryIn: string, bodyIn: string, language = 'en'): Promise<{ success: boolean; error: string | null; template_id?: number; status?: string }> {
    const label = labelIn.trim(), body = bodyIn.trim();
    const category = categoryIn.toUpperCase() === 'UTILITY' ? 'UTILITY' : 'MARKETING';
    if (label === '' || Array.from(label).length > 60) return { success: false, error: 'Template ka naam zaroori hai (max 60 akshar).' };
    if (body === '' || Array.from(body).length > 1000) return { success: false, error: 'Message 1 se 1000 akshar ka hona chahiye.' };
    const order: string[] = []; const examples: string[] = []; let unknown = false;
    const businessName = phpStr(await getSetting(this.db, 'business_name', BULK_VARIABLES.business_name));
    const metaBody = body.replace(/\{(\w+)\}/g, (m0, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(BULK_VARIABLES, name)) { unknown = true; return m0; }
      order.push(name);
      examples.push(name === 'business_name' ? businessName : BULK_VARIABLES[name]!);
      return `{{${order.length}}}`;
    });
    if (unknown) return { success: false, error: 'Sirf {customer_name} aur {business_name} variables allowed hain.' };
    if (/^\{\{\d+\}\}/.test(metaBody) || /\{\{\d+\}\}\s*$/.test(metaBody)) {
      return { success: false, error: 'Meta ke rule ke hisaab se message variable se shuru ya khatam nahi ho sakta - pehle/baad mein kuch text likhein (jaise "Namaste {customer_name}, ... Dhanyavaad").' };
    }
    if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(metaBody)) return { success: false, error: 'Do variables ek ke baad ek (bina text ke) nahi rakh sakte.' };

    const account = await this.resolveAccountForStore(null);
    if (!account) return { success: false, error: 'WhatsApp account configure nahi hai (Settings).' };
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return { success: false, error: 'Account ke credentials padh nahi paye.' }; }

    // Meta name: lowercase letters/digits/underscore, unique -- slug of the label + short suffix.
    let slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (slug === '') slug = 'message';
    const name = 'udc_' + slug.slice(0, 40) + '_' + randomBytes(3).toString('hex').slice(0, 5);

    const result = await this.provider.createTextTemplate(config, name, language, category, metaBody, examples);
    if (!result.success) return { success: false, error: 'Meta ne template accept nahi kiya: ' + result.error };
    const status = result.status ?? 'PENDING';
    const ins = await this.db.execute(
      "INSERT INTO notification_templates (template_key, channel, subject, body, provider_template_name, language, template_param_order, is_active, meta_status, meta_template_id, category) VALUES (?, 'WhatsApp', ?, ?, ?, ?, ?, 1, ?, ?, ?)",
      [name, label, body, status === 'APPROVED' ? name : null, language, JSON.stringify(order), status, result.id ?? null, category]);
    return { success: true, error: null, template_id: ins.insertId, status };
  }

  /** Pulls review statuses from Meta and updates our rows (matched by template name); APPROVED switches provider_template_name on. */
  async syncTemplateStatuses(): Promise<{ success: boolean; error: string | null; updated: number }> {
    const account = await this.resolveAccountForStore(null);
    if (!account) return { success: false, error: 'WhatsApp account configure nahi hai.', updated: 0 };
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return { success: false, error: 'Account ke credentials padh nahi paye.', updated: 0 }; }
    const res = await this.provider.listTemplateStatuses(config);
    if (!res.success) return { success: false, error: res.error, updated: 0 };
    let updated = 0;
    const rows = await this.db.query<Row>("SELECT id, template_key, provider_template_name, template_param_order, meta_status FROM notification_templates WHERE channel = 'WhatsApp'");
    for (const r of rows) {
      const name = !phpEmpty(r.provider_template_name) ? String(r.provider_template_name) : String(r.template_key);
      const t = res.templates[name];
      if (!t) continue;
      const status = phpStr(t.status);
      if (status === '') continue;
      let providerName: string | null = r.provider_template_name ?? null;
      if (status === 'APPROVED' && phpEmpty(providerName) && !phpEmpty(r.template_param_order)) providerName = name;
      if (['REJECTED', 'DISABLED', 'PAUSED'].includes(status) && r.meta_status !== null && r.template_key === name) providerName = null;
      if (status !== r.meta_status || providerName !== (r.provider_template_name ?? null)) {
        await this.db.execute('UPDATE notification_templates SET meta_status = ?, meta_template_id = COALESCE(?, meta_template_id), meta_reject_reason = ?, provider_template_name = ? WHERE id = ?',
          [status, t.id, status === 'REJECTED' ? mbSubstr255(phpStr(t.reason)) : null, providerName, r.id]);
        updated++;
      }
    }
    return { success: true, error: null, updated };
  }

  /** Bulk send: queues one template message per recipient (the cron worker sends them); only WhatsApp opt-in customers; the template must be Meta-approved. */
  async startBulkCampaign(nameIn: string, templateId: number, segmentKey: string | null, customerIds: number[], storeId: number | null, userId: number): Promise<{ success: boolean; error: string | null; queued?: number; skipped?: number; no_optin?: number; campaign_id?: number | null }> {
    const name = nameIn.trim();
    if (name === '') return { success: false, error: 'Campaign ka naam likhein.' };
    const template = (await this.db.query<Row>("SELECT * FROM notification_templates WHERE id = ? AND channel = 'WhatsApp' AND is_active = 1", [templateId]))[0];
    if (!template) return { success: false, error: 'Template nahi mila.' };
    if (phpEmpty(template.category)) return { success: false, error: 'Ye template bulk ke liye nahi hai (system template).' };
    if (phpEmpty(template.provider_template_name)) {
      return { success: false, error: `Ye template abhi Meta se approve nahi hua (status: ${phpEmpty(template.meta_status) ? 'unknown' : template.meta_status}). Approve hone ke baad hi bulk bhej sakte hain.` };
    }
    const recipients = new Map<number, Row>();
    if (segmentKey) {
      if (!Object.prototype.hasOwnProperty.call(CustomerSegments.available, segmentKey)) return { success: false, error: 'Segment galat hai.' };
      for (const r of await new CustomerSegments(this.db).resolve(segmentKey, storeId)) recipients.set(Number(r.id), r);
    }
    let noOptin = 0;
    const ids = [...new Set(customerIds.map((x) => Math.trunc(Number(x)) || 0).filter((x) => x !== 0))];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      for (const c of await this.db.query<Row>(`SELECT id, full_name, mobile, communication_preference FROM customers WHERE id IN (${ph}) AND is_active = 1`, ids)) {
        if (phpStr(c.communication_preference) !== 'WhatsApp' || phpEmpty(c.mobile)) { noOptin++; continue; }
        recipients.set(Number(c.id), c);
      }
    }
    if (!recipients.size) return { success: false, error: 'Koi eligible customer nahi mila (WhatsApp opt-in wale customers hi jaate hain).', no_optin: noOptin };
    const account = await this.resolveAccountForStore(storeId);
    if (!account) return { success: false, error: 'WhatsApp account configure nahi hai.' };

    let campaignId: number | null = null;
    try {
      const ins = await this.db.execute("INSERT INTO whatsapp_campaigns (campaign_name, segment_key, template_id, store_id, account_id, status, recipient_count, created_by) VALUES (?,?,?,?,?, 'Sending', ?, ?)",
        [name, segmentKey || 'manual', templateId, storeId, account.id, recipients.size, userId]);
      campaignId = ins.insertId;
    } catch { /* campaign history optional; queueing still works */ }

    let queued = 0, skipped = 0;
    const biz = phpStr(await getSetting(this.db, 'business_name', this.opts.appName));
    for (const [cid, r] of recipients) {
      const res = await this.enqueue(cid, null, phpStr(r.mobile), template.template_key, { customer_name: phpStr(r.full_name), business_name: biz }, `campaign:${campaignId ?? 'none'}:customer:${cid}`, campaignId);
      if (res.success && !res.duplicate) queued++; else skipped++;
    }
    return { success: true, error: null, queued, skipped, no_optin: noOptin, campaign_id: campaignId };
  }

  // ---- two-way message log (whatsapp_messages) ---------------------------------------------------------
  /** Best-effort match to an existing customer by phone: exact `mobile`, then the last 10 digits. */
  private async matchCustomerByPhone(phoneNumber: string): Promise<number | null> {
    const a = (await this.db.query<Row>('SELECT id FROM customers WHERE mobile = ? LIMIT 1', [phoneNumber]))[0];
    if (a?.id) return Number(a.id);
    const last10 = phoneNumber.replace(/\D+/g, '').slice(-10);
    if (last10.length < 10) return null;
    const b = (await this.db.query<Row>("SELECT id FROM customers WHERE RIGHT(REGEXP_REPLACE(mobile, '[^0-9]', ''), 10) = ? LIMIT 1", [last10]))[0];
    return b?.id ? Number(b.id) : null;
  }

  /** Records a send in the conversation log. messageText is a short human-readable description (e.g. "[document] Invoice A0099"). */
  async logOutboundMessage(toNumber: string, messageType: string, messageText: string | null, mediaUrl: string | null, providerMessageId: string | null, status: string): Promise<void> {
    try {
      const customerId = await this.matchCustomerByPhone(toNumber);
      await this.db.execute("INSERT INTO whatsapp_messages (phone_number, customer_id, direction, message_type, message_text, media_url, provider_message_id, status) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?)",
        [toNumber, customerId, messageType, messageText, mediaUrl, providerMessageId, status]);
    } catch (e) { this.log(`WhatsAppService::logOutboundMessage failed: ${(e as Error).message}`); }
  }

  /** Meta's webhook verification handshake: the echoed token must match the generated setting. */
  async verifyWebhookToken(token: string): Promise<boolean> {
    const expected = phpStr(await getSetting(this.db, 'whatsapp_webhook_verify_token', ''));
    const a = Buffer.from(expected), b = Buffer.from(token);
    return expected !== '' && a.length === b.length && timingSafeEqual(a, b);
  }

  /** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, app_secret). */
  async verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): Promise<boolean> {
    const account = await this.resolveAccountForStore(null);
    if (!account) return false;
    let config: WaConfig;
    try { config = this.decryptAccountConfig(account); } catch { return false; }
    if (phpEmpty(config.app_secret)) return false;
    const expected = Buffer.from('sha256=' + createHmac('sha256', config.app_secret!).update(rawBody).digest('hex'));
    const got = Buffer.from(signatureHeader);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /** A new incoming message from a customer; mediaId is Meta's own media id (fetched lazily, see inboundMedia). */
  async logInboundMessage(fromNumber: string, messageType: string, messageText: string | null, mediaId: string | null, providerMessageId: string): Promise<void> {
    try {
      const customerId = await this.matchCustomerByPhone(fromNumber);
      await this.db.execute("INSERT INTO whatsapp_messages (phone_number, customer_id, direction, message_type, message_text, media_url, provider_message_id, status) VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'received')",
        [fromNumber, customerId, messageType, messageText, mediaId, providerMessageId]);
    } catch (e) { this.log(`WhatsAppService::logInboundMessage failed: ${(e as Error).message}`); }
  }

  /** A WhatsApp Business CALL event ("calls" webhook field): one row per call id, updated in place. Returns the staff-push summary when one should go out. */
  async logCallEvent(call: Row): Promise<{ phone: string; title: string; body: string } | null> {
    const callId = phpStr(call.id);
    const event = phpStr(call.event).toLowerCase();
    if (callId === '') return null;
    const incoming = (phpEmpty(call.direction) ? 'USER_INITIATED' : phpStr(call.direction)).toUpperCase() !== 'BUSINESS_INITIATED';
    const phone = phpStr(incoming ? call.from : call.to).replace(/\D+/g, '');
    if (phone === '') return null;
    try {
      const rowId = Number((await this.db.query<Row>("SELECT id FROM whatsapp_messages WHERE message_type = 'call' AND provider_message_id = ? LIMIT 1", [callId]))[0]?.id ?? 0);
      let text: string;
      if (event === 'terminate') {
        const status = phpStr(call.status).toUpperCase();
        const duration = Math.trunc(Number(call.duration ?? 0)) || 0;
        if (duration > 0 && status !== 'FAILED') text = '📞 WhatsApp call · ' + `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
        else text = incoming ? '📵 Missed WhatsApp call' : '📵 WhatsApp call not answered';
      } else {
        text = incoming ? '📞 Incoming WhatsApp call…' : '📞 Calling on WhatsApp…';
      }
      const label = text;
      if (rowId) {
        await this.db.execute('UPDATE whatsapp_messages SET message_text = ?, status = ? WHERE id = ?', [text, event === 'terminate' ? 'ended' : 'ringing', rowId]);
      } else {
        await this.db.execute("INSERT INTO whatsapp_messages (phone_number, customer_id, direction, message_type, message_text, provider_message_id, status) VALUES (?, ?, ?, 'call', ?, ?, ?)",
          [phone, await this.matchCustomerByPhone(phone), incoming ? 'inbound' : 'outbound', text, callId, event === 'terminate' ? 'ended' : 'ringing']);
      }
      // Staff push: when it starts ringing, and when an incoming call ends unanswered.
      const missed = event === 'terminate' && incoming && text.includes('Missed');
      if (incoming && (event !== 'terminate' || missed)) return { phone, title: missed ? 'Missed WhatsApp call' : 'Incoming WhatsApp call', body: label };
    } catch (e) { this.log(`WhatsAppService::logCallEvent failed: ${(e as Error).message}`); }
    return null;
  }

  /** A customer's emoji reaction: any earlier one from this phone for the same message is replaced (empty emoji = removed). The reacted-to wamid is kept in media_url. */
  async logInboundReaction(fromNumber: string, reactedMessageId: string, emoji: string, providerMessageId: string): Promise<void> {
    try {
      await this.db.execute("DELETE FROM whatsapp_messages WHERE direction = 'inbound' AND message_type = 'reaction' AND phone_number = ? AND media_url = ?", [fromNumber, reactedMessageId]);
      if (emoji === '') return; // reaction removed
      await this.logInboundMessage(fromNumber, 'reaction', emoji, reactedMessageId, providerMessageId);
    } catch (e) { this.log(`WhatsAppService::logInboundReaction failed: ${(e as Error).message}`); }
  }

  /** A delivery/read/failed status for a message WE sent earlier (matched by the id Meta returned). */
  async updateMessageStatus(providerMessageId: string, status: string): Promise<void> {
    try { await this.db.execute("UPDATE whatsapp_messages SET status = ? WHERE provider_message_id = ? AND direction = 'outbound'", [status, providerMessageId]); }
    catch (e) { this.log(`WhatsAppService::updateMessageStatus failed: ${(e as Error).message}`); }
  }

  // ---- media of one logged message ---------------------------------------------------------------------
  /**
   * One entry point for "open this message's attachment" (web + app). Inbound customer media is fetched from Meta; media we sent is
   * served from our kept copy; our own invoice/challan documents were never stored, so the PDF is regenerated from what the log line names.
   */
  async messageMedia(rowId: number): Promise<MediaPayload | null> {
    const row = (await this.db.query<Row>('SELECT direction, message_type, message_text, media_url FROM whatsapp_messages WHERE id = ?', [rowId]))[0];
    if (!row) return null;
    if (row.direction === 'inbound') return this.inboundMedia(rowId);
    const ref = phpStr(row.media_url);
    if (ref.startsWith('local:')) {
      const file = basename(ref.slice(6));
      try {
        const body = await readFile(join(this.outboundDir(), file));
        const ext = extname(file).slice(1).toLowerCase();
        const mime = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : 'application/octet-stream';
        return { contentType: mime, body, cacheControl: 'private, max-age=86400' };
      } catch { return null; }
    }
    if (row.message_type !== 'document') return null;
    const text = phpStr(row.message_text);
    let m: RegExpExecArray | null;
    let pdfPath: string | null = null; let name = 'document.pdf';
    if ((m = /^\[document\]\s+Invoice\s+(\S+)/.exec(text))) {
      const orderId = Number((await this.db.query<Row>('SELECT id FROM orders WHERE invoice_number = ? OR short_order_code = ? OR order_number = ? ORDER BY id DESC LIMIT 1', [m[1], m[1], m[1]]))[0]?.id ?? 0);
      if (!orderId || !this.opts.invoicePdf) return null;
      const r = await this.opts.invoicePdf.generate(orderId);
      if (!r.success || !r.file_path) return null;
      pdfPath = r.file_path; name = 'Invoice-' + m[1]!.replace(/[^A-Za-z0-9_-]+/g, '-') + '.pdf';
    } else if ((m = /^\[document\]\s+Challan\s+(\S+)/.exec(text))) {
      const ch = (await this.db.query<Row>('SELECT id, with_amount, combine_format, challan_number FROM challans WHERE challan_number = ? LIMIT 1', [m[1]]))[0];
      if (!ch || !this.opts.challanPdf) return null;
      const ids = (await this.db.query<Row>('SELECT order_id FROM challan_orders WHERE challan_id = ? ORDER BY order_id', [ch.id])).map((x) => Number(x.order_id));
      if (!ids.length) return null;
      const r = await this.opts.challanPdf.generate(ids, !!Number(ch.with_amount), ch.challan_number, ch.combine_format ?? 'aggregated');
      if (!r.success || !r.file_path) return null;
      pdfPath = r.file_path; name = 'Challan-' + String(ch.challan_number).replace(/[^A-Za-z0-9_-]+/g, '-') + '.pdf';
    } else return null;
    try {
      return { contentType: 'application/pdf', body: await readFile(pdfPath), disposition: `inline; filename="${name}"` };
    } finally { await unlink(pdfPath).catch(() => {}); }
  }

  /** The media file of one inbound message row (image/sticker/video/audio/document): fetched from Meta on first view (it keeps media ~30 days) and cached. */
  async inboundMedia(rowId: number): Promise<MediaPayload | null> {
    const row = (await this.db.query<Row>("SELECT message_type, media_url, provider_message_id FROM whatsapp_messages WHERE id = ? AND direction = 'inbound'", [rowId]))[0];
    if (!row || row.message_type === 'reaction' || phpEmpty(row.media_url) || phpEmpty(row.provider_message_id)) return null;
    const dir = this.inboundDir();
    const base = createHash('sha256').update(`${row.provider_message_id}|wa-media`).digest('hex');
    let file: string | null = null;
    try { file = (await readdir(dir)).find((f) => f.startsWith(base + '.')) ?? null; } catch { file = null; }
    if (!file) {
      const account = await this.resolveAccountForStore(null);
      if (!account) return null;
      let config: WaConfig;
      try { config = this.decryptAccountConfig(account); } catch { return null; }
      if (!/^v\d{1,3}\.\d$/.test(phpStr(config.api_version)) || !/^\d+$/.test(phpStr(row.media_url))) return null;
      const token = config.access_token ?? '';
      if (token === '') return null;
      let meta: any;
      try {
        const res = await fetch(`https://graph.facebook.com/${config.api_version}/${row.media_url}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
        meta = JSON.parse(await res.text());
      } catch { return null; }
      const url = phpStr(meta?.url);
      const mime = phpStr(meta?.mime_type).split(';')[0]!.trim().toLowerCase();
      if (url === '' || !MEDIA_EXT[mime] || !url.startsWith('https://')) return null;
      let bytes: Buffer;
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/7.64.1' }, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (res.status !== 200) return null;
        bytes = Buffer.from(await res.arrayBuffer());
      } catch { return null; }
      if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) return null;
      try { await mkdir(dir, { recursive: true }); file = `${base}.${MEDIA_EXT[mime]}`; await writeFile(join(dir, file), bytes); } catch { return null; }
    }
    const ext = extname(file).slice(1).toLowerCase();
    const mime = Object.entries(MEDIA_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    const inline = mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');
    return { contentType: mime, body: await readFile(join(dir, file)), nosniff: true, cacheControl: 'private, max-age=86400', disposition: `${inline ? 'inline' : 'attachment'}; filename="whatsapp-${rowId}.${ext}"` };
  }
}
