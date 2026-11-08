import { phpEmpty, toInt } from '../../lib/php.js';
import { PrintConfigService } from '../../services/printConfig.js';
import { WebRedirect, WebText, webPage } from '../context.js';
import { html, raw } from '../html.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplAdminPrintSettings } from '../tpl/admin_print_settings.js';
import { tplAdminSettings } from '../tpl/admin_settings.js';
import { MAX_UPLOAD_SIZE_MB, deleteUploadedImage, handleImageUpload } from '../uploads.js';
const str = (v) => (typeof v === 'string' ? v : '');
const clean = (v) => str(v).trim();
const body = (ctx) => (ctx.req.body ?? {});
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const EDITABLE_KEYS = [
    'business_name', 'address', 'phone', 'whatsapp', 'email', 'gstin',
    'opening_time', 'closing_time', 'invoice_prefix', 'order_prefix', 'barcode_prefix',
    'currency_symbol', 'delivery_charge_default', 'max_counter_discount_percent', 'default_due_days',
    'allow_overpayment',
    'short_order_code_enabled', 'short_order_code_prefix', 'short_order_code_digits',
    'password_reset_wa_template', 'password_reset_wa_language',
];
export function registerAdminSettingsPages(app) {
    const { db, audit, printConfig } = app.services;
    // ---- admin/settings ---------------------------------------------------------------------------
    webPage(app, '/modules/admin/settings', { auth: 'admin.settings' }, async (ctx, req) => {
        const errors = [];
        const userId = ctx.data.user_id ?? null;
        const p = body(ctx);
        if (req.method === 'POST' && 'save_settings' in p) {
            if (!ctx.csrfValid())
                return csrfFail();
            if ('short_order_code_prefix' in p && !/^[A-Za-z]$/.test(str(p.short_order_code_prefix).trim()))
                errors.push('Order Code prefix must be exactly one alphabetic character.');
            // Each store can have its own Order Code prefix letter -- a per-store override of the single
            // global prefix above. Stores this page doesn't list (deactivated, or new ones added after
            // page load) are simply not in the body, so nothing to validate/save for those.
            const storePrefixUpdates = new Map();
            for (const [k, v] of Object.entries(p)) {
                const m = /^store_prefix_(\d+)$/.exec(k);
                if (!m)
                    continue;
                const sid = toInt(m[1]);
                const val = str(v).trim().toUpperCase();
                if (val !== '' && !/^[A-Z]$/.test(val)) {
                    errors.push(`Store #${sid}'s Order Code prefix must be exactly one alphabetic character.`);
                    continue;
                }
                storePrefixUpdates.set(sid, val === '' ? null : val);
            }
            if ('short_order_code_digits' in p) {
                const d = toInt(p.short_order_code_digits);
                if (d < 1 || d > 10)
                    errors.push('Order Code digit length must be between 1 and 10.');
            }
            if (!errors.length) {
                for (const key of EDITABLE_KEYS) {
                    if (!(key in p) && !['allow_overpayment', 'short_order_code_enabled'].includes(key))
                        continue;
                    let value = clean(p[key]);
                    if (key === 'allow_overpayment')
                        value = 'allow_overpayment' in p ? '1' : '0';
                    if (key === 'short_order_code_enabled')
                        value = 'short_order_code_enabled' in p ? '1' : '0';
                    if (key === 'short_order_code_prefix')
                        value = value.trim().toUpperCase();
                    await db.execute('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [key, value]);
                }
                if (storePrefixUpdates.size) {
                    for (const [sid, val] of storePrefixUpdates)
                        await db.execute('UPDATE stores SET code_prefix = ? WHERE id = ?', [val, sid]);
                    await audit.record({ action: 'edit', module: 'stores', recordId: 'code_prefix', newValue: Object.fromEntries(storePrefixUpdates), userId, ip: req.ip });
                }
                await audit.record({ action: 'edit', module: 'settings', recordId: 'business_settings', newValue: { keys: EDITABLE_KEYS }, userId, ip: req.ip });
                ctx.flashSet('success', 'Settings updated successfully.');
                return new WebRedirect('modules/admin/settings.php');
            }
        }
        if (req.method === 'POST' && 'logo_action' in p) {
            if (!ctx.csrfValid())
                return csrfFail();
            if (!ctx.can('branding.manage'))
                return new WebText('You do not have permission to manage branding.', 403);
            const currentLogo = (await ctx.setting('logo_path', '')) ?? '';
            if (p.logo_action === 'delete') {
                if (!phpEmpty(currentLogo)) {
                    await deleteUploadedImage(ctx, currentLogo, 'logo');
                    await db.execute("UPDATE settings SET setting_value = '' WHERE setting_key = 'logo_path'");
                    await audit.record({ action: 'delete', module: 'settings', recordId: 'logo_path', oldValue: { logo_path: currentLogo }, newValue: { logo_path: '' }, userId, ip: req.ip });
                    ctx.flashSet('success', 'Logo removed.');
                }
            }
            else {
                try {
                    const uploaded = await handleImageUpload(ctx, 'logo', 'logo');
                    if (uploaded) {
                        if (!phpEmpty(currentLogo))
                            await deleteUploadedImage(ctx, currentLogo, 'logo');
                        await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('logo_path', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [uploaded]);
                        await audit.record({ action: 'edit', module: 'settings', recordId: 'logo_path', oldValue: { logo_path: currentLogo }, newValue: { logo_path: uploaded }, userId, ip: req.ip });
                        ctx.flashSet('success', 'Logo updated.');
                    }
                    else
                        errors.push('Please choose an image file to upload.');
                }
                catch (ex) {
                    errors.push(ex.message);
                }
            }
            if (!errors.length)
                return new WebRedirect('modules/admin/settings.php');
        }
        const currentLogo = (await ctx.setting('logo_path', '')) ?? '';
        const activeStores = await db.query('SELECT id, store_name, code_prefix FROM stores WHERE is_active=1 ORDER BY store_name');
        const h = await tplHelpers(ctx);
        return layout(ctx, { title: 'Admin Settings' }, raw(tplAdminSettings({ MAX_UPLOAD_SIZE_MB, currentLogo, errors, activeStores }, h)));
    });
    // ---- admin/print_settings ---------------------------------------------------------------------
    webPage(app, '/modules/admin/print_settings', { auth: 'master.manage' }, async (ctx, req) => {
        const stores = await db.query('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');
        const fixedStoreId = ctx.fixedStoreId();
        const canActAsStore = async (id) => {
            if (fixedStoreId !== null)
                return fixedStoreId === id;
            return (await db.query('SELECT id FROM stores WHERE id = ? AND is_active = 1', [id])).length > 0;
        };
        let targetStoreId;
        if (fixedStoreId !== null)
            targetStoreId = fixedStoreId;
        else {
            const requested = toInt(req.query.store_id);
            if (requested && (await canActAsStore(requested)))
                targetStoreId = requested;
            else
                targetStoreId = ctx.activeStoreId() || Number(stores[0]?.id ?? 0);
        }
        if (!targetStoreId) {
            return layout(ctx, { title: 'Print Settings' }, html `<div class="col-12"><div class="alert alert-warning">No active store found. Please add a store under Master Data first.</div></div>`);
        }
        if (req.method === 'POST') {
            if (!ctx.csrfValid())
                return csrfFail();
            const p = body(ctx);
            const posted = toInt(p.store_id);
            const back = 'modules/admin/print_settings.php' + (fixedStoreId === null ? '?store_id=' + posted : '');
            if (!(await canActAsStore(posted)) || (fixedStoreId !== null && posted !== fixedStoreId)) {
                ctx.flashSet('danger', 'You are not authorized to change print settings for that store.');
                return new WebRedirect(back);
            }
            const uid = ctx.data.user_id ?? null;
            const form = str(p.form);
            const done = (r, ok) => ctx.flashSet(r.success ? 'success' : 'danger', r.success ? ok : r.errors.join(' '));
            if (form === 'tag')
                done(await printConfig.saveTagConfig(posted, p, uid, req.ip), 'Tag print settings saved.');
            else if (form === 'invoice')
                done(await printConfig.saveInvoiceConfig(posted, p, uid, req.ip), 'Order invoice print settings saved.');
            else if (form === 'delivery')
                done(await printConfig.saveDeliveryConfig(posted, p, uid, req.ip), 'Delivery slip print settings saved.');
            return new WebRedirect(back);
        }
        const tagConfig = await printConfig.getTagConfig(targetStoreId);
        const invoiceConfig = await printConfig.getInvoiceConfig(targetStoreId);
        const deliveryConfig = await printConfig.getDeliveryConfig(targetStoreId);
        const mmToIn = PrintConfigService.mmToIn;
        const tagWidthDisplay = tagConfig.tag_unit === 'in' ? mmToIn(tagConfig.tag_width_mm) : tagConfig.tag_width_mm;
        const tagHeightDisplay = tagConfig.tag_unit === 'in' ? mmToIn(tagConfig.tag_height_mm) : tagConfig.tag_height_mm;
        const invWidthDisplay = invoiceConfig.invoice_unit === 'in' ? mmToIn(invoiceConfig.invoice_width_mm) : invoiceConfig.invoice_width_mm;
        const invHeightDisplay = invoiceConfig.invoice_height_mm !== null ? (invoiceConfig.invoice_unit === 'in' ? mmToIn(invoiceConfig.invoice_height_mm) : invoiceConfig.invoice_height_mm) : '';
        const delWidthDisplay = deliveryConfig.delivery_unit === 'in' ? mmToIn(deliveryConfig.delivery_width_mm) : deliveryConfig.delivery_width_mm;
        const delHeightDisplay = deliveryConfig.delivery_height_mm !== null ? (deliveryConfig.delivery_unit === 'in' ? mmToIn(deliveryConfig.delivery_height_mm) : deliveryConfig.delivery_height_mm) : '';
        const h = await tplHelpers(ctx);
        return layout(ctx, { title: 'Print Settings' }, raw(tplAdminPrintSettings({
            delHeightDisplay, delWidthDisplay, deliveryConfig, fixedStoreId, invHeightDisplay, invWidthDisplay, invoiceConfig, stores, tagConfig, tagHeightDisplay, tagWidthDisplay, targetStoreId,
        }, h)));
    });
}
