import mysql from 'mysql2/promise';
export function createPool(env) {
    const pool = mysql.createPool({
        host: env.DB_HOST,
        port: env.DB_PORT,
        database: env.DB_NAME,
        user: env.DB_USER,
        password: env.DB_PASS,
        charset: 'utf8mb4',
        // The PHP app stores everything in UTC (MySQL NOW()); keep dates as strings, no TZ shifting.
        timezone: 'Z',
        dateStrings: true,
        connectionLimit: 10,
        // PDO-MySQL semantics: affectedRows = rows actually CHANGED (mysql2 defaults to rows matched).
        flags: ['-FOUND_ROWS'],
        namedPlaceholders: false,
    });
    const wrap = (runner, inTx) => ({
        async query(sql, params = []) {
            const [rows] = await runner.query(sql, params);
            return rows;
        },
        async execute(sql, params = []) {
            const [res] = await runner.query(sql, params);
            const r = res;
            return { affectedRows: r.affectedRows, insertId: r.insertId };
        },
        async tx(fn) {
            if (inTx)
                return fn(this); // already inside a transaction: join it
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const out = await fn(wrap(conn, true));
                await conn.commit();
                return out;
            }
            catch (e) {
                await conn.rollback().catch(() => { });
                throw e;
            }
            finally {
                conn.release();
            }
        },
    });
    const db = wrap(pool, false);
    return { db, close: () => pool.end() };
}
