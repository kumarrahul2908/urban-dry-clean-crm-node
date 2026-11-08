import { createHash } from 'node:crypto';
import { ApiError, num, ok } from '../../lib/http.js';
import { phpEmpty, round2, toFloat, toInt } from '../../lib/php.js';
import { qInt, qStr } from '../../lib/query.js';
import { CodeCollisionError } from '../../services/customerService.js';
import { IdempotencyConflictError } from '../../services/customerWallet.js';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Ports of api/mobile/customers_*.php, pos_customer_summary.php, wallet_transactions.php, wallet_adjust.php. */
export async function registerMobileCustomerRoutes(app) {
    const { db, customers, wallet, pricing } = app.services;
    const route = (method, name, permission, handler) => {
        const h = async (req) => {
            const ctx = await app.requireToken(req);
            if (permission)
                app.requirePermission(ctx, permission);
            return handler(req, ctx);
        };
        app.route({ method, url: `/${name}`, handler: h });
        app.route({ method, url: `/${name}.php`, handler: h });
    };
    const body = (req) => req.body && typeof req.body === 'object' ? req.body : {};
    const s = (v, dflt = '') => String(v ?? dflt).trim();
    const formFrom = (i, create) => ({
        title: s(i.title, create ? 'Mr' : ''),
        full_name: s(i.full_name),
        address: s(i.address), area: s(i.area), city: s(i.city), state: s(i.state), pincode: s(i.pincode),
        mobile: s(i.mobile), alt_mobile: s(i.alt_mobile), email: s(i.email),
        membership_id: s(i.membership_id), birthday: s(i.birthday), anniversary: s(i.anniversary), remarks: s(i.remarks),
        home_delivery: phpEmpty(i.home_delivery) ? 0 : 1,
        marketing_source: s(i.marketing_source),
        registration_source: s(i.registration_source, create ? 'Counter' : ''),
        discount_percent: i.discount_percent ?? 0,
        price_list_id: !phpEmpty(i.price_list_id) ? toInt(i.price_list_id) : null,
        communication_preference: s(i.communication_preference, create ? 'SMS' : ''),
        gstin: s(i.gstin), referral_code: s(i.referral_code),
        ...(create ? {} : { is_active: (phpEmpty(i.is_active) ? 0 : 1) }),
    });
    const rejectInvalid = (v) => {
        if (v.status === 'invalid')
            throw new ApiError('validation_failed', 'Please correct the highlighted fields.', 422, { fields: v.fieldErrors });
        if (v.status === 'duplicate_blocked') {
            const m = v.matched_customer;
            throw new ApiError('duplicate_customer', `This mobile number is already registered for ${m.full_name} (${m.customer_code}). Please use the existing customer instead of creating a duplicate.`, 409, { matched_customer: m });
        }
        if (v.status === 'duplicate_requires_confirmation') {
            const m = v.matched_customer;
            throw new ApiError('duplicate_requires_confirmation', `This mobile number is registered for a very similar name: ${m.full_name} (${m.customer_code}). If this is genuinely a different person, resubmit with confirm_different_person set.`, 409, { matched_customer: m });
        }
    };
    // ---- reads ---------------------------------------------------------------------------
    route('GET', 'customers_list', 'customers.view', async (req) => {
        const q = req.query;
        const search = qStr(q.q);
        const page = Math.max(1, qInt(q.page));
        const perPage = 20;
        let where = '1=1';
        const params = [];
        if (search !== '') {
            where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ? OR c.customer_code LIKE ? OR c.barcode LIKE ?)';
            params.push(...Array(4).fill(`%${search}%`));
        }
        const [{ n }] = (await db.query(`SELECT COUNT(*) AS n FROM customers c WHERE ${where}`, params));
        const results = await db.query(`SELECT c.id, c.customer_code, c.title, c.full_name, c.mobile, c.area, c.price_list_id,
              pl.price_list_name, c.discount_percent, c.home_delivery, c.is_active
       FROM customers c LEFT JOIN price_lists pl ON pl.id = c.price_list_id
       WHERE ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`, [...params, perPage, (page - 1) * perPage]);
        return ok({ results, page, per_page: perPage, total: num(n), total_pages: Math.ceil(num(n) / perPage) });
    });
    route('GET', 'customers_search', 'customers.view', async (req) => {
        const q = qStr(req.query.q);
        if (q.length < 2)
            return ok({ results: [] });
        const like = `%${q}%`;
        const results = await db.query(`SELECT id, customer_code, title, full_name, mobile, address, area, city, state, pincode,
              barcode, discount_percent, price_list_id, home_delivery
       FROM customers
       WHERE is_active = 1 AND (full_name LIKE ? OR mobile LIKE ? OR customer_code LIKE ? OR barcode LIKE ?
         OR address LIKE ? OR area LIKE ? OR city LIKE ? OR state LIKE ? OR pincode LIKE ?)
       ORDER BY full_name LIMIT 15`, Array(9).fill(like));
        return ok({ results });
    });
    route('GET', 'customers_detail', 'customers.view', async (req) => {
        const id = qInt(req.query.id);
        if (id <= 0)
            throw new ApiError('invalid_request', 'A valid customer id is required.', 422);
        const [customer] = await db.query(`SELECT c.id, c.customer_code, c.title, c.full_name, c.mobile, c.alt_mobile, c.email,
              c.address, c.area, c.city, c.state, c.pincode, c.membership_id, c.birthday,
              c.anniversary, c.price_list_id, pl.price_list_name, c.discount_percent,
              c.communication_preference, c.gstin, c.referral_code, c.home_delivery,
              c.registration_source, c.is_active
       FROM customers c LEFT JOIN price_lists pl ON pl.id = c.price_list_id WHERE c.id = ?`, [id]);
        if (!customer)
            throw new ApiError('not_found', 'Customer not found.', 404);
        const w = await db.query('SELECT balance FROM customer_wallet WHERE customer_id = ?', [id]);
        const [o] = await db.query('SELECT COALESCE(SUM(due_amount), 0) AS t FROM accounts_receivable WHERE customer_id = ? AND due_amount > 0', [id]);
        return ok({ customer: { ...customer, wallet_balance: w[0] ? w[0].balance : '0.00', outstanding_balance: o.t } });
    });
    route('GET', 'customers_edit_detail', 'customers.edit', async (req) => {
        const id = qInt(req.query.id);
        if (id <= 0)
            throw new ApiError('invalid_request', 'A valid customer id is required.', 422);
        const [customer] = await db.query(`SELECT id, title, full_name, mobile, alt_mobile, email, address, area, city, state, pincode,
              membership_id, birthday, anniversary, remarks, home_delivery, marketing_source,
              registration_source, discount_percent, price_list_id, communication_preference,
              gstin, referral_code, is_active
       FROM customers WHERE id = ?`, [id]);
        if (!customer)
            throw new ApiError('not_found', 'Customer not found.', 404);
        return ok({ customer });
    });
    route('GET', 'pos_customer_summary', 'pos.create', async (req) => {
        const customerId = qInt(req.query.customer_id);
        if (!customerId)
            throw new ApiError('invalid_request', 'A valid customer_id is required.', 422);
        const [c] = await db.query('SELECT * FROM customers WHERE id = ? AND is_active = 1', [customerId]);
        if (!c)
            throw new ApiError('not_found', 'Customer not found or inactive.', 404);
        const [o] = await db.query('SELECT COALESCE(SUM(due_amount),0) AS t FROM accounts_receivable WHERE customer_id = ? AND due_amount > 0', [customerId]);
        const walletBalance = await wallet.getBalance(customerId);
        let priceListId = null;
        let priceListName = 'No active Default price list configured';
        try {
            priceListId = await pricing.resolvePriceListId(customerId);
            const [pl] = await db.query('SELECT price_list_name FROM price_lists WHERE id = ?', [priceListId]);
            if (pl)
                priceListName = pl.price_list_name;
        }
        catch {
            priceListId = null;
        }
        return ok({
            customer: {
                id: num(c.id),
                name: `${c.title ?? ''} ${c.full_name}`.trim(),
                mobile: c.mobile,
                address: `${c.address ?? ''} ${c.area ?? ''}`.trim(),
                home_delivery: !!c.home_delivery,
                discount_percent: num(c.discount_percent),
            },
            price_list_id: priceListId,
            price_list_name: priceListName,
            outstanding: num(o.t),
            wallet_balance: walletBalance,
        });
    });
    // ---- writes --------------------------------------------------------------------------
    route('POST', 'customers_create', 'customers.create', async (req, ctx) => {
        const input = body(req);
        const form = formFrom(input, true);
        rejectInvalid(await customers.validate(form.full_name, form.mobile, null, !phpEmpty(input.confirm_different_person)));
        try {
            const r = await customers.create(form, ctx.id, req.ip);
            return ok({ id: r.id, customer_code: r.customer_code, message: 'Customer created.' });
        }
        catch (e) {
            if (e instanceof CodeCollisionError)
                throw new ApiError('save_failed', e.message, 500);
            throw e;
        }
    });
    route('POST', 'customers_update', 'customers.edit', async (req, ctx) => {
        const input = body(req);
        const id = toInt(input.id);
        if (id <= 0)
            throw new ApiError('invalid_request', 'A valid customer id is required.', 422);
        const [existing] = await db.query('SELECT * FROM customers WHERE id = ?', [id]);
        if (!existing)
            throw new ApiError('not_found', 'Customer not found.', 404);
        const form = formFrom(input, false);
        rejectInvalid(await customers.validate(form.full_name, form.mobile, id, !phpEmpty(input.confirm_different_person)));
        await customers.update(id, existing, form, ctx.id, req.ip);
        return ok({ id, message: 'Customer updated.' });
    });
    // ---- wallet --------------------------------------------------------------------------
    route('GET', 'wallet_transactions', 'wallet.manage', async (req) => {
        const q = req.query;
        const search = qStr(q.q);
        let txnType = qStr(q.txn_type);
        if (!['', 'Deposit', 'Redeem', 'Refund', 'Adjustment'].includes(txnType))
            txnType = '';
        let dateFrom = qStr(q.date_from);
        let dateTo = qStr(q.date_to);
        if (dateFrom !== '' && !ISO_DATE.test(dateFrom))
            dateFrom = '';
        if (dateTo !== '' && !ISO_DATE.test(dateTo))
            dateTo = '';
        const page = Math.max(1, qInt(q.page));
        const perPage = 30;
        const where = ['1=1'];
        const params = [];
        if (search !== '') {
            where.push('(c.full_name LIKE ? OR c.mobile LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }
        if (txnType !== '') {
            where.push('wt.txn_type = ?');
            params.push(txnType);
        }
        if (dateFrom !== '') {
            where.push('wt.created_at >= ?');
            params.push(`${dateFrom} 00:00:00`);
        }
        if (dateTo !== '') {
            where.push('wt.created_at <= ?');
            params.push(`${dateTo} 23:59:59`);
        }
        const w = where.join(' AND ');
        const [{ n }] = (await db.query(`SELECT COUNT(*) AS n FROM wallet_transactions wt JOIN customers c ON c.id = wt.customer_id WHERE ${w}`, params));
        const rows = await db.query(`SELECT wt.id, wt.customer_id, c.full_name AS customer_name, c.mobile, wt.order_id, o.order_number, o.short_order_code,
              wt.txn_type, wt.debit, wt.credit, wt.balance_after, wt.remarks, wt.payment_mode, wt.created_at,
              u.full_name AS created_by_name
       FROM wallet_transactions wt
       JOIN customers c ON c.id = wt.customer_id
       LEFT JOIN orders o ON o.id = wt.order_id
       LEFT JOIN users u ON u.id = wt.created_by
       WHERE ${w} ORDER BY wt.created_at DESC, wt.id DESC LIMIT ? OFFSET ?`, [...params, perPage, (page - 1) * perPage]);
        const [sums] = await db.query(`SELECT COALESCE(SUM(debit),0) AS total_debit, COALESCE(SUM(credit),0) AS total_credit FROM wallet_transactions wt JOIN customers c ON c.id = wt.customer_id WHERE ${w}`, params);
        return ok({
            transactions: rows.map((t) => ({
                id: num(t.id), customer_id: num(t.customer_id), customer_name: t.customer_name, mobile: t.mobile,
                order_id: t.order_id !== null ? num(t.order_id) : null, order_number: t.short_order_code ?? t.order_number, txn_type: t.txn_type,
                debit: num(t.debit), credit: num(t.credit), balance_after: num(t.balance_after), remarks: t.remarks,
                payment_mode: t.payment_mode, created_at: t.created_at, created_by_name: t.created_by_name,
            })),
            total_debit: num(sums.total_debit),
            total_credit: num(sums.total_credit),
            page, per_page: perPage, total: num(n),
        });
    });
    route('POST', 'wallet_adjust', 'payments.adjust', async (req, ctx) => {
        const p = req.body;
        if (!p || typeof p !== 'object' || Array.isArray(p))
            throw new ApiError('invalid_request', 'Invalid request payload.', 400);
        const b = p;
        const customerId = toInt(b.customer_id);
        const clientRequestId = String(b.client_request_id ?? '').trim();
        const delta = round2(toFloat(b.delta));
        const reason = String(b.reason ?? '').trim();
        if (!customerId)
            throw new ApiError('invalid_request', 'A valid customer_id is required.', 422);
        if (clientRequestId === '' || clientRequestId.length > 64)
            throw new ApiError('invalid_request', 'A valid client_request_id is required.', 422);
        if (delta === 0)
            throw new ApiError('invalid_request', 'Adjustment amount must not be zero.', 422);
        if (reason === '')
            throw new ApiError('invalid_request', 'A reason is required for a manual wallet adjustment.', 422);
        const exists = await db.query('SELECT id FROM customers WHERE id = ?', [customerId]);
        if (exists.length === 0)
            throw new ApiError('not_found', 'Customer not found.', 404);
        const fingerprint = createHash('sha256').update(`${customerId}|delta:${delta.toFixed(2)}|reason:${reason}`).digest('hex');
        try {
            const r = await wallet.adjust(customerId, delta, reason, { actor: ctx.id, clientRequestId, requestFingerprint: fingerprint });
            return ok({ balance: r.balance, idempotent_replay: r.idempotent_replay ?? false });
        }
        catch (e) {
            if (e instanceof IdempotencyConflictError)
                throw new ApiError('idempotency_conflict', e.message, 409);
            throw new ApiError('validation_failed', e.message, 422);
        }
    });
}
