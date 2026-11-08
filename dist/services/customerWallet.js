import { round2 } from '../lib/php.js';
import { BusinessError, IdempotencyConflictError } from '../lib/errors.js';
export { IdempotencyConflictError };
export class WalletError extends BusinessError {
}
/**
 * Port of includes/CustomerWallet.php. Balance changes run under SELECT ... FOR UPDATE; the
 * ledger (wallet_transactions) row and the cached balance are written in the same transaction.
 * Pass `db` already inside a transaction (db.tx) to join a larger flow, or use it directly for a
 * self-contained one.
 */
export class CustomerWallet {
    db;
    audit;
    constructor(db, audit) {
        this.db = db;
        this.audit = audit;
    }
    /** Same wallet bound to another Db (e.g. an open transaction), so ledger writes join it. */
    using(db) {
        return new CustomerWallet(db, this.audit.using(db));
    }
    deposit(customerId, amount, paymentMode = null, remarks = null, orderId = null, actor = null, ip = null) {
        return this.apply(customerId, 'Deposit', 0, amount, { paymentMode, remarks, orderId, actor, ip });
    }
    redeem(customerId, amount, remarks = null, orderId = null, actor = null, ip = null) {
        return this.apply(customerId, 'Redeem', amount, 0, { remarks, orderId, actor, ip });
    }
    refund(customerId, amount, paymentMode = null, remarks = null, orderId = null, actor = null, ip = null) {
        return this.apply(customerId, 'Refund', 0, amount, { paymentMode, remarks, orderId, actor, ip });
    }
    adjust(customerId, delta, remarks, o = {}) {
        const opts = { remarks, orderId: o.orderId ?? null, actor: o.actor ?? null, ip: o.ip ?? null, clientRequestId: o.clientRequestId ?? null, requestFingerprint: o.requestFingerprint ?? null };
        return delta >= 0 ? this.apply(customerId, 'Adjustment', 0, delta, opts) : this.apply(customerId, 'Adjustment', Math.abs(delta), 0, opts);
    }
    apply(customerId, type, debit, credit, o) {
        if (debit < 0 || credit < 0)
            throw new Error('Wallet amounts must not be negative.');
        return this.db.tx(async (t) => {
            const rows = await t.query('SELECT balance FROM customer_wallet WHERE customer_id = ? FOR UPDATE', [customerId]);
            let current = 0;
            if (rows.length === 0)
                await t.execute('INSERT INTO customer_wallet (customer_id, balance) VALUES (?, 0)', [customerId]);
            else
                current = Number(rows[0].balance);
            if (o.clientRequestId) {
                const ex = await t.query('SELECT id, balance_after, request_fingerprint FROM wallet_transactions WHERE client_request_id = ? AND customer_id = ?', [o.clientRequestId, customerId]);
                if (ex[0]) {
                    if (o.requestFingerprint && ex[0].request_fingerprint === o.requestFingerprint) {
                        return { success: true, balance: Number(ex[0].balance_after), idempotent_replay: true };
                    }
                    throw new IdempotencyConflictError('This adjustment request was already submitted with different details. Refresh and try again if this is a new adjustment.');
                }
            }
            if (type === 'Redeem' && debit > current)
                throw new WalletError('Insufficient wallet balance for this redemption.');
            const newBalance = round2(current - debit + credit);
            await t.execute(`INSERT INTO wallet_transactions
           (customer_id, order_id, txn_type, debit, credit, balance_after, payment_mode, remarks, client_request_id, request_fingerprint, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [customerId, o.orderId ?? null, type, debit, credit, newBalance, o.paymentMode ?? null, o.remarks ?? null, o.clientRequestId ?? null, o.requestFingerprint ?? null, o.actor ?? null]);
            await t.execute('UPDATE customer_wallet SET balance = ? WHERE customer_id = ?', [newBalance, customerId]);
            await this.audit.record({ action: 'edit', module: 'wallet', recordId: String(customerId), oldValue: { balance_before: current }, newValue: { balance_after: newBalance, type }, userId: o.actor ?? null, ip: o.ip ?? null });
            return { success: true, balance: newBalance };
        });
    }
    /** Recompute the cached balance purely from the ledger. */
    recalculate(customerId) {
        return this.db.tx(async (t) => {
            await t.query('SELECT balance FROM customer_wallet WHERE customer_id = ? FOR UPDATE', [customerId]);
            const [row] = await t.query('SELECT COALESCE(SUM(credit - debit), 0) AS total FROM wallet_transactions WHERE customer_id = ?', [customerId]);
            const computed = round2(Number(row.total));
            await t.execute('UPDATE customer_wallet SET balance = ? WHERE customer_id = ?', [computed, customerId]);
            return computed;
        });
    }
    async getBalance(customerId) {
        const r = await this.db.query('SELECT balance FROM customer_wallet WHERE customer_id = ?', [customerId]);
        return r[0] ? Number(r[0].balance) : 0;
    }
}
