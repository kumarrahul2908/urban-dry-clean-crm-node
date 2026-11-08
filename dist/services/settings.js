/** Port of get_setting(): settings table key/value. Not cached (the PHP cache lived one request). */
export async function getSetting(db, key, fallback = null) {
    const rows = await db.query('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
    const v = rows[0]?.setting_value;
    return v === undefined || v === null ? fallback : v;
}
