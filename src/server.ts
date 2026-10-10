import { loadEnv } from './config/env.js';
import { createPool } from './db/pool.js';
import { buildApp, buildServices } from './app.js';

const env = loadEnv();
process.env.TZ = env.APP_TIMEZONE;
const { db, close } = createPool(env);
const app = await buildApp(buildServices(env, db));

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
