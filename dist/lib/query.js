/** Query-string helpers matching PHP's (int)/clean_input() casts on $_GET values. */
export const qInt = (v) => {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? n : 0;
};
export const qStr = (v) => String(v ?? '').trim();
