/** Same JSON envelope as mobile_json_success / mobile_json_error in the PHP app. */
export class ApiError extends Error {
    code;
    status;
    extra;
    constructor(code, message, status, 
    /** Extra fields merged into the error object (e.g. billing_unit), like mobile_json_error's $extra. */
    extra = {}) {
        super(message);
        this.code = code;
        this.status = status;
        this.extra = extra;
    }
}
export const ok = (data) => ({ success: true, data });
/** Numeric helpers: MySQL DECIMALs arrive as strings from mysql2; PHP cast them with (float). */
export const num = (v) => Number(v);
export const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
