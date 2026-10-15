import type { FastifyInstance } from 'fastify';
import { phpEmpty } from '../../lib/php.js';
import { WebText, forbiddenPage, webPage } from '../context.js';
import { int } from '../format.js';
import { html, jsonEncode, raw } from '../html.js';
import { limitError } from '../../tenancy/limits.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplBrands } from '../tpl/master_brands.js';
import { tplCategories } from '../tpl/master_categories.js';
import { tplColors } from '../tpl/master_colors.js';
import { tplDefects } from '../tpl/master_defects.js';
import { tplDiscounts } from '../tpl/master_discounts.js';
import { tplPaymentTypes } from '../tpl/master_payment_types.js';
import { tplServices } from '../tpl/master_services.js';
import { tplStores } from '../tpl/master_stores.js';
import { tplTaxes } from '../tpl/master_taxes.js';
import { tplUrgentLevels } from '../tpl/master_urgent_levels.js';
import { tplWorkshops } from '../tpl/master_workshops.js';

type Row = Record<string, any>;
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

interface Extra { type: 'int' | 'decimal' | 'string'; required?: boolean; default?: unknown }
interface Entity { table: string; nameCol: string; title: string; orderBy: string; tpl: (v: Record<string, any>, h: any) => string; extra: Record<string, Extra>; refs: [string, string][] }
const SORT = { sort_order: { type: 'int', default: 0 } } as Record<string, Extra>;
const ENTITIES: Record<string, Entity> = {
  categories: { table: 'categories', nameCol: 'category_name', title: 'Categories', orderBy: 'sort_order ASC, id ASC', tpl: tplCategories, extra: SORT, refs: [['garments', 'category_id']] },
  services: {
    table: 'services', nameCol: 'service_name', title: 'Services', orderBy: 'sort_order ASC, id ASC', tpl: tplServices,
    extra: { description: { type: 'string', default: null }, sort_order: { type: 'int', default: 0 }, flat_weight_rate: { type: 'decimal', default: null }, flat_weight_tax_id: { type: 'int', default: null } },
    refs: [['garments', 'default_service_id'], ['price_list_items', 'service_id']],
  },
  taxes: { table: 'taxes', nameCol: 'tax_name', title: 'Tax Rates', orderBy: 'id ASC', tpl: tplTaxes, extra: { tax_percent: { type: 'decimal', required: true, default: 0 } }, refs: [['price_list_items', 'tax_id']] },
  discounts: { table: 'discounts', nameCol: 'discount_name', title: 'Discount Rules', orderBy: 'id ASC', tpl: tplDiscounts, extra: { discount_type: { type: 'string', default: 'Percent' }, discount_value: { type: 'decimal', default: 0 } }, refs: [] },
  urgent_levels: {
    table: 'urgent_levels', nameCol: 'level_name', title: 'Urgent Order Levels', orderBy: 'sort_order ASC, id ASC', tpl: tplUrgentLevels,
    extra: { surcharge_percent: { type: 'decimal', default: 0 }, day_offset: { type: 'int', default: 0 }, turnaround_hours: { type: 'int', default: null }, sort_order: { type: 'int', default: 0 } }, refs: [['orders', 'urgent_level_id']],
  },
  payment_types: { table: 'payment_types', nameCol: 'type_name', title: 'Payment Types', orderBy: 'sort_order ASC, id ASC', tpl: tplPaymentTypes, extra: SORT, refs: [['payment_transactions', 'payment_type_id']] },
  brands: { table: 'brands', nameCol: 'brand_name', title: 'Brands', orderBy: 'sort_order ASC, id ASC', tpl: tplBrands, extra: SORT, refs: [] },
  stores: { table: 'stores', nameCol: 'store_name', title: 'Stores', orderBy: 'id ASC', tpl: tplStores, extra: { address: { type: 'string', default: null }, phone: { type: 'string', default: null } }, refs: [['orders', 'store_id'], ['users', 'store_id']] },
  workshops: {
    table: 'workshops', nameCol: 'workshop_name', title: 'Workshops', orderBy: 'id ASC', tpl: tplWorkshops,
    extra: { address: { type: 'string', default: null }, phone: { type: 'string', default: null }, commission_workshop_percent: { type: 'decimal', default: 50.0 } }, refs: [['workshop_challans', 'workshop_id']],
  },
  colors: { table: 'colors', nameCol: 'color_name', title: 'Colors', orderBy: 'sort_order ASC, id ASC', tpl: tplColors, extra: { hex_code: { type: 'string', default: null }, sort_order: { type: 'int', default: 0 } }, refs: [] },
  defects: { table: 'defects', nameCol: 'defect_name', title: 'Defects', orderBy: 'sort_order ASC, id ASC', tpl: tplDefects, extra: { description: { type: 'string', default: null }, sort_order: { type: 'int', default: 0 } }, refs: [['order_item_defects', 'defect_id']] },
};
const isNumericVal = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));
const ucf = (s: string) => { const t = s.replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };

export function registerMasterPages(app: FastifyInstance) {
  const { db, audit } = app.services;

  for (const [slug, ent] of Object.entries(ENTITIES)) {
    webPage(app, `/modules/master_data/${slug}`, { auth: 'master.manage' }, async (ctx, req) => {
      const q = req.query as Record<string, unknown>;
      const search = clean(q.q);
      const page = Math.max(1, int(q.page) || 1), perPage = 20, offset = (page - 1) * perPage;
      let where = '1=1';
      const params: unknown[] = [];
      if (search !== '') { where += ` AND ${ent.nameCol} LIKE ?`; params.push(`%${search}%`); }
      const total = int((await db.query<Row>(`SELECT COUNT(*) AS n FROM ${ent.table} WHERE ${where}`, params))[0]!.n);
      const rows = await db.query<Row>(`SELECT * FROM ${ent.table} WHERE ${where} ORDER BY ${ent.orderBy} LIMIT ${perPage} OFFSET ${offset}`, params);
      const totalPages = Math.ceil(total / perPage);
      const vars: Record<string, any> = { search, page, rows, totalPages };
      if (slug === 'services') vars.taxes = await db.query<Row>('SELECT id, tax_name, tax_percent FROM taxes WHERE is_active = 1 ORDER BY tax_name');
      const h = await tplHelpers(ctx);
      return layout(ctx, { title: ent.title }, raw(ent.tpl(vars, h)));
    });
  }

  // ---- index (tiles) ------------------------------------------------------------------------------
  webPage(app, '/modules/master_data/index', { auth: 'master.manage' }, async (ctx) => {
    const countQ = async (table: string) => { try { return int((await db.query<Row>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n); } catch { return 0; } };
    const tiles: [string, string, string, number][] = [
      ['Categories', 'fa-layer-group', 'categories.php', await countQ('categories')], ['Stores', 'fa-store', 'stores.php', await countQ('stores')], ['Workshops', 'fa-industry', 'workshops.php', await countQ('workshops')],
      ['Services', 'fa-broom', 'services.php', await countQ('services')], ['Tax Rates', 'fa-percent', 'taxes.php', await countQ('taxes')], ['Discount Rules', 'fa-tags', 'discounts.php', await countQ('discounts')],
      ['Urgent Order Levels', 'fa-bolt', 'urgent_levels.php', await countQ('urgent_levels')], ['Payment Types', 'fa-credit-card', 'payment_types.php', await countQ('payment_types')], ['Brands', 'fa-copyright', 'brands.php', await countQ('brands')],
      ['Colors', 'fa-palette', 'colors.php', await countQ('colors')], ['Defects', 'fa-triangle-exclamation', 'defects.php', await countQ('defects')],
    ];
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Master Data' }, html`
<div class="col-12">
  <p class="text-muted">Configure the reference data used across garments, price lists, billing, and order entry. Changes here affect the whole system.</p>
</div>
${tiles.map(([label, icon, url, count]) => html`
  <div class="col-6 col-md-4 col-lg-3">
    <a href="${u('modules/master_data/' + url)}" class="text-decoration-none">
      <div class="card h-100">
        <div class="card-body text-center py-4">
          <i class="fa-solid ${icon} fa-2x mb-2" style="color:#0b3d91;"></i>
          <div class="fw-bold text-dark">${label}</div>
          <div class="text-muted small">${count} record${count === 1 ? '' : 's'}</div>
        </div>
      </div>
    </a>
  </div>`)}
`);
  });

  webPage(app, '/modules/master_data/printers', { auth: 'master.manage' }, async (ctx) => {
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Printers (Deprecated)' }, html`
<div class="col-12">
  <div class="alert alert-warning">
    <strong>This page is no longer used.</strong> The Printer field on Admin &gt; Print Settings is now a plain optional text label instead of a dropdown sourced from this list -- no website can detect a computer's actually installed printers, so maintaining a manual list here was replaced with a straightforward note field on each print-settings form.
    <div class="mt-2"><a href="${u('modules/admin/print_settings.php')}">Go to Print Settings &rarr;</a> &nbsp;|&nbsp; <a href="${u('modules/master_data/index.php')}">Back to Master Data &rarr;</a></div>
  </div>
</div>
`);
  });

  // ---- api/master_data.php (JSON) -----------------------------------------------------------------
  webPage(app, '/api/master_data', { auth: 'login', methods: ['GET', 'POST'] }, async (ctx, req) => {
    const json = (d: unknown, status = 200) => new WebText(jsonEncode(d), status, 'application/json');
    const p = req.body;
    if (req.method !== 'POST' || !p || typeof p !== 'object' || Array.isArray(p)) return json({ success: false, message: 'Invalid request payload.' }, 400);
    const payload = p as Record<string, any>;
    const token = payload.csrf_token ?? '';
    if (!ctx.data.csrf_token || typeof token !== 'string' || token !== ctx.data.csrf_token) return json({ success: false, message: 'Invalid or expired security token. Please refresh the page.' }, 419);
    const entity = payload.entity ?? '', action = payload.action ?? '';
    const ent = typeof entity === 'string' && Object.prototype.hasOwnProperty.call(ENTITIES, entity) ? ENTITIES[entity]! : null;
    if (!ent) return json({ success: false, message: 'Unknown entity.' }, 400);
    if (!ctx.can('master.manage')) return forbiddenPage(ctx);
    const userId = ctx.data.user_id ?? null;
    const allowed = new Set([ent.nameCol, ...Object.keys(ent.extra)]);
    const input: Record<string, any> = {};
    for (const [k, v] of Object.entries(payload)) if (allowed.has(k)) input[k] = v;
    const find = async (id: number) => (await db.query<Row>(`SELECT * FROM ${ent.table} WHERE id = ?`, [id]))[0] ?? null;
    const str = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? '1' : '') : String(v));
    const validate = async (excludeId: number | null) => {
      const errors: string[] = [];
      const name = str(input[ent.nameCol]).trim();
      if (name === '') errors.push(ucf(ent.nameCol) + ' is required.');
      else {
        const sql = `SELECT id FROM ${ent.table} WHERE ${ent.nameCol} = ?` + (excludeId ? ' AND id != ?' : '');
        if ((await db.query(sql, excludeId ? [name, excludeId] : [name])).length) errors.push('This name already exists. Please use a different name.');
      }
      for (const [col, meta] of Object.entries(ent.extra)) {
        if (meta.required && str(input[col]).trim() === '') errors.push(ucf(col) + ' is required.');
        if (meta.type === 'decimal' && input[col] !== undefined && input[col] !== null && input[col] !== '') {
          if (!isNumericVal(input[col]) || parseFloat(String(input[col])) < 0) errors.push(ucf(col) + ' must be a valid positive number.');
        }
      }
      return errors;
    };
    const cast = (col: string, meta: Extra) => {
      const val = input[col] ?? null;
      if ((meta.type === 'decimal' || meta.type === 'int') && (val === '' || val === null)) return meta.default ?? null;
      return val;
    };
    switch (action) {
      case 'create': {
        const errors = await validate(null);
        if (entity === 'stores') { const lim = await limitError(db, 'stores'); if (lim) errors.push(lim); }
        if (errors.length) return json({ success: false, message: errors.join(' ') }, 422);
        const cols = [ent.nameCol, ...Object.keys(ent.extra)];
        const vals = [str(input[ent.nameCol]).trim(), ...Object.entries(ent.extra).map(([c, m]) => cast(c, m))];
        const r = await db.execute(`INSERT INTO ${ent.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
        await audit.record({ action: 'create', module: entity, recordId: String(r.insertId), newValue: input, userId, ip: req.ip });
        return json({ success: true, id: r.insertId, row: await find(r.insertId) });
      }
      case 'update': {
        const id = int(payload.id);
        const old = id ? await find(id) : null;
        if (!id || !old) return json({ success: false, message: 'Record not found.' }, 404);
        const errors = await validate(id);
        if (errors.length) return json({ success: false, message: errors.join(' ') }, 422);
        const sets = [`${ent.nameCol} = ?`, ...Object.keys(ent.extra).map((c) => `${c} = ?`)];
        const vals = [str(input[ent.nameCol]).trim(), ...Object.entries(ent.extra).map(([c, m]) => cast(c, m)), id];
        await db.execute(`UPDATE ${ent.table} SET ${sets.join(',')} WHERE id = ?`, vals);
        await audit.record({ action: 'edit', module: entity, recordId: String(id), oldValue: old, newValue: input, userId, ip: req.ip });
        return json({ success: true, row: await find(id) });
      }
      case 'toggle': {
        const id = int(payload.id);
        const row = await find(id);
        if (!row) return json({ success: false, message: 'Record not found.' }, 404);
        const nv = row.is_active ? 0 : 1;
        await db.execute(`UPDATE ${ent.table} SET is_active = ? WHERE id = ?`, [nv, id]);
        await audit.record({ action: 'edit', module: entity, recordId: String(id), oldValue: { is_active: row.is_active }, newValue: { is_active: nv }, userId, ip: req.ip });
        return json({ success: true, row: await find(id) });
      }
      case 'delete': {
        const id = int(payload.id);
        const old = id ? await find(id) : null;
        if (!id || !old) return json({ success: false, message: 'Record not found.' }, 404);
        for (const [rt, rc] of ent.refs) {
          if (int((await db.query<Row>(`SELECT COUNT(*) AS n FROM ${rt} WHERE ${rc} = ?`, [id]))[0]!.n) > 0) return json({ success: false, message: 'Cannot delete — this record is used elsewhere in the system. Deactivate it instead.' });
        }
        await db.execute(`DELETE FROM ${ent.table} WHERE id = ?`, [id]);
        await audit.record({ action: 'delete', module: entity, recordId: String(id), oldValue: old, newValue: null, userId, ip: req.ip });
        return json({ success: true, message: 'Deleted successfully.' });
      }
      default: return json({ success: false, message: 'Unknown action.' }, 400);
    }
  });
  void phpEmpty;
}
