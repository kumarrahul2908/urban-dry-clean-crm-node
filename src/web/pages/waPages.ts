import type { FastifyInstance } from 'fastify';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { phpEmpty, phpRound, toFloat, toInt } from '../../lib/php.js';
import { CustomerSegments } from '../../services/customerSegments.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { raw } from '../html.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplWaAnalytics } from '../tpl/wa_analytics.js';
import { tplWaCampaigns } from '../tpl/wa_campaigns.js';
import { tplWaInbox } from '../tpl/wa_inbox.js';
import { tplWaMarketing } from '../tpl/wa_marketing.js';
import { tplWaRateList } from '../tpl/wa_rate_list.js';
import { tplWaSettings } from '../tpl/wa_settings.js';
import { tplWaTemplates } from '../tpl/wa_templates.js';
import { accountsSql, campaignsSql, marketingRulesSql } from '../tpl/whatsapp_sql.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const orNull = (s: string) => (phpEmpty(s) ? null : s);
const sqlState = (e: unknown) => (e as { sqlState?: string }).sqlState;
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const missingTable = (e: unknown) => /doesn't exist|Base table or view not found/.test(msgOf(e));

/** finfo(FILEINFO_MIME_TYPE) for the handful of types that matter here. */
function sniffMime(b: Buffer): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 2).toString('latin1') === 'PK') return 'application/zip';
  if (b.length === 0) return 'application/x-empty';
  const text = b.every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128);
  return text ? 'text/plain' : 'application/octet-stream';
}

export function registerWaPages(app: FastifyInstance) {
  const { db, audit, whatsapp, crypto } = app.services;
  const opt = { auth: 'whatsapp.settings' } as const;
  const when = (ctx: WebCtx) => ({ userId: ctx.data.user_id ?? null });

  // ---- analytics ---------------------------------------------------------------------------------
  webPage(app, '/modules/reports/whatsapp/analytics', opt, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const today = ctx.today;
    const dateFrom = 'date_from' in q ? clean(q.date_from) : today.slice(0, 8) + '01';
    const dateTo = 'date_to' in q ? clean(q.date_to) : today;
    const fixed = ctx.fixedStoreId();
    const sfSql = fixed !== null ? ' AND o.store_id IN (?)' : '';
    const sfParams: unknown[] = fixed !== null ? [fixed] : [];
    const counters = new Map<string, number>([['Queued', 0], ['Sent', 0], ['Delivered', 0], ['Read', 0], ['Failed', 0]]);
    let queueMissing = false;
    try {
      const rows = await db.query<Row>(`SELECT q.status, COUNT(*) AS cnt FROM whatsapp_outbound_queue q LEFT JOIN orders o ON o.id = q.order_id WHERE DATE(q.created_at) BETWEEN ? AND ?${sfSql} GROUP BY q.status`, [dateFrom, dateTo, ...sfParams]);
      for (const r of rows) if (counters.has(r.status)) counters.set(r.status, Number(r.cnt));
    } catch { queueMissing = true; }
    const c = (k: string) => counters.get(k)!;
    const totalSent = c('Sent') + c('Delivered') + c('Read');
    const deliveryRate = totalSent > 0 ? phpRound(((c('Delivered') + c('Read')) / totalSent) * 100, 1) : 0;
    const readRate = totalSent > 0 ? phpRound((c('Read') / totalSent) * 100, 1) : 0;
    const totalAttempted = [...counters.values()].reduce((a, b) => a + b, 0);
    const failureRate = totalAttempted > 0 ? phpRound((c('Failed') / totalAttempted) * 100, 1) : 0;
    let campaignStats: Row[] = [];
    try {
      campaignStats = await db.query<Row>(
        `SELECT c.campaign_name, COUNT(q.id) AS recipients, SUM(q.status IN ('Sent','Delivered','Read')) AS sent, SUM(q.status IN ('Delivered','Read')) AS delivered,
         SUM(q.status = 'Read') AS read_count, SUM(q.status = 'Failed') AS failed FROM whatsapp_campaigns c LEFT JOIN whatsapp_outbound_queue q ON q.campaign_id = c.id
         WHERE DATE(c.created_at) BETWEEN ? AND ? GROUP BY c.id ORDER BY c.id DESC LIMIT 20`, [dateFrom, dateTo]);
    } catch { /* tables not set up yet — empty list is correct */ }
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'WhatsApp — Analytics' }, raw(tplWaAnalytics({ campaignStats, counters, dateFrom, dateTo, deliveryRate, failureRate, queueMissing, readRate }, h)));
  });

  // ---- marketing automation ----------------------------------------------------------------------
  webPage(app, '/modules/reports/whatsapp/marketing', opt, async (ctx, req) => {
    const errors: string[] = [];
    let success: string | null = null;
    let tableMissing = false;
    const segments = CustomerSegments.available;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const action = clean(p.action);
      if (action === 'save') {
        const name = clean(p.rule_name), segment = clean(p.segment_key);
        const templateId = toInt(p.template_id);
        const storeId = !phpEmpty(p.store_id) ? toInt(p.store_id) : null;
        if (name === '' || !Object.prototype.hasOwnProperty.call(segments, segment) || !templateId) errors.push('Provide a name and select both a segment and a template.');
        else {
          try {
            await db.execute('INSERT INTO whatsapp_marketing_rules (rule_name, segment_key, template_id, store_id, is_active, created_by) VALUES (?,?,?,?,0,?)', [name, segment, templateId, storeId, ctx.data.user_id]);
            success = 'Rule created (inactive by default — enable it below when ready).';
          } catch { tableMissing = true; }
        }
      } else if (action === 'toggle') {
        try {
          await db.execute('UPDATE whatsapp_marketing_rules SET is_active = 1 - is_active WHERE id = ?', [toInt(p.id)]);
          success = 'Rule updated.';
        } catch { tableMissing = true; }
      }
    }
    let rules: Row[] = [];
    try {
      rules = await db.query<Row>('SELECT r.*, nt.template_key, s.store_name FROM whatsapp_marketing_rules r JOIN notification_templates nt ON nt.id = r.template_id LEFT JOIN stores s ON s.id = r.store_id ORDER BY r.id DESC');
    } catch { tableMissing = true; }
    const templates = await db.query<Row>("SELECT * FROM notification_templates WHERE channel='WhatsApp' AND is_active=1");
    const stores = await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active=1 ORDER BY store_name');
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'WhatsApp — Marketing Automation' }, raw(tplWaMarketing({ errors, requiredSql: marketingRulesSql, rules, segments, stores, success, tableMissing, templates }, h)));
  });

  // ---- rate list ---------------------------------------------------------------------------------
  webPage(app, '/modules/reports/whatsapp/rate_list', opt, async (ctx, req) => {
    const errors: string[] = [];
    let success: string | null = null;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const customerId = toInt(p.customer_id), priceListId = toInt(p.price_list_id);
      if (!customerId || !priceListId) errors.push('Select both a customer and a price list.');
      else {
        const customer = (await db.query<Row>('SELECT id, full_name, mobile FROM customers WHERE id = ?', [customerId]))[0];
        if (!customer || phpEmpty(customer.mobile)) errors.push('Customer not found or has no mobile number.');
        else {
          const rates = await db.query<Row>(
            `SELECT g.garment_name, s.service_name, pli.piece_rate, pli.weight_rate FROM price_list_items pli JOIN garments g ON g.id = pli.garment_id JOIN services s ON s.id = pli.service_id
             WHERE pli.price_list_id = ? AND (pli.piece_rate > 0 OR pli.weight_rate > 0) ORDER BY s.sort_order, g.garment_name LIMIT 30`, [priceListId]);
          const money = await ctx.loadMoney();
          const lines = rates.map((r) => `${r.garment_name} (${r.service_name}): ` + (toFloat(r.weight_rate) > 0 ? money(r.weight_rate) + '/kg' : money(r.piece_rate)));
          const text = `Dear ${customer.full_name}, here is our current rate list:\n${lines.join('\n')}\nThanks, ${(await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? ''}.`;
          const result = await whatsapp.sendDirectReply(customerId, customer.mobile, text, when(ctx).userId);
          success = result.success ? 'Rate list sent.' : null;
          if (!result.success) errors.push(('error' in result && result.error) || 'Could not send.');
        }
      }
    }
    const priceLists = await db.query<Row>('SELECT id, price_list_name FROM price_lists WHERE is_active=1 ORDER BY price_list_name');
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'WhatsApp — Rate List' }, raw(tplWaRateList({ errors, priceLists, success }, h)));
  });

  // ---- templates ---------------------------------------------------------------------------------
  webPage(app, '/modules/reports/whatsapp/templates', opt, async (ctx, req) => {
    const errors: string[] = [];
    let success: string | null = null;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const action = clean(p.action);
      if (action === 'save') {
        const id = toInt(p.id);
        const templateKey = clean(p.template_key), channel = clean(p.channel), subject = clean(p.subject), bodyText = str(p.body).trim();
        const isActive = 'is_active' in p ? 1 : 0;
        if (templateKey === '') errors.push('Template key is required.');
        if (!['SMS', 'WhatsApp', 'Email'].includes(channel)) errors.push('Select a valid channel.');
        if (bodyText === '') errors.push('Message body is required.');
        if (!errors.length) {
          try {
            if (id) { await db.execute('UPDATE notification_templates SET template_key=?, channel=?, subject=?, body=?, is_active=? WHERE id=?', [templateKey, channel, orNull(subject), bodyText, isActive, id]); success = 'Template updated.'; }
            else { await db.execute('INSERT INTO notification_templates (template_key, channel, subject, body, is_active) VALUES (?,?,?,?,?)', [templateKey, channel, orNull(subject), bodyText, isActive]); success = 'Template created.'; }
          } catch (e) { errors.push(sqlState(e) === '23000' ? 'That template key + channel combination already exists.' : 'Could not save the template.'); }
        }
      } else if (action === 'delete') {
        await db.execute('DELETE FROM notification_templates WHERE id = ?', [toInt(p.id)]);
        success = 'Template removed.';
      }
    }
    const templates = await db.query<Row>('SELECT * FROM notification_templates ORDER BY channel, template_key');
    const knownVariables = ['customer_name', 'order_number', 'order_total', 'paid_amount', 'due_amount', 'store_name', 'store_phone', 'business_name', 'due_date'];
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'WhatsApp — Templates' }, raw(tplWaTemplates({ errors, knownVariablesStr: knownVariables.map((v) => `{${v}}`).join(', '), success, templates }, h)));
  });

  // ---- API settings ------------------------------------------------------------------------------
  webPage(app, '/modules/reports/whatsapp/settings', opt, async (ctx, req) => {
    const errors: string[] = [];
    let success: string | null = null;
    let tableMissing = false;
    if (!crypto.isConfigured()) errors.push('APP_SECRET_KEY is not configured (or is still the sample placeholder) in config/config.php — credentials cannot be safely encrypted until this is set to a real random value.');
    if (req.method === 'POST' && !errors.length) {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const action = clean(p.action);
      const uid = ctx.data.user_id ?? null;
      if (action === 'save') {
        const storeId = !phpEmpty(p.store_id) ? toInt(p.store_id) : null;
        const accountName = clean(p.account_name), wabaId = clean(p.waba_id), phoneNumberId = clean(p.phone_number_id), senderNumber = clean(p.sender_display_number);
        const appId = clean(p.app_id), webhookVerifyToken = clean(p.webhook_verify_token), apiVersion = clean(p.api_version);
        const isActive = 'is_active' in p ? 1 : 0;
        const accessToken = str(p.access_token), appSecret = str(p.app_secret);
        if (accountName === '') errors.push('Account name is required.');
        if (wabaId === '') errors.push('WABA ID is required.');
        if (phoneNumberId === '') errors.push('Phone Number ID is required.');
        if (!/^v\d{1,3}\.\d$/.test(apiVersion)) errors.push('API version should look like "v21.0".');
        const accountId = toInt(p.id);
        if (!accountId && accessToken === '') errors.push('Access Token is required for a new account.');
        if (!errors.length) {
          try {
            if (accountId) {
              let sql = 'UPDATE whatsapp_accounts SET store_id=?, account_name=?, waba_id=?, phone_number_id=?, sender_display_number=?, app_id=?, webhook_verify_token=?, api_version=?, is_active=?';
              const params: unknown[] = [storeId, accountName, wabaId, phoneNumberId, orNull(senderNumber), orNull(appId), orNull(webhookVerifyToken), apiVersion, isActive];
              if (accessToken !== '') { sql += ', access_token_encrypted=?'; params.push(crypto.encrypt(accessToken)); }
              if (appSecret !== '') { sql += ', app_secret_encrypted=?'; params.push(crypto.encrypt(appSecret)); }
              sql += ' WHERE id=?'; params.push(accountId);
              await db.execute(sql, params);
              await audit.record({ action: 'edit', module: 'whatsapp_accounts', recordId: String(accountId), newValue: { account_name: accountName }, userId: uid, ip: req.ip });
              success = 'Account updated.';
            } else {
              const r = await db.execute("INSERT INTO whatsapp_accounts (store_id, account_name, provider, waba_id, phone_number_id, sender_display_number, access_token_encrypted, app_id, app_secret_encrypted, webhook_verify_token, api_version, is_active) VALUES (?,?,'meta',?,?,?,?,?,?,?,?,?)",
                [storeId, accountName, wabaId, phoneNumberId, orNull(senderNumber), crypto.encrypt(accessToken), orNull(appId), appSecret !== '' ? crypto.encrypt(appSecret) : null, orNull(webhookVerifyToken), apiVersion, isActive]);
              await audit.record({ action: 'create', module: 'whatsapp_accounts', recordId: String(r.insertId), newValue: { account_name: accountName }, userId: uid, ip: req.ip });
              success = 'Account created.';
            }
          } catch (e) {
            if (missingTable(e)) tableMissing = true;
            else errors.push('Could not save: ' + (sqlState(e) === '23000' ? 'that WABA ID / Phone Number ID may already be in use.' : 'a database error occurred.'));
          }
        }
      } else if (action === 'delete') {
        const deleteId = toInt(p.id);
        try {
          const oldRow = (await db.query<Row>('SELECT account_name, waba_id, phone_number_id, is_active FROM whatsapp_accounts WHERE id = ?', [deleteId]))[0];
          if (!oldRow) errors.push('That account no longer exists.');
          else {
            await db.execute('DELETE FROM whatsapp_accounts WHERE id = ?', [deleteId]);
            await audit.record({ action: 'delete', module: 'whatsapp_accounts', recordId: String(deleteId), oldValue: oldRow, userId: uid, ip: req.ip });
            success = 'Account deleted.';
          }
        } catch (e) {
          if (missingTable(e)) tableMissing = true;
          else if (sqlState(e) === '23000') errors.push('This account cannot be deleted because messages were already sent with it (their history refers to it). Edit it and untick "Active" instead.');
          else errors.push('Could not delete the account.');
        }
      }
    }
    let accounts: Row[] = [];
    try { accounts = await db.query<Row>('SELECT wa.*, s.store_name FROM whatsapp_accounts wa LEFT JOIN stores s ON s.id = wa.store_id ORDER BY wa.id DESC'); } catch { tableMissing = true; }
    const stores = await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');
    const editId = toInt((req.query as Record<string, unknown>).edit);
    const editing = accounts.find((a) => Number(a.id) === editId) ?? null;
    const fv = (k: string) => (editing ? String(editing[k] ?? '') : '');
    const h = await tplHelpers(ctx, { fv });
    return layout(ctx, { title: 'WhatsApp — API Settings' }, raw(tplWaSettings({ accounts, editing, errors, requiredSql: accountsSql, stores, success, tableMissing }, h)));
  });

  // ---- inbox -------------------------------------------------------------------------------------
  webPage(app, '/modules/reports/whatsapp/inbox', opt, async (ctx) => {
    const templates = await db.query<Row>("SELECT template_key, body, provider_template_name, template_param_order FROM notification_templates WHERE channel = 'WhatsApp' AND is_active = 1 ORDER BY template_key");
    for (const t of templates) {
      let d: unknown = null;
      try { d = JSON.parse(String(t.template_param_order ?? '')); } catch { /* → [] */ }
      t.param_order = phpEmpty(d) || (typeof d === 'object' && d !== null && !Array.isArray(d) && !Object.keys(d).length) ? [] : d; // json_decode(..., true) ?: []
    }
    const h = await tplHelpers(ctx);
    return layout(ctx, {}, raw(tplWaInbox({ templates }, h)));
  });

  // ---- campaigns ---------------------------------------------------------------------------------
  webPage(app, '/modules/reports/whatsapp/campaigns', opt, async (ctx, req) => {
    const errors: string[] = [];
    let success: string | null = null;
    let tableMissing = false;
    const segments = CustomerSegments.available;
    const segs = new CustomerSegments(db, ctx.fixedStoreId());
    const templates = await db.query<Row>("SELECT * FROM notification_templates WHERE channel='WhatsApp' AND is_active=1 ORDER BY template_key");
    const fixed = ctx.fixedStoreId();
    const storeOptions = fixed === null
      ? await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active=1 ORDER BY store_name')
      : await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active=1 AND id IN (?) ORDER BY store_name', [fixed]);
    const q = req.query as Record<string, unknown>;
    const selectedSegment = clean(q.segment);
    const selectedTemplateId = toInt(q.template_id);
    const selectedStoreId = !phpEmpty(q.store_id) ? toInt(q.store_id) : null;
    let previewRecipients: Row[] = [];
    if (!phpEmpty(selectedSegment) && Object.prototype.hasOwnProperty.call(segments, selectedSegment)) previewRecipients = await segs.resolve(selectedSegment, selectedStoreId);

    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const action = clean(p.action);
      if (action === 'confirm_send') {
        const segmentKey = clean(p.segment), templateId = toInt(p.template_id), campaignName = clean(p.campaign_name);
        const requestedStoreId = !phpEmpty(p.store_id) ? toInt(p.store_id) : null;
        if (campaignName === '' || !Object.prototype.hasOwnProperty.call(segments, segmentKey) || !templateId) errors.push('Please provide a campaign name and select both a segment and a template.');
        else {
          const template = (await db.query<Row>("SELECT * FROM notification_templates WHERE id = ? AND channel='WhatsApp' AND is_active=1", [templateId]))[0];
          const recipients = await segs.resolve(segmentKey, requestedStoreId);
          if (!template) errors.push('Selected template is invalid.');
          else if (!recipients.length) errors.push('This segment currently has zero eligible (WhatsApp opt-in) recipients — nothing to send.');
          else {
            const account = await whatsapp.resolveAccountForStore(requestedStoreId);
            if (!account) errors.push('No WhatsApp account is configured yet (Settings page) — cannot send a campaign.');
            else {
              try {
                let campaignId: number | null = null;
                try {
                  const r = await db.execute("INSERT INTO whatsapp_campaigns (campaign_name, segment_key, template_id, store_id, account_id, status, recipient_count, created_by) VALUES (?,?,?,?,?, 'Sending', ?, ?)",
                    [campaignName, segmentKey, templateId, requestedStoreId, account.id, recipients.length, ctx.data.user_id]);
                  campaignId = Number(r.insertId);
                } catch { tableMissing = true; }
                let queued = 0, skipped = 0;
                let mediaLocalPath: string | null = null, mediaMimeType: string | null = null, mediaKind: string | null = null;
                const media = ctx.files.media;
                if (media) {
                  if (media.buffer.length > 10 * 1024 * 1024) errors.push('Media file too large (max 10 MB) — campaign not sent.');
                  else {
                    const realMime = sniffMime(media.buffer);
                    const allowed: Record<string, [string, string]> = { 'image/jpeg': ['image', 'jpg'], 'image/png': ['image', 'png'], 'application/pdf': ['document', 'pdf'] };
                    if (!allowed[realMime]) errors.push(`Media type not allowed (detected: ${realMime}) — campaign not sent.`);
                    else {
                      const [kind, ext] = allowed[realMime]!;
                      mediaKind = kind;
                      const dir = join(ctx.svc.storage.root, 'whatsapp_media_tmp');
                      await mkdir(dir, { recursive: true, mode: 0o750 });
                      mediaLocalPath = join(dir, randomBytes(16).toString('hex') + '.' + ext);
                      await writeFile(mediaLocalPath, media.buffer);
                      mediaMimeType = realMime;
                    }
                  }
                }
                if (!errors.length) {
                  let mediaAccountId: number | null = null, mediaId: string | null = null;
                  if (mediaLocalPath) {
                    const up = await whatsapp.uploadMediaOnce(requestedStoreId, mediaLocalPath, mediaMimeType!);
                    await unlink(mediaLocalPath).catch(() => {});
                    if (!up.success) errors.push('Media upload failed: ' + up.error);
                    else { mediaAccountId = up.account_id; mediaId = up.media_id; }
                  }
                  if (!errors.length) {
                    const business = (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? '';
                    for (const r of recipients) {
                      const eventRef = `campaign:${campaignId ?? 'none'}:customer:${r.id}`;
                      const result = mediaId
                        ? await whatsapp.enqueueMedia(Number(r.id), null, r.mobile, mediaAccountId!, mediaId, mediaKind!, template.body ?? '', eventRef, campaignId)
                        : await whatsapp.enqueue(Number(r.id), null, r.mobile, template.template_key, { customer_name: r.full_name, business_name: business }, eventRef, campaignId);
                      if (result.success && !result.duplicate) queued++; else skipped++;
                    }
                    success = `Campaign queued: ${queued} message(s) added to the outbound queue` + (skipped ? `, ${skipped} skipped (already queued or account not configured)` : '') + '. They will actually send when the WhatsApp queue worker next runs — not immediately, including media.';
                  }
                }
                tableMissing = false;
              } catch (e) { errors.push('Could not queue this campaign: ' + msgOf(e)); }
            }
          }
        }
      }
    }
    let campaigns: Row[] = [];
    try { campaigns = await db.query<Row>('SELECT c.*, nt.template_key FROM whatsapp_campaigns c JOIN notification_templates nt ON nt.id = c.template_id ORDER BY c.id DESC LIMIT 20'); } catch { tableMissing = true; }
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'WhatsApp — Campaigns' }, raw(tplWaCampaigns({ campaigns, errors, previewRecipients, requiredSql: campaignsSql, segments, selectedSegment, selectedStoreId, selectedTemplateId, storeOptions, success, tableMissing, templates }, h)));
  });
  void WebRedirect;
}
