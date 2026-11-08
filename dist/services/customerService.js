import { similarTextPercent } from '../lib/php.js';
import { generateCustomerCode } from './documentNumber.js';
import { getSetting } from './settings.js';
export class CodeCollisionError extends Error {
}
/** Port of check_customer_duplicate(): same last-10-digits mobile match and ≥85% name similarity. */
export async function checkCustomerDuplicate(db, mobile, name, excludeId) {
    const normalized = mobile.replace(/[ -]/g, '').slice(-10);
    let sql = "SELECT id, customer_code, full_name, mobile FROM customers WHERE RIGHT(REPLACE(REPLACE(mobile, ' ', ''), '-', ''), 10) = ? AND is_active = 1";
    const params = [normalized];
    if (excludeId !== null) {
        sql += ' AND id != ?';
        params.push(excludeId);
    }
    const matches = await db.query(sql, params);
    if (matches.length === 0)
        return { action: 'allow', matches };
    const nameNorm = name.trim().toLowerCase();
    for (const m of matches) {
        const mNorm = m.full_name.trim().toLowerCase();
        if (nameNorm === mNorm)
            return { action: 'block', matches, matched_customer: m, reason: 'exact_name_match' };
        if (nameNorm !== '' && mNorm !== '' && similarTextPercent(nameNorm, mNorm) >= 85) {
            return { action: 'block', matches, matched_customer: m, reason: 'similar_name_match' };
        }
    }
    return { action: 'warn', matches };
}
/** Port of includes/CustomerService.php. */
export class CustomerService {
    db;
    audit;
    constructor(db, audit) {
        this.db = db;
        this.audit = audit;
    }
    async validate(fullName, mobile, excludeId, duplicateOverride) {
        const fieldErrors = {};
        if (fullName.trim() === '')
            fieldErrors.full_name = 'Customer name is required.';
        if (mobile === '' || !/^[0-9+ -]{7,15}$/.test(mobile))
            fieldErrors.mobile = 'A valid mobile number is required.';
        if (Object.keys(fieldErrors).length)
            return { status: 'invalid', fieldErrors };
        const dup = await checkCustomerDuplicate(this.db, mobile, fullName, excludeId);
        if (dup.action === 'block' && dup.reason === 'exact_name_match')
            return { status: 'duplicate_blocked', matched_customer: dup.matched_customer };
        if (dup.action === 'block' && dup.reason === 'similar_name_match' && !duplicateOverride) {
            return { status: 'duplicate_requires_confirmation', matched_customer: dup.matched_customer };
        }
        return { status: 'ok', matches: dup.matches };
    }
    /** INSERT (+ retry once on duplicate code/barcode) + wallet row + audit log, in that (non-atomic) order like PHP. */
    async create(input, userId, ip = null) {
        let attempts = 0;
        let id = null;
        let code = '';
        while (attempts < 2 && id === null) {
            attempts++;
            code = await generateCustomerCode(this.db);
            const barcode = `${(await getSetting(this.db, 'barcode_prefix', 'UDC')) ?? 'UDC'}-CUST-${code.slice(-6)}`;
            try {
                const r = await this.db.execute(`INSERT INTO customers (customer_code, title, full_name, address, area, city, state, pincode, mobile,
             alt_mobile, email, membership_id, barcode, birthday, anniversary, remarks, home_delivery,
             marketing_source, registration_source, discount_percent, price_list_id, communication_preference,
             gstin, referral_code, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
                    code, input.title, input.full_name, input.address, input.area, input.city, input.state, input.pincode, input.mobile,
                    input.alt_mobile, input.email, input.membership_id || null, barcode, input.birthday || null, input.anniversary || null,
                    input.remarks, input.home_delivery, input.marketing_source, input.registration_source, input.discount_percent || 0,
                    input.price_list_id || null, input.communication_preference, input.gstin || null, input.referral_code || null, userId,
                ]);
                id = r.insertId;
            }
            catch (e) {
                if (e.code === 'ER_DUP_ENTRY' && attempts < 2)
                    continue;
                throw new CodeCollisionError('Could not save customer due to a duplicate code/barcode conflict. Please try again.');
            }
        }
        await this.db.execute('INSERT INTO customer_wallet (customer_id, balance) VALUES (?, 0)', [id]);
        await this.audit.record({ action: 'create', module: 'customers', recordId: String(id), newValue: input, userId, ip });
        return { id: id, customer_code: code };
    }
    async update(id, existing, input, userId, ip = null) {
        await this.db.execute(`UPDATE customers SET title=?, full_name=?, address=?, area=?, city=?, state=?, pincode=?, mobile=?,
         alt_mobile=?, email=?, membership_id=?, birthday=?, anniversary=?, remarks=?, home_delivery=?,
         marketing_source=?, registration_source=?, discount_percent=?, price_list_id=?, communication_preference=?,
         gstin=?, referral_code=?, is_active=? WHERE id=?`, [
            input.title, input.full_name, input.address, input.area, input.city, input.state, input.pincode, input.mobile,
            input.alt_mobile, input.email, input.membership_id || null, input.birthday || null, input.anniversary || null,
            input.remarks, input.home_delivery, input.marketing_source, input.registration_source, input.discount_percent || 0,
            input.price_list_id || null, input.communication_preference, input.gstin || null, input.referral_code || null,
            input.is_active ?? 0, id,
        ]);
        await this.audit.record({ action: 'edit', module: 'customers', recordId: String(id), oldValue: existing, newValue: input, userId, ip });
    }
}
