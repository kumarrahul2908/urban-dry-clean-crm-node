import { loadEnv } from './config/env.js';
import { createPool } from './db/pool.js';
import { buildApp, buildServices } from './app.js';
import { createMultiTenant } from './tenancy/runtime.js';
const env = loadEnv();
process.env.TZ = env.APP_TIMEZONE;
let app;
let closeAll;
if (env.CONTROL_DB_NAME) {
    // SaaS mode: one database per business, resolved from the request hostname (see docs/SAAS-DESIGN.md)
    const mt = createMultiTenant(env);
    app = await buildApp(mt.services, mt);
    closeAll = () => mt.close();
}
else {
    const { db, close } = createPool(env);
    app = await buildApp(buildServices(env, db));
    closeAll = close;
}
const shutdown = async () => {
    await app.close();
    await closeAll();
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ port: env.PORT, host: env.HOST });
