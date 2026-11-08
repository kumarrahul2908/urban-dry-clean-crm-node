import { isNumeric, phpRound } from '../lib/php.js';
const MM_PER_INCH = 25.4;
const DEFAULT_TAG = { store_id: null, tag_width_mm: 38.1, tag_height_mm: 78.74, tag_unit: 'in', tag_printer_name: '' };
const DEFAULT_INVOICE = { store_id: null, invoice_printer_type: 'laser', invoice_width_mm: 210, invoice_height_mm: 297, invoice_paper_size: 'a4', invoice_unit: 'mm', invoice_printer_name: '' };
const DEFAULT_DELIVERY = { store_id: null, delivery_printer_type: 'thermal', delivery_width_mm: 80, delivery_height_mm: null, delivery_paper_size: '80mm', delivery_unit: 'mm', delivery_printer_name: '' };
const toMm = (raw, unit) => {
    if (raw === null || raw === undefined || raw === '')
        return null;
    if (!isNumeric(raw))
        return null;
    const v = parseFloat(String(raw));
    if (v <= 0)
        return null;
    return unit === 'in' ? phpRound(v * MM_PER_INCH, 2) : phpRound(v, 2);
};
const len = (s) => Array.from(s).length;
/** Port of includes/PrintConfigService.php (per-store tag / invoice / delivery-slip paper settings). */
export class PrintConfigService {
    db;
    audit;
    constructor(db, audit) {
        this.db = db;
        this.audit = audit;
    }
    static mmToIn = (mm) => phpRound(mm / MM_PER_INCH, 3);
    static inToMm = (inch) => phpRound(inch * MM_PER_INCH, 2);
    async getTagConfig(storeId) {
        const r = (await this.db.query('SELECT store_id, tag_width_mm, tag_height_mm, tag_unit, tag_printer_name FROM store_print_settings WHERE store_id = ?', [storeId]))[0];
        if (!r)
            return { ...DEFAULT_TAG, store_id: storeId };
        return { store_id: Number(r.store_id), tag_width_mm: parseFloat(r.tag_width_mm), tag_height_mm: parseFloat(r.tag_height_mm), tag_unit: r.tag_unit, tag_printer_name: String(r.tag_printer_name ?? '') };
    }
    async getInvoiceConfig(storeId) {
        const r = (await this.db.query('SELECT store_id, invoice_printer_type, invoice_width_mm, invoice_height_mm, invoice_paper_size, invoice_unit, invoice_printer_name FROM store_print_settings WHERE store_id = ?', [storeId]))[0];
        if (!r)
            return { ...DEFAULT_INVOICE, store_id: storeId };
        return {
            store_id: Number(r.store_id), invoice_printer_type: r.invoice_printer_type, invoice_width_mm: parseFloat(r.invoice_width_mm),
            invoice_height_mm: r.invoice_height_mm !== null ? parseFloat(r.invoice_height_mm) : null, invoice_paper_size: r.invoice_paper_size,
            invoice_unit: r.invoice_unit, invoice_printer_name: String(r.invoice_printer_name ?? ''),
        };
    }
    async getDeliveryConfig(storeId) {
        const r = (await this.db.query('SELECT store_id, delivery_printer_type, delivery_width_mm, delivery_height_mm, delivery_paper_size, delivery_unit, delivery_printer_name FROM store_print_settings WHERE store_id = ?', [storeId]))[0];
        if (!r || r.delivery_printer_type === null)
            return { ...DEFAULT_DELIVERY, store_id: storeId };
        return {
            store_id: Number(r.store_id), delivery_printer_type: r.delivery_printer_type, delivery_width_mm: parseFloat(r.delivery_width_mm),
            delivery_height_mm: r.delivery_height_mm !== null ? parseFloat(r.delivery_height_mm) : null, delivery_paper_size: r.delivery_paper_size,
            delivery_unit: r.delivery_unit, delivery_printer_name: String(r.delivery_printer_name ?? ''),
        };
    }
    async getLocalPrintToken(storeId) {
        try {
            const r = (await this.db.query('SELECT local_print_token FROM store_print_settings WHERE store_id = ?', [storeId]))[0];
            const v = r?.local_print_token;
            return v !== undefined && v !== null && v !== '' ? String(v) : null;
        }
        catch {
            return null;
        }
    }
    async resolveStoreIdForOrder(orderId) {
        const r = (await this.db.query('SELECT store_id FROM orders WHERE id = ?', [orderId]))[0];
        return r && r.store_id !== null && r.store_id !== undefined ? Number(r.store_id) : null;
    }
    async saveTagConfig(storeId, input, userId, ip = null) {
        const errors = [];
        const unit = ['in', 'mm'].includes(input.tag_unit) ? input.tag_unit : 'in';
        const width = toMm(input.tag_width, unit), height = toMm(input.tag_height, unit);
        const printer = String(input.tag_printer_name ?? '').trim();
        if (width === null || width < 5 || width > 1000)
            errors.push('Tag width must be a positive value (5mm-1000mm / ~0.2in-39in).');
        if (height === null || height < 5 || height > 1000)
            errors.push('Tag height must be a positive value (5mm-1000mm / ~0.2in-39in).');
        if (len(printer) > 100)
            errors.push('Printer name is too long.');
        if (errors.length)
            return { success: false, errors };
        await this.db.execute(`INSERT INTO store_print_settings (store_id, tag_width_mm, tag_height_mm, tag_unit, tag_printer_name) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE tag_width_mm = VALUES(tag_width_mm), tag_height_mm = VALUES(tag_height_mm), tag_unit = VALUES(tag_unit), tag_printer_name = VALUES(tag_printer_name)`, [storeId, width, height, unit, printer]);
        await this.audit.record({ action: 'edit', module: 'store_print_settings', recordId: String(storeId), newValue: { section: 'tag', tag_width_mm: width, tag_height_mm: height }, userId, ip });
        return { success: true, errors: [] };
    }
    async saveSheet(kind, storeId, input, userId, ip) {
        const label = kind === 'invoice' ? 'Invoice' : 'Delivery slip';
        const errors = [];
        const type = ['thermal', 'laser'].includes(input[`${kind}_printer_type`]) ? input[`${kind}_printer_type`] : (kind === 'invoice' ? 'laser' : 'thermal');
        const unit = ['in', 'mm'].includes(input[`${kind}_unit`]) ? input[`${kind}_unit`] : 'mm';
        const paper = String(input[`${kind}_paper_size`] ?? (type === 'thermal' ? '80mm' : 'a4')).trim();
        const printer = String(input[`${kind}_printer_name`] ?? '').trim();
        const width = toMm(input[`${kind}_width`], unit);
        const hr = input[`${kind}_height`];
        let height = hr !== null && hr !== undefined && hr !== '' ? toMm(hr, unit) : null;
        const noun = kind === 'invoice' ? 'Invoice/receipt' : 'Delivery slip';
        if (width === null || width < 5 || width > 1000)
            errors.push(`${noun} width must be a positive value (5mm-1000mm / ~0.2in-39in).`);
        if (type === 'laser' && (height === null || height < 5 || height > 1000))
            errors.push(`${label} height is required for a laser paper size (5mm-1000mm / ~0.2in-39in).`);
        if (height !== null && (height < 5 || height > 1000))
            errors.push(`${label} height must be a positive value (5mm-1000mm / ~0.2in-39in).`);
        if (len(paper) > 20)
            errors.push('Paper size label is too long.');
        if (len(printer) > 100)
            errors.push('Printer name is too long.');
        if (errors.length)
            return { success: false, errors };
        if (type === 'thermal')
            height = null;
        const k = kind;
        await this.db.execute(`INSERT INTO store_print_settings (store_id, ${k}_printer_type, ${k}_width_mm, ${k}_height_mm, ${k}_paper_size, ${k}_unit, ${k}_printer_name) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE ${k}_printer_type = VALUES(${k}_printer_type), ${k}_width_mm = VALUES(${k}_width_mm), ${k}_height_mm = VALUES(${k}_height_mm),
         ${k}_paper_size = VALUES(${k}_paper_size), ${k}_unit = VALUES(${k}_unit), ${k}_printer_name = VALUES(${k}_printer_name)`, [storeId, type, width, height, paper, unit, printer]);
        await this.audit.record({ action: 'edit', module: 'store_print_settings', recordId: String(storeId), newValue: { section: k, [`${k}_printer_type`]: type, [`${k}_width_mm`]: width, [`${k}_height_mm`]: height }, userId, ip });
        return { success: true, errors: [] };
    }
    saveInvoiceConfig(storeId, input, userId, ip = null) { return this.saveSheet('invoice', storeId, input, userId, ip); }
    saveDeliveryConfig(storeId, input, userId, ip = null) { return this.saveSheet('delivery', storeId, input, userId, ip); }
}
