import { checkDate, monthStartIn, todayIn } from '../lib/dates.js';
import { isNumeric, phpEmpty, round2, toFloat, toInt } from '../lib/php.js';
export const EXPENSE_TYPES = ['expense', 'income'];
const strictDate = (d) => {
    if (typeof d !== 'string')
        return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    return !!m && checkDate(Number(m[1]), Number(m[2]), Number(m[3]));
};
const chars = (s, n) => [...s].slice(0, n).join('');
/** Port of includes/ExpenseService.php (expenses + income ledger). */
export class ExpenseService {
    db;
    audit;
    tz;
    constructor(db, audit, tz) {
        this.db = db;
        this.audit = audit;
        this.tz = tz;
    }
    async paymentModes() {
        const rows = await this.db.query('SELECT type_name FROM payment_types WHERE is_active = 1 ORDER BY id');
        return rows.map((r) => String(r.type_name)).filter((n) => n.toLowerCase() !== 'wallet');
    }
    async categories(activeOnly = false) {
        const rows = await this.db.query(`SELECT id, category_name, is_active FROM expense_categories${activeOnly ? ' WHERE is_active = 1' : ''} ORDER BY category_name`);
        return rows.map((r) => ({ id: Number(r.id), category_name: r.category_name, is_active: !!r.is_active }));
    }
    range(from, to) {
        let f = strictDate(from) ? from : monthStartIn(this.tz);
        let t = strictDate(to) ? to : todayIn(this.tz);
        if (f > t)
            [f, t] = [t, f];
        return [f, t];
    }
    async listEntries(type, f) {
        const [from, to] = this.range(f.from, f.to);
        const perPage = Math.max(1, Math.min(100, toInt(f.per_page ?? 25)));
        const page = Math.max(1, toInt(f.page ?? 1));
        const where = [];
        const params = [];
        let base, select, order, byGroup, alias;
        const qv = String(f.q ?? '').trim();
        if (type === 'expense') {
            alias = 'e';
            where.push('e.expense_date BETWEEN ? AND ?');
            params.push(from, to);
            if (!phpEmpty(f.category_id)) {
                where.push('e.category_id = ?');
                params.push(toInt(f.category_id));
            }
            if (qv !== '') {
                where.push('(e.description LIKE ? OR e.vendor LIKE ? OR e.remarks LIKE ?)');
                params.push(`%${qv}%`, `%${qv}%`, `%${qv}%`);
            }
            base = `FROM expenses e JOIN expense_categories c ON c.id = e.category_id LEFT JOIN users u ON u.id = e.created_by WHERE ${where.join(' AND ')}`;
            select = 'SELECT e.id, e.expense_date AS entry_date, e.category_id, c.category_name, e.description, e.amount, e.payment_mode, e.vendor, e.remarks, e.created_by, u.full_name AS created_by_name, e.created_at';
            order = 'ORDER BY e.expense_date DESC, e.id DESC';
            byGroup = `SELECT c.category_name AS label, SUM(e.amount) AS total ${base} GROUP BY c.category_name ORDER BY total DESC`;
        }
        else {
            alias = 'i';
            where.push('i.income_date BETWEEN ? AND ?');
            params.push(from, to);
            if (qv !== '') {
                where.push('(i.source LIKE ? OR i.description LIKE ? OR i.remarks LIKE ?)');
                params.push(`%${qv}%`, `%${qv}%`, `%${qv}%`);
            }
            base = `FROM income i LEFT JOIN users u ON u.id = i.created_by WHERE ${where.join(' AND ')}`;
            select = 'SELECT i.id, i.income_date AS entry_date, i.source, i.description, i.amount, i.payment_mode, i.remarks, i.created_by, u.full_name AS created_by_name, i.created_at';
            order = 'ORDER BY i.income_date DESC, i.id DESC';
            byGroup = `SELECT i.source AS label, SUM(i.amount) AS total ${base} GROUP BY i.source ORDER BY total DESC`;
        }
        const [agg] = await this.db.query(`SELECT COUNT(*) AS c, COALESCE(SUM(${alias}.amount), 0) AS s ${base}`, params);
        const rows = await this.db.query(`${select} ${base} ${order} LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params);
        const groups = await this.db.query(byGroup, params);
        return {
            type, from, to, page, per_page: perPage,
            total_count: Number(agg.c), total_amount: round2(toFloat(agg.s)),
            by_group: groups.map((r) => ({ label: r.label, total: round2(toFloat(r.total)) })),
            entries: rows.map((r) => ({ ...r, id: Number(r.id), amount: Number(r.amount), ...(r.category_id !== undefined && r.category_id !== null ? { category_id: Number(r.category_id) } : {}) })),
        };
    }
    async find(type, id) {
        const [r] = await this.db.query(type === 'expense' ? 'SELECT * FROM expenses WHERE id = ?' : 'SELECT * FROM income WHERE id = ?', [id]);
        return r ?? null;
    }
    async saveCategory(id, nameIn, active, userId, ip = null) {
        const name = nameIn.trim();
        if ((id === null || name !== '') && (name === '' || [...name].length > 100))
            return { success: false, errors: ['Category name is required (max 100 characters).'] };
        try {
            if (id === null) {
                const ins = await this.db.execute('INSERT INTO expense_categories (category_name, is_active) VALUES (?, 1)', [name]);
                await this.audit.record({ action: 'create', module: 'expense_categories', recordId: String(ins.insertId), newValue: { category_name: name }, userId, ip });
                return { success: true, id: ins.insertId, errors: [] };
            }
            const [old] = await this.db.query('SELECT * FROM expense_categories WHERE id = ?', [id]);
            if (!old)
                return { success: false, errors: ['Category not found.'] };
            const next = { category_name: name !== '' ? name : old.category_name, is_active: active === null ? Number(old.is_active) : (active ? 1 : 0) };
            if (next.category_name === old.category_name && next.is_active === Number(old.is_active))
                return { success: true, id, errors: [] };
            await this.db.execute('UPDATE expense_categories SET category_name = ?, is_active = ? WHERE id = ?', [next.category_name, next.is_active, id]);
            await this.audit.record({ action: 'edit', module: 'expense_categories', recordId: String(id), oldValue: { category_name: old.category_name, is_active: Number(old.is_active) }, newValue: next, userId, ip });
            return { success: true, id, errors: [] };
        }
        catch (e) {
            if (e.code === 'ER_DUP_ENTRY')
                return { success: false, errors: ['A category with that name already exists.'] };
            throw e;
        }
    }
    async validate(type, input) {
        const errors = [];
        const str = (k, max) => chars(String(typeof input[k] === 'object' || input[k] === undefined || input[k] === null ? '' : input[k]).trim(), max);
        const dateKey = type === 'expense' ? 'expense_date' : 'income_date';
        const date = str('entry_date', 10) || str(dateKey, 10);
        if (!strictDate(date))
            errors.push('A valid date (YYYY-MM-DD) is required.');
        const amountRaw = input.amount ?? null;
        const amount = isNumeric(amountRaw) ? round2(toFloat(amountRaw)) : null;
        if (amount === null || amount <= 0)
            errors.push('Amount must be greater than zero.');
        else if (amount > 9999999999.99)
            errors.push('Amount is too large.');
        const mode = str('payment_mode', 30);
        if (mode !== '' && !(await this.paymentModes()).includes(mode))
            errors.push('Choose a valid payment mode.');
        const description = str('description', 255) || null;
        const remarks = str('remarks', 255) || null;
        let data;
        if (type === 'expense') {
            const cat = toInt(input.category_id ?? 0);
            const [c] = await this.db.query('SELECT is_active FROM expense_categories WHERE id = ?', [cat]);
            if (!c)
                errors.push('Choose a category.');
            else if (!Number(c.is_active))
                errors.push('That category is inactive.');
            data = { expense_date: date, category_id: cat, description, amount, payment_mode: mode || null, vendor: str('vendor', 120) || null, remarks };
        }
        else {
            const source = str('source', 120);
            if (source === '')
                errors.push('Source is required (who or what the income came from).');
            data = { income_date: date, source, description, amount, payment_mode: mode || null, remarks };
        }
        return { errors, data };
    }
    async save(type, id, input, userId, ip = null) {
        const v = await this.validate(type, input);
        if (v.errors.length)
            return { success: false, errors: v.errors };
        const d = v.data;
        const table = type === 'expense' ? 'expenses' : 'income';
        const cols = type === 'expense'
            ? ['expense_date', 'category_id', 'description', 'amount', 'payment_mode', 'vendor', 'remarks']
            : ['income_date', 'source', 'description', 'amount', 'payment_mode', 'remarks'];
        return this.db.tx(async (t) => {
            const audit = this.audit.using(t);
            if (id === null) {
                const match = cols.map((c) => `${c} <=> ?`).join(' AND ');
                const [dup] = await t.query(`SELECT id FROM ${table} WHERE created_by = ? AND created_at >= (NOW() - INTERVAL 2 MINUTE) AND ${match} ORDER BY id DESC LIMIT 1 FOR UPDATE`, [userId, ...cols.map((c) => d[c])]);
                if (dup)
                    return { success: true, id: Number(dup.id), duplicate: true, changed: false, errors: [] };
                const ins = await t.execute(`INSERT INTO ${table} (${cols.join(',')}, created_by) VALUES (${cols.map(() => '?').join(',')}, ?)`, [...cols.map((c) => d[c]), userId]);
                await audit.record({ action: 'create', module: table, recordId: String(ins.insertId), newValue: d, userId, ip });
                return { success: true, id: ins.insertId, duplicate: false, changed: true, errors: [] };
            }
            const [old] = await t.query(`SELECT * FROM ${table} WHERE id = ? FOR UPDATE`, [id]);
            if (!old)
                return { success: false, not_found: true, errors: ['Entry not found.'] };
            const before = {};
            const after = {};
            for (const c of cols) {
                const o = old[c];
                const n = d[c];
                const same = c === 'amount' ? Math.abs(Number(o) - Number(n)) < 0.005 : String(o ?? '') === String(n ?? '');
                if (!same) {
                    before[c] = o;
                    after[c] = n;
                }
            }
            if (Object.keys(after).length === 0)
                return { success: true, id, duplicate: false, changed: false, errors: [] };
            const keys = Object.keys(after);
            await t.execute(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => after[k]), id]);
            await audit.record({ action: 'edit', module: table, recordId: String(id), oldValue: before, newValue: after, userId, ip });
            return { success: true, id, duplicate: false, changed: true, errors: [] };
        });
    }
}
