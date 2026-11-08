import { BusinessError } from '../lib/errors.js';
import { round2 } from '../lib/php.js';
/** Port of includes/OrderFinance.php. Each method joins an open transaction or opens its own. */
export class OrderFinance {
    db;
    audit;
    constructor(db, audit) {
        this.db = db;
        this.audit = audit;
    }
    /** Same finance bound to a transaction handle (audit rows then roll back with it). */
    using(db) {
        return new OrderFinance(db, this.audit.using(db));
    }
    /** Net paid = Σ(non-refund payment_transactions) − Σ(refund ones); updates orders + receivable. */
    async netPaid(orderId) {
        const rows = await this.db.query(`SELECT p.payment_kind, COALESCE(SUM(pt.amount), 0) AS total
       FROM payment_transactions pt JOIN payments p ON p.id = pt.payment_id
       WHERE p.order_id = ? GROUP BY p.payment_kind`, [orderId]);
        let paid = 0;
        for (const r of rows)
            paid += r.payment_kind === 'Refund' ? -Number(r.total) : Number(r.total);
        return round2(paid);
    }
    recalculatePayments(orderId, actorUserId = null, ip = null) {
        return this.db.tx(async (t) => {
            const self = this.using(t);
            const [order] = await t.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
            if (!order)
                throw new BusinessError(`Order #${orderId} not found.`);
            const totalPaid = await self.netPaid(orderId);
            const currentDue = round2(Number(order.grand_total) - totalPaid);
            await t.execute('UPDATE orders SET total_paid = ?, current_due = ? WHERE id = ?', [totalPaid, currentDue, orderId]);
            await self.syncReceivableInternal(orderId, Number(order.grand_total), totalPaid, currentDue, order.customer_id, order.invoice_number, order.due_date);
            await self.audit.record({ action: 'payment', module: 'orders', recordId: String(orderId), newValue: { total_paid: totalPaid, current_due: currentDue }, userId: actorUserId, ip });
            return { total_paid: totalPaid, current_due: currentDue };
        });
    }
    async syncReceivableInternal(orderId, grandTotal, totalPaid, currentDue, customerId, invoiceNumber, dueDate) {
        const due = Math.max(0, currentDue); // a credit balance is not a receivable
        const exists = await this.db.query('SELECT id FROM accounts_receivable WHERE order_id = ?', [orderId]);
        if (exists.length) {
            await this.db.execute('UPDATE accounts_receivable SET customer_id=?, invoice_number=?, total_amount=?, paid_amount=?, due_amount=?, due_date=? WHERE order_id=?', [customerId, invoiceNumber, grandTotal, totalPaid, due, dueDate, orderId]);
        }
        else {
            await this.db.execute('INSERT INTO accounts_receivable (order_id, customer_id, invoice_number, total_amount, paid_amount, due_amount, due_date) VALUES (?,?,?,?,?,?,?)', [orderId, customerId, invoiceNumber, grandTotal, totalPaid, due, dueDate]);
        }
    }
    markReceivableCancelled(orderId, hadPayments) {
        return this.db.tx(async (t) => {
            const status = hadPayments ? 'Refund Due' : 'Cancelled';
            const rows = await t.query('SELECT id FROM accounts_receivable WHERE order_id = ? FOR UPDATE', [orderId]);
            if (rows.length)
                await t.execute('UPDATE accounts_receivable SET due_amount = 0, status = ? WHERE order_id = ?', [status, orderId]);
        });
    }
}
