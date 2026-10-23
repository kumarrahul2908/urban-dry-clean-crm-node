import type { FastifyInstance, FastifyRequest } from 'fastify';
import { formatDateOnly } from '../../lib/dates.js';
import { ApiError, num, ok } from '../../lib/http.js';
import { filterBool, toInt } from '../../lib/php.js';
import { qInt, qStr } from '../../lib/query.js';

type Raw = Record<string, any>;
const isScalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Ports of garment_manage / garment_save / barcode_lookup / qr_lookup (garment_image: Phase 4, needs file storage). */
export async function registerMobileGarmentRoutes(app: FastifyInstance) {
  const { db, env } = app.services;
  const route = (method: 'GET' | 'POST', name: string, handler: (req: FastifyRequest) => Promise<unknown>) => {
    app.route({ method, url: `/${name}`, handler });
    app.route({ method, url: `/${name}.php`, handler });
  };

  route('GET', 'garment_manage', async (req) => {
    const ctx = await app.requireToken(req);
    const has = (k: string) => ctx.permissions.includes(k);
    if (!has('garment.view') && !has('garments.manage')) throw new ApiError('forbidden', 'You do not have permission to perform this action.', 403);
    const id = qInt((req.query as Raw).id);
    let garment: Raw | null = null;
    if (id) {
      [garment = null] = await db.query<Raw>(
        `SELECT g.*, c.category_name, s.service_name FROM garments g
         LEFT JOIN categories c ON c.id = g.category_id LEFT JOIN services s ON s.id = g.default_service_id WHERE g.id = ?`, [id]);
      if (!garment) throw new ApiError('not_found', 'Garment not found.', 404);
    }
    const categories = (await db.query<Raw>('SELECT id, category_name, is_active FROM categories ORDER BY sort_order, category_name'))
      .filter((c) => c.is_active || (garment && Number(c.id) === Number(garment.category_id)))
      .map((c) => ({ id: num(c.id), category_name: c.category_name }));
    const services = (await db.query<Raw>('SELECT id, service_name, is_active FROM services ORDER BY sort_order, service_name'))
      .filter((s) => s.is_active || (garment && Number(s.id) === Number(garment.default_service_id)))
      .map((s) => ({ id: num(s.id), service_name: s.service_name }));
    const units = ['Pcs', 'Set', 'Kg', 'Pair'];
    if (garment && garment.unit !== '' && !units.includes(garment.unit)) units.push(garment.unit);
    const base = env.APP_URL.replace(/\/+$/, '');
    return ok({
      garment: garment ? {
        id: num(garment.id), garment_name: garment.garment_name, sku: garment.sku, category_id: num(garment.category_id), category_name: garment.category_name,
        default_service_id: garment.default_service_id !== null ? num(garment.default_service_id) : null, service_name: garment.service_name,
        unit: garment.unit, description: garment.description, is_active: !!garment.is_active,
        image_url: garment.image ? `${base}/uploads/garments/${garment.image}` : null,
      } : null,
      categories, services, units,
      can: { create: has('garment.create') || has('garments.manage'), edit: has('garment.edit') || has('garments.manage'), change_active: has('garment.delete') || has('garments.manage') },
    });
  });

  route('POST', 'garment_save', async (req) => {
    const ctx = await app.requireToken(req);
    const has = (k: string) => ctx.permissions.includes(k);
    const payload: Raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Raw) : {};
    let id = toInt(payload.id);
    const isEdit = id > 0;
    if (isEdit ? !has('garment.edit') && !has('garments.manage') : !has('garment.create') && !has('garments.manage')) {
      throw new ApiError('forbidden', 'You do not have permission to perform this action.', 403);
    }
    const canChangeActive = has('garment.delete') || has('garments.manage');
    const str = (k: string) => (isScalar(payload[k]) ? String(payload[k]).trim() : '');
    const form: Raw = { garment_name: str('garment_name'), sku: str('sku'), category_id: str('category_id'), default_service_id: str('default_service_id'), unit: str('unit'), description: str('description') };
    const len = (s: string) => [...s].length;
    let warning: string | null = null;

    try {
      await db.tx(async (t) => {
        let current: Raw | undefined;
        if (isEdit) {
          [current] = await t.query<Raw>('SELECT * FROM garments WHERE id = ? FOR UPDATE', [id]);
          if (!current) throw new ApiError('not_found', 'Garment not found.', 404);
        }
        const errors: string[] = [];
        if (form.garment_name === '') errors.push('Garment name is required.');
        if (form.category_id === '') errors.push('Category is required.');
        if (form.unit === '') errors.push('Unit is required.');
        if (len(form.garment_name) > 100) errors.push('Garment name must be at most 100 characters.');
        if (len(form.sku) > 50) errors.push('SKU must be at most 50 characters.');
        if (len(form.description) > 255) errors.push('Description must be at most 255 characters.');
        if (form.unit !== '' && !['Pcs', 'Set', 'Kg', 'Pair'].includes(form.unit) && !(current && form.unit === current.unit)) errors.push('Unit must be Pcs, Set, Kg or Pair.');
        if (form.category_id !== '') {
          const [c] = await t.query<{ is_active: number }>('SELECT is_active FROM categories WHERE id = ?', [toInt(form.category_id)]);
          const keepsCurrent = current && toInt(form.category_id) === Number(current.category_id);
          if (!c || (!Number(c.is_active) && !keepsCurrent) || !/^\d+$/.test(form.category_id)) errors.push('Select a valid category.');
        }
        if (form.default_service_id !== '') {
          const [s] = await t.query<{ is_active: number }>('SELECT is_active FROM services WHERE id = ?', [toInt(form.default_service_id)]);
          const keepsCurrent = current && toInt(form.default_service_id) === Number(current.default_service_id);
          if (!s || (!Number(s.is_active) && !keepsCurrent) || !/^\d+$/.test(form.default_service_id)) errors.push('Select a valid default service.');
        }
        if (form.sku !== '' && (await t.query('SELECT id FROM garments WHERE sku = ? AND id != ?', [form.sku, id])).length) errors.push('This SKU is already used by another garment.');
        if (form.garment_name !== '' && form.category_id !== '' && (await t.query('SELECT id FROM garments WHERE LOWER(garment_name) = LOWER(?) AND category_id = ? AND id != ?', [form.garment_name, toInt(form.category_id), id])).length) {
          errors.push(`A garment named "${form.garment_name}" already exists in this category.`);
        }
        if (errors.length) throw new ApiError('validation_failed', errors[0]!, 422, { field_errors: errors });

        const svcId = form.default_service_id !== '' ? toInt(form.default_service_id) : null;
        const audit = app.services.audit.using(t);
        if (isEdit) {
          form.is_active = Object.prototype.hasOwnProperty.call(payload, 'is_active') ? (filterBool(payload.is_active) ? 1 : 0) : Number(current!.is_active);
          if (form.is_active !== Number(current!.is_active) && !canChangeActive) {
            form.is_active = Number(current!.is_active);
            warning = 'You do not have permission to activate/deactivate garments — that change was not applied, but your other edits were saved.';
          }
          await t.execute('UPDATE garments SET garment_name=?, sku=?, category_id=?, default_service_id=?, unit=?, description=?, is_active=? WHERE id=?',
            [form.garment_name, form.sku || null, toInt(form.category_id), svcId, form.unit, form.description, form.is_active, id]);
          await audit.record({ action: 'edit', module: 'garments', recordId: String(id), oldValue: current, newValue: form, userId: ctx.id, ip: req.ip });
        } else {
          const r = await t.execute('INSERT INTO garments (garment_name, sku, category_id, default_service_id, unit, image, description) VALUES (?,?,?,?,?,NULL,?)',
            [form.garment_name, form.sku || null, toInt(form.category_id), svcId, form.unit, form.description]);
          id = r.insertId;
          await audit.record({ action: 'create', module: 'garments', recordId: String(id), newValue: form, userId: ctx.id, ip: req.ip });
        }
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
        const m = 'A garment with this name (in this category) or SKU already exists.';
        throw new ApiError('validation_failed', m, 422, { field_errors: [m] });
      }
      throw e;
    }
    const [g] = await db.query<Raw>(
      `SELECT g.id, g.garment_name, g.sku, g.category_id, c.category_name, g.default_service_id, g.unit, g.description, g.is_active
       FROM garments g LEFT JOIN categories c ON c.id = g.category_id WHERE g.id = ?`, [id]);
    return ok({
      created: !isEdit, warning,
      garment: {
        id: num(g!.id), garment_name: g!.garment_name, sku: g!.sku, category_id: num(g!.category_id), category_name: g!.category_name,
        default_service_id: g!.default_service_id !== null ? num(g!.default_service_id) : null, unit: g!.unit, description: g!.description, is_active: !!g!.is_active,
      },
    });
  });

  // ---- barcode / QR lookups (garment_tags.view) ---------------------------------------------------
  const lookup = async (req: FastifyRequest, ctx: { id: number }, column: 'barcode_value' | 'qr_token' | 'short_qr_payload', value: string, kind: 'barcode' | 'qr') => {
    const notFound = kind === 'barcode' ? 'No garment found for this barcode.' : 'No garment found for this QR code.';
    const audit = (recordId: string, extra: Raw) =>
      app.services.audit.record({ action: 'lookup', module: 'garment_tags', recordId, newValue: extra, userId: ctx.id, ip: req.ip });
    const via = kind === 'barcode' ? { barcode: value } : { via: column };
    const fallbackId = kind === 'barcode' ? value : `qr:${value.slice(0, 8)}`;

    const [anchor] = await db.query<Raw>(`SELECT order_item_id, laundry_garment_id FROM barcodes WHERE ${column} = ?`, [value]);
    if (anchor && anchor.laundry_garment_id) {
      const [row] = await db.query<Raw>(
        `SELECT b.id AS barcode_id, b.barcode_value, b.item_sequence, lg.id AS laundry_garment_id,
                g.garment_name, s.service_name, oi.item_status, oi.quantity AS total_garments,
                o.id AS order_id, o.order_number, o.short_order_code, o.invoice_number, o.due_date, o.due_time, c.full_name AS customer_name, c.mobile AS customer_mobile
         FROM barcodes b JOIN laundry_garments lg ON lg.id = b.laundry_garment_id JOIN order_items oi ON oi.id = lg.order_item_id
         JOIN garments g ON g.id = lg.garment_id JOIN services s ON s.id = oi.service_id JOIN orders o ON o.id = b.order_id JOIN customers c ON c.id = o.customer_id
         WHERE b.${column} = ?`, [value]);
      await audit(row ? String(row.laundry_garment_id) : fallbackId, { ...via, found: !!row, mode: 'weight', source: 'mobile' });
      if (!row) throw new ApiError('not_found', notFound, 404);
      return ok({
        order_mode: 'weight', laundry_garment_id: num(row.laundry_garment_id), order_id: num(row.order_id), order_number: row.short_order_code ?? row.order_number,
        invoice_number: row.invoice_number, sequence: num(row.item_sequence), total_garments: num(row.total_garments),
        customer_name: row.customer_name, customer_mobile: row.customer_mobile, garment_name: row.garment_name, service_name: row.service_name,
        status: row.item_status, due_date: formatDateOnly(row.due_date), remarks: null,
      });
    }
    const [row] = await db.query<Raw>(
      `SELECT b.id AS barcode_id, b.barcode_value, b.item_sequence, oi.id AS order_item_id, oi.remarks,
              g.garment_name, s.service_name, oi.item_status, o.id AS order_id, o.order_number, o.short_order_code, o.invoice_number, o.due_date, o.due_time,
              c.full_name AS customer_name, c.mobile AS customer_mobile
       FROM barcodes b JOIN order_items oi ON oi.id = b.order_item_id JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id
       JOIN orders o ON o.id = b.order_id JOIN customers c ON c.id = o.customer_id WHERE b.${column} = ?`, [value]);
    await audit(row ? String(row.order_item_id) : fallbackId, { ...via, found: !!row, source: 'mobile' });
    if (!row) throw new ApiError('not_found', notFound, 404);
    return ok({
      order_mode: 'piece', order_item_id: num(row.order_item_id), order_id: num(row.order_id), order_number: row.short_order_code ?? row.order_number,
      invoice_number: row.invoice_number, sequence: num(row.item_sequence), total_garments: null,
      customer_name: row.customer_name, customer_mobile: row.customer_mobile, garment_name: row.garment_name, service_name: row.service_name,
      status: row.item_status, due_date: formatDateOnly(row.due_date), remarks: row.remarks,
    });
  };

  route('GET', 'barcode_lookup', async (req) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, 'garment_tags.view');
    const barcode = qStr((req.query as Raw).barcode);
    if (barcode === '') throw new ApiError('invalid_barcode', 'Enter a barcode.', 422);
    return lookup(req, ctx, 'barcode_value', barcode, 'barcode');
  });

  route('GET', 'qr_lookup', async (req) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, 'garment_tags.view');
    const token = qStr((req.query as Raw).token);
    let column: 'qr_token' | 'short_qr_payload' | null = null;
    if (/^[a-f0-9]{32}$/.test(token)) column = 'qr_token';
    else if (/^[A-Za-z]+[0-9]+-[0-9]+$/.test(token)) column = 'short_qr_payload';
    if (column === null) throw new ApiError('invalid_token', 'Invalid or malformed token.', 422);
    return lookup(req, ctx, column, token, 'qr');
  });
}
