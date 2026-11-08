import { unlink } from 'node:fs/promises';
import { numberFormat2, phpEmpty } from '../lib/php.js';
import { datetimeIn, dMonY } from '../lib/tzFormat.js';
import { todayIn } from '../lib/dates.js';
import { getSetting } from './settings.js';
const phpStr = (v) => (v === null || v === undefined || v === false ? '' : v === true ? '1' : String(v));
const mbSubstr255 = (s) => Array.from(s).slice(0, 255).join('');
const isDup = (e) => e?.sqlState === '23000';
const isMissingTable = (e) => /doesn't exist|Base table or view not found/.test(String(e?.message ?? ''));
/** Port of includes/WhatsAppService.php (Meta Cloud provider, queue, templates, invoice sending). */
export class WhatsAppService {
    db;
    crypto;
    provider;
    opts;
    constructor(db, crypto, provider, opts) {
        this.db = db;
        this.crypto = crypto;
        this.provider = provider;
        this.opts = opts;
    }
    log(m) { (this.opts.log ?? console.error)(m); }
    now() { return (this.opts.now ?? Date.now)(); }
    /** PHP date('Y-m-d') in APP_TIMEZONE. */
    today() { return todayIn(this.opts.timezone, new Date(this.now())); }
    businessName() { return getSetting(this.db, 'business_name', this.opts.appName); }
    static normalizePhoneNumber(raw) {
        let digits = raw.replace(/\D+/g, '');
        if (digits === '')
            return digits;
        if (digits.length >= 13 || (digits.length === 12 && digits.startsWith('91')))
            return digits;
        if (digits.length === 11 && digits[0] === '0')
            digits = digits.slice(1);
        if (digits.length === 10)
            return '91' + digits;
        return digits;
    }
    async resolveAccountForStore(storeId) {
        try {
            if (storeId !== null) {
                const r = await this.db.query('SELECT * FROM whatsapp_accounts WHERE store_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1', [storeId]);
                if (r[0])
                    return r[0];
            }
            const g = await this.db.query('SELECT * FROM whatsapp_accounts WHERE store_id IS NULL AND is_active = 1 ORDER BY id DESC LIMIT 1');
            return g[0] ?? null;
        }
        catch {
            return null;
        }
    }
    decryptAccountConfig(account) {
        return {
            phone_number_id: account.phone_number_id,
            api_version: account.api_version,
            access_token: this.crypto.decrypt(account.access_token_encrypted),
            app_id: account.app_id ?? null,
            app_secret: !phpEmpty(account.app_secret_encrypted) ? this.crypto.decrypt(account.app_secret_encrypted) : null,
        };
    }
    async testAccountConnection(accountId) {
        let account;
        try {
            account = (await this.db.query('SELECT * FROM whatsapp_accounts WHERE id = ?', [accountId]))[0];
        }
        catch {
            return { success: false, error: 'The whatsapp_accounts table does not exist yet — it must be created before any account can be tested.' };
        }
        if (!account)
            return { success: false, error: 'Account not found.' };
        let config;
        try {
            config = this.decryptAccountConfig(account);
        }
        catch {
            return { success: false, error: 'Could not read the stored credentials for this account. They may need to be re-entered.' };
        }
        return this.provider.testConnection(config);
    }
    async logNotification(sql, params, what) {
        try {
            await this.db.execute(sql, params);
        }
        catch (e) {
            this.log(`WhatsAppService::${what} logging failed: ${e.message}`);
        }
    }
    async sendTestMessage(accountId, toNumber, text, userId) {
        toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
        let account;
        try {
            account = (await this.db.query('SELECT * FROM whatsapp_accounts WHERE id = ? AND is_active = 1', [accountId]))[0];
        }
        catch {
            return { success: false, error: 'The whatsapp_accounts table does not exist yet.' };
        }
        if (!account)
            return { success: false, error: 'Account not found or inactive.' };
        let config;
        try {
            config = this.decryptAccountConfig(account);
        }
        catch {
            return { success: false, error: 'Could not read the stored credentials for this account.' };
        }
        const result = await this.provider.sendText(config, toNumber, text);
        await this.logNotification("INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, recipient, message, status, error_message) VALUES (NULL, NULL, ?, 'whatsapp_test_message', 'WhatsApp', ?, ?, ?, ?)", [userId, toNumber, text, result.success ? 'Sent' : 'Failed', result.success ? null : result.error], 'sendTestMessage');
        return result;
    }
    async sendDirectReply(customerId, toNumber, text, userId) {
        toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
        const account = await this.resolveAccountForStore(null);
        if (!account)
            return { success: false, error: 'No WhatsApp account is configured.' };
        let config;
        try {
            config = this.decryptAccountConfig(account);
        }
        catch {
            return { success: false, error: 'Could not read the stored credentials for this account.' };
        }
        const result = await this.provider.sendText(config, toNumber, text);
        await this.logNotification("INSERT INTO notification_logs (customer_id, user_id, template_key, channel, recipient, message, status, error_message) VALUES (?, ?, 'inbox_reply', 'WhatsApp', ?, ?, ?, ?)", [customerId, userId, toNumber, text, result.success ? 'Sent' : 'Failed', result.success ? null : result.error], 'sendDirectReply');
        return result;
    }
    static renderTemplate(body, variables) {
        const missing = [];
        const text = body.replace(/\{([a-z_]+)\}/g, (_m, name) => {
            if (Object.prototype.hasOwnProperty.call(variables, name))
                return phpStr(variables[name]);
            missing.push(name);
            return '';
        });
        return { text, missing: [...new Set(missing)] };
    }
    async enqueue(customerId, orderId, toNumber, templateKey, variables, eventRef = null, campaignId = null) {
        toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
        let storeId = null;
        if (orderId) {
            try {
                const r = await this.db.query('SELECT store_id FROM orders WHERE id = ?', [orderId]);
                storeId = r[0]?.store_id ? Number(r[0].store_id) : null;
            }
            catch { /* store resolution failure shouldn't block the enqueue attempt below */ }
        }
        const account = await this.resolveAccountForStore(storeId);
        if (!account)
            return { success: false, queue_id: null, error: 'No WhatsApp account configured for this store (or globally).', duplicate: false };
        try {
            const template = (await this.db.query("SELECT * FROM notification_templates WHERE template_key = ? AND channel = 'WhatsApp' AND is_active = 1", [templateKey]))[0];
            if (!template)
                return { success: false, queue_id: null, error: `No active WhatsApp template found for key "${templateKey}".`, duplicate: false };
            const rendered = WhatsAppService.renderTemplate(template.body, variables);
            if (rendered.missing.length > 0)
                this.log(`WhatsAppService::enqueue — unresolved variables for ${templateKey}: ${rendered.missing.join(',')}`);
            let templateParams = null;
            if (!phpEmpty(template.provider_template_name) && !phpEmpty(template.template_param_order)) {
                let order = null;
                try {
                    order = JSON.parse(template.template_param_order);
                }
                catch { /* invalid JSON → [] */ }
                const names = Array.isArray(order) ? order : [];
                templateParams = names.map((n) => phpStr(variables[String(n)]));
            }
            const payload = JSON.stringify({
                text: rendered.text,
                provider_template_name: template.provider_template_name ?? null,
                language: template.language ?? 'en',
                template_params: templateParams,
            });
            const res = await this.db.execute("INSERT INTO whatsapp_outbound_queue (account_id, customer_id, order_id, to_number, message_type, template_key, payload_json, event_ref, campaign_id, status) VALUES (?,?,?,?,'template',?,?,?,?,'Queued')", [account.id, customerId, orderId, toNumber, templateKey, payload, eventRef, campaignId]);
            return { success: true, queue_id: res.insertId, error: null, duplicate: false };
        }
        catch (e) {
            if (isDup(e))
                return { success: true, queue_id: null, error: null, duplicate: true };
            if (isMissingTable(e))
                return { success: false, queue_id: null, error: 'whatsapp_outbound_queue table does not exist yet.', duplicate: false };
            return { success: false, queue_id: null, error: 'Could not queue the message.', duplicate: false };
        }
    }
    async uploadMediaOnce(storeId, localFilePath, mimeType) {
        const account = await this.resolveAccountForStore(storeId);
        if (!account)
            return { success: false, media_id: null, account_id: null, error: 'No WhatsApp account is configured.' };
        let config;
        try {
            config = this.decryptAccountConfig(account);
        }
        catch {
            return { success: false, media_id: null, account_id: null, error: 'Could not read the stored credentials for this account.' };
        }
        const up = await this.provider.uploadMedia(config, localFilePath, mimeType);
        if (!up.success)
            return { success: false, media_id: null, account_id: Number(account.id), error: up.error };
        return { success: true, media_id: up.media_id, account_id: Number(account.id), error: null };
    }
    async enqueueMedia(customerId, orderId, toNumber, accountId, mediaId, mediaType, caption, eventRef = null, campaignId = null) {
        toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
        try {
            const res = await this.db.execute("INSERT INTO whatsapp_outbound_queue (account_id, customer_id, order_id, to_number, message_type, template_key, payload_json, event_ref, campaign_id, status) VALUES (?,?,?,?,'media',NULL,?,?,?,'Queued')", [accountId, customerId, orderId, toNumber, JSON.stringify({ media_id: mediaId, media_type: mediaType, caption }), eventRef, campaignId]);
            return { success: true, queue_id: res.insertId, error: null, duplicate: false };
        }
        catch (e) {
            if (isDup(e))
                return { success: true, queue_id: null, error: null, duplicate: true };
            return { success: false, queue_id: null, error: 'Could not queue the media message.', duplicate: false };
        }
    }
    async processQueueBatch(limit = 20) {
        let processed = 0, sent = 0, failed = 0;
        let rows;
        try {
            rows = await this.db.query(`SELECT * FROM whatsapp_outbound_queue
         WHERE status = 'Queued' OR (status = 'Failed' AND retry_count < max_retries AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
         ORDER BY id ASC LIMIT ?`, [limit]);
        }
        catch {
            return { processed: 0, sent: 0, failed: 0, error: 'whatsapp_outbound_queue table does not exist yet.' };
        }
        for (const row of rows) {
            processed++;
            const claim = await this.db.execute("UPDATE whatsapp_outbound_queue SET status = 'Sending' WHERE id = ? AND status IN ('Queued','Failed')", [row.id]);
            if (claim.affectedRows === 0)
                continue; // another worker run already claimed it
            const account = (await this.db.query('SELECT * FROM whatsapp_accounts WHERE id = ?', [row.account_id]))[0];
            if (!account) {
                await this.db.execute("UPDATE whatsapp_outbound_queue SET status='Failed', error_message='Account no longer exists.' WHERE id=?", [row.id]);
                failed++;
                continue;
            }
            let config;
            try {
                config = this.decryptAccountConfig(account);
            }
            catch {
                await this.db.execute("UPDATE whatsapp_outbound_queue SET status='Failed', error_message='Could not decrypt account credentials.' WHERE id=?", [row.id]);
                failed++;
                continue;
            }
            let payload = {};
            try {
                const p = JSON.parse(row.payload_json);
                if (p && typeof p === 'object' && !Array.isArray(p))
                    payload = p;
            }
            catch { /* {} */ }
            let result;
            if (row.message_type === 'media') {
                result = await this.provider.sendMedia(config, row.to_number, payload.media_id ?? '', payload.media_type ?? 'image', payload.caption ?? '');
            }
            else if (row.message_type === 'template' && !phpEmpty(payload.provider_template_name) && payload.template_params !== undefined && payload.template_params !== null) {
                result = await this.provider.sendTemplate(config, row.to_number, payload.provider_template_name, payload.language ?? 'en', payload.template_params);
            }
            else {
                result = await this.provider.sendText(config, row.to_number, payload.text ?? '');
            }
            if (result.success) {
                await this.db.execute("UPDATE whatsapp_outbound_queue SET status='Sent', provider_message_id=?, sent_at=NOW() WHERE id=?", [result.provider_message_id, row.id]);
                sent++;
            }
            else {
                const retryCount = Number(row.retry_count) + 1;
                const permanent = retryCount >= Number(row.max_retries);
                // PHP: date('Y-m-d H:i:s', time() + 5*60*n²) in APP_TIMEZONE, compared against the DB's NOW() (see docs/PARITY.md).
                const next = permanent ? null : datetimeIn(this.opts.timezone, this.now() + 5 * 60 * retryCount * retryCount * 1000);
                await this.db.execute("UPDATE whatsapp_outbound_queue SET status='Failed', retry_count=?, next_attempt_at=?, error_message=? WHERE id=?", [retryCount, next, result.error, row.id]);
                failed++;
            }
            await this.logNotification("INSERT INTO notification_logs (customer_id, order_id, template_key, channel, recipient, message, status, provider, provider_message_id, error_message) VALUES (?,?,?,'WhatsApp',?,?,?, 'meta', ?, ?)", [row.customer_id, row.order_id, row.template_key, row.to_number, payload.text ?? '', result.success ? 'Sent' : 'Failed', result.provider_message_id ?? null, result.success ? null : result.error], 'processQueueBatch');
        }
        return { processed, sent, failed, error: null };
    }
    async maybeNotifyOrderReady(orderId) {
        try {
            const c = (await this.db.query("SELECT COUNT(*) AS total, SUM(item_status IN ('Ready','Packed')) AS ready_or_further FROM order_items WHERE order_id = ?", [orderId]))[0];
            if (!c || Number(c.total) === 0 || Number(c.total) !== Number(c.ready_or_further))
                return;
            const o = (await this.db.query('SELECT o.order_number, o.grand_total, c.id AS customer_id, c.full_name, c.mobile FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]))[0];
            if (!o || phpEmpty(o.mobile))
                return;
            await this.enqueue(Number(o.customer_id), orderId, o.mobile, 'order_ready', { customer_name: o.full_name, order_number: o.order_number, business_name: await this.businessName() }, `order_ready:${orderId}`);
        }
        catch (e) {
            this.log(`WhatsAppService::maybeNotifyOrderReady failed: ${e.message}`);
        }
    }
    async notifyWorkshopCompleted(workshopItemId) {
        try {
            const r = (await this.db.query(`SELECT o.id AS order_id, o.order_number, c.id AS customer_id, c.full_name, c.mobile
         FROM workshop_items wi
         LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id
         LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id
         LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id
         JOIN orders o ON o.id = COALESCE(oi1.order_id, oi2.order_id)
         JOIN customers c ON c.id = o.customer_id
         WHERE wi.id = ?`, [workshopItemId]))[0];
            if (!r || phpEmpty(r.mobile))
                return;
            await this.enqueue(Number(r.customer_id), Number(r.order_id), r.mobile, 'workshop_completed', { customer_name: r.full_name, order_number: r.order_number, business_name: await this.businessName() }, `workshop_completed:${r.order_id}`);
        }
        catch (e) {
            this.log(`WhatsAppService::notifyWorkshopCompleted failed: ${e.message}`);
        }
    }
    async sendMediaMessage(customerId, toNumber, localFilePath, mimeType, mediaType, caption, userId) {
        toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
        const account = await this.resolveAccountForStore(null);
        if (!account)
            return { success: false, error: 'No WhatsApp account is configured.' };
        let config;
        try {
            config = this.decryptAccountConfig(account);
        }
        catch {
            return { success: false, error: 'Could not read the stored credentials for this account.' };
        }
        const up = await this.provider.uploadMedia(config, localFilePath, mimeType);
        if (!up.success)
            return { success: false, error: `Media upload failed: ${up.error}` };
        const result = await this.provider.sendMedia(config, toNumber, up.media_id ?? '', mediaType, caption);
        await this.logNotification("INSERT INTO notification_logs (customer_id, user_id, template_key, channel, recipient, message, status, error_message) VALUES (?, ?, 'media_send', 'WhatsApp', ?, ?, ?, ?)", [customerId, userId, toNumber, `[${mediaType}] ${caption}`, result.success ? 'Sent' : 'Failed', result.success ? null : result.error], 'sendMediaMessage');
        return result;
    }
    async sendTemplateNow(toNumber, templateName, language, params, logKey, userId, logText) {
        toNumber = WhatsAppService.normalizePhoneNumber(toNumber);
        let result;
        const account = await this.resolveAccountForStore(null);
        if (!account)
            result = { success: false, error: 'No WhatsApp account is configured.' };
        else {
            try {
                result = await this.provider.sendTemplate(this.decryptAccountConfig(account), toNumber, templateName, language, [...params]);
            }
            catch {
                result = { success: false, error: 'Could not read the stored credentials for this account.' };
            }
        }
        await this.logNotification("INSERT INTO notification_logs (customer_id, user_id, template_key, channel, recipient, message, status, error_message) VALUES (NULL, ?, ?, 'WhatsApp', ?, ?, ?, ?)", [userId, logKey, toNumber, logText, result.success ? 'Sent' : 'Failed', result.success ? null : mbSubstr255(phpStr(result.error))], 'sendTemplateNow');
        return result;
    }
    async sendInvoice(orderId, userId) {
        const fail = (error, code) => ({ success: false, mode: null, error, code });
        const order = (await this.db.query(`SELECT o.id, o.customer_id, o.store_id, o.order_number, o.invoice_number, o.grand_total, o.total_paid, o.current_due, o.due_date, c.full_name, c.mobile
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, [orderId]))[0];
        if (!order)
            return fail('Order not found.', 'not_found');
        if (phpStr(order.mobile).trim() === '')
            return fail('This customer has no mobile number on file.', 'no_mobile');
        const account = await this.resolveAccountForStore(order.store_id ? Number(order.store_id) : null);
        if (!account)
            return fail('No WhatsApp account is configured.', 'not_configured');
        let config;
        try {
            config = this.decryptAccountConfig(account);
        }
        catch {
            return fail('Could not read the stored credentials for this account.', 'not_configured');
        }
        if (!this.opts.invoicePdf)
            return fail('Could not generate the invoice PDF.', 'pdf_failed');
        const pdf = await this.opts.invoicePdf.generate(orderId);
        if (!pdf.success || !pdf.file_path)
            return fail(pdf.error ?? 'Could not generate the invoice PDF.', 'pdf_failed');
        const number = phpStr(phpEmpty(order.invoice_number) ? order.order_number : order.invoice_number);
        const filename = `Invoice-${number.replace(/[^A-Za-z0-9_-]+/g, '-')}.pdf`;
        const upload = await this.provider.uploadMedia(config, pdf.file_path, 'application/pdf');
        await unlink(pdf.file_path).catch(() => { });
        const toNumber = WhatsAppService.normalizePhoneNumber(phpStr(order.mobile));
        let mode = null;
        let result;
        if (!upload.success) {
            result = { success: false, provider_message_id: null, error: `Media upload failed: ${upload.error}` };
        }
        else {
            const template = (await this.db.query("SELECT * FROM notification_templates WHERE template_key = 'invoice' AND channel = 'WhatsApp' AND is_active = 1 LIMIT 1"))[0];
            const name = phpStr(order.full_name).trim();
            const values = {
                customer_name: name === '' || name === '0' ? 'Customer' : name,
                invoice_number: number,
                order_number: phpStr(order.order_number),
                grand_total: numberFormat2(Number(order.grand_total)),
                total_paid: numberFormat2(Number(order.total_paid)),
                current_due: numberFormat2(Math.max(0, Number(order.current_due))),
                due_date: order.due_date ? dMonY(String(order.due_date)) : '-',
            };
            let paramOrder = [];
            if (template) {
                try {
                    const p = JSON.parse(phpStr(template.template_param_order));
                    if (Array.isArray(p))
                        paramOrder = p;
                }
                catch { /* [] */ }
            }
            if (template && !phpEmpty(template.provider_template_name) && paramOrder.length > 0) {
                mode = 'template';
                const params = paramOrder.map((k) => {
                    const v = (values[String(k)] ?? '').replace(/\s+/g, ' ');
                    return v === '' || v === '0' ? '-' : v;
                });
                result = await this.provider.sendTemplate(config, toNumber, template.provider_template_name, phpEmpty(template.language) ? 'en' : template.language, params, { id: upload.media_id ?? '', filename });
            }
            else {
                mode = 'free_form';
                result = await this.provider.sendMedia(config, toNumber, upload.media_id ?? '', 'document', `Invoice ${number}`);
            }
        }
        await this.logNotification("INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, recipient, message, status, provider, provider_message_id, error_message) VALUES (?, ?, ?, 'invoice', 'WhatsApp', ?, ?, ?, 'meta', ?, ?)", [order.customer_id, orderId, userId, toNumber, `[document] Invoice ${number}${mode ? ` (${mode})` : ''}`, result.success ? 'Sent' : 'Failed', result.provider_message_id ?? null, result.success ? null : mbSubstr255(phpStr(result.error))], 'sendInvoice');
        return { success: result.success, mode, error: result.success ? null : result.error, code: result.success ? null : 'send_failed' };
    }
}
