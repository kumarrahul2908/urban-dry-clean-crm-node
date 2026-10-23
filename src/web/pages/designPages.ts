import type { FastifyInstance } from 'fastify';
import { CustomerSegments } from '../../services/customerSegments.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { csvBody } from '../csv.js';
import { formArray, httpBuildQuery, int } from '../format.js';
import { raw } from '../html.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplAdminInvoiceDesign } from '../tpl/admin_invoice_design.js';
import { tplAdminTagDesign } from '../tpl/admin_tag_design.js';
import { tplReportsDormant } from '../tpl/reports_dormant.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);

const FONT_OPTIONS = ['Arial', 'Arial Black', 'Verdana', 'Georgia', 'Courier New', 'Times New Roman'];
const ALIGN_OPTIONS: Record<string, string> = { left: 'Left', center: 'Center', right: 'Right' };

/** What one design row's posted controls turn into (font whitelisted, size clamped to 6..72, align whitelisted). */
function fieldInputs(p: Record<string, unknown>, k: string) {
  const font = FONT_OPTIONS.includes(str(p[`font_${k}`])) ? str(p[`font_${k}`]) : 'Arial';
  const size = Math.max(6, Math.min(72, int(p[`size_${k}`] ?? 12)));
  const align = Object.prototype.hasOwnProperty.call(ALIGN_OPTIONS, str(p[`align_${k}`])) ? str(p[`align_${k}`]) : 'left';
  const on = (n: string) => (`${n}_${k}` in p ? 1 : 0);
  return { show: on('show'), font, size, bold: on('bold'), italic: on('italic'), underline: on('underline'), align, box: on('box') };
}

/** Admin > Tag Design / Invoice Design (data-driven printing) and Reports > Dormant Customers. */
export function registerDesignPages(app: FastifyInstance) {
  const { db, audit } = app.services;

  webPage(app, '/modules/admin/tag_design', { auth: 'master.manage' }, async (ctx, req) => {
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      for (const r of await db.query<Row>('SELECT id, field_key FROM tag_design_fields')) {
        const f = fieldInputs(p, String(r.field_key));
        await db.execute('UPDATE tag_design_fields SET show_field=?, font_family=?, font_size=?, is_bold=?, is_italic=?, is_underline=?, text_align=?, has_box=? WHERE id=?',
          [f.show, f.font, f.size, f.bold, f.italic, f.underline, f.align, f.box, r.id]);
      }
      await audit.record({ action: 'edit', module: 'tag_design_fields', recordId: 'all', newValue: { updated_by: ctx.data.user_id }, userId: ctx.data.user_id, ip: req.ip });
      ctx.flashSet('success', 'Tag Design saved.');
      return new WebRedirect('modules/admin/tag_design.php');
    }
    const fields = await db.query<Row>('SELECT * FROM tag_design_fields ORDER BY sort_order');
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'Tag Design' }, raw(tplAdminTagDesign({ alignOptions: ALIGN_OPTIONS, fields, fontOptions: FONT_OPTIONS }, h)));
  });

  webPage(app, '/modules/admin/invoice_design', { auth: 'master.manage' }, async (ctx, req) => {
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      if (str(p.section) === 'fields_toggles') {
        for (const r of await db.query<Row>('SELECT id, field_key FROM invoice_design_fields')) {
          const f = fieldInputs(p, String(r.field_key));
          await db.execute('UPDATE invoice_design_fields SET show_field=?, font_family=?, font_size=?, is_bold=?, is_italic=?, is_underline=?, text_align=? WHERE id=?',
            [f.show, f.font, f.size, f.bold, f.italic, f.underline, f.align, r.id]);
        }
        for (const t of await db.query<Row>('SELECT toggle_key FROM invoice_design_toggles')) {
          await db.execute('UPDATE invoice_design_toggles SET is_on=? WHERE toggle_key=?', [`toggle_${t.toggle_key}` in p ? 1 : 0, t.toggle_key]);
        }
        ctx.flashSet('success', 'Invoice Design saved.');
      } else if (str(p.section) === 'terms') {
        await db.execute('DELETE FROM invoice_terms_conditions');
        let i = 10;
        for (const line of formArray(p, 'term_line').map((x) => x.trim()).filter((x) => x !== '')) {
          await db.execute('INSERT INTO invoice_terms_conditions (line_text, sort_order) VALUES (?, ?)', [line, i]);
          i += 10;
        }
        ctx.flashSet('success', 'Terms & Conditions saved.');
      }
      await audit.record({ action: 'edit', module: 'invoice_design', recordId: 'all', newValue: { updated_by: ctx.data.user_id }, userId: ctx.data.user_id, ip: req.ip });
      return new WebRedirect('modules/admin/invoice_design.php');
    }
    const fields = await db.query<Row>('SELECT * FROM invoice_design_fields ORDER BY sort_order');
    const toggles = await db.query<Row>('SELECT * FROM invoice_design_toggles ORDER BY sort_order');
    const terms = await db.query<Row>('SELECT * FROM invoice_terms_conditions ORDER BY sort_order');
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'Invoice Design' }, raw(tplAdminInvoiceDesign({ alignOptions: ALIGN_OPTIONS, fields, fontOptions: FONT_OPTIONS, terms, toggles }, h)));
  });

  webPage(app, '/modules/reports/dormant_customers', { auth: 'reports.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const buckets: Record<string, { label: string; min: number; max: number | null; segment_key: string }> = {
      '30': { label: '30+ Days', min: 30, max: 59, segment_key: '30_day_inactive' },
      '60': { label: '60+ Days', min: 60, max: 89, segment_key: '60_day_inactive' },
      '90': { label: '90+ Days', min: 90, max: 119, segment_key: '90_day_inactive' },
      '120': { label: '120+ Days', min: 120, max: 179, segment_key: '120_day_inactive' },
      '180': { label: '180+ Days', min: 180, max: null, segment_key: '180plus_day_inactive' },
    };
    // PHP turns the numeric-string keys '30'/'60'/... into ints, so the template's `$selectedBucket === $key` is never true (no button highlights)
    const bucketMap = new Map(Object.entries(buckets).map(([k, v]) => [Number(k), v] as const));
    const selectedBucket = Object.prototype.hasOwnProperty.call(buckets, str(q.bucket)) ? str(q.bucket) : '30';
    const b = buckets[selectedBucket]!;

    const fixed = ctx.fixedStoreId();
    const allowedStores = fixed === null ? null : [fixed];
    const requested = int(q.store_id);
    const canAct = requested
      ? (fixed !== null ? fixed === requested : (await db.query('SELECT id FROM stores WHERE id = ? AND is_active = 1', [requested])).length > 0)
      : false;
    const storeId = requested && canAct ? requested : null;

    const customers = await new CustomerSegments(db, fixed).inactiveDaysReport(b.min, b.max, storeId);
    const stores = await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');

    if ('export' in q) {
      return new WebText(csvBody(['Customer', 'Mobile', 'Last Order Date', 'Days Since Last Order', 'WhatsApp Opted In'],
        customers.map((c) => [c.full_name, c.mobile, c.last_order_date, c.days_inactive, c.communication_preference === 'WhatsApp' ? 'Yes' : 'No'])),
      200, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="dormant_customers_${selectedBucket}days_${ctx.today}.csv"` });
    }
    const h = await tplHelpers(ctx, { dormantExportQs: () => httpBuildQuery({ ...q, export: 1 }) });
    return layout(ctx, { title: 'Dormant Customers' }, raw(tplReportsDormant({ allowedStores, b, buckets: bucketMap, customers, selectedBucket, storeId, stores }, h)));
  });
}
