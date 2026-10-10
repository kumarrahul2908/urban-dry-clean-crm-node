import 'dotenv/config';
import { z } from 'zod';

// Mirrors config/config.sample.php of the PHP app (same names, same defaults).
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(3306),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASS: z.string().default(''),

  APP_NAME: z.string().default('URBAN DRY CLEAN'),
  APP_URL: z.string().default('http://localhost:3000'),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  APP_SECRET_KEY: z.string().default(''),

  SESSION_LIFETIME_MINUTES: z.coerce.number().default(120),
  MAX_LOGIN_ATTEMPTS: z.coerce.number().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().default(15),
  API_TOKEN_LIFETIME_DAYS: z.coerce.number().default(30),

  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
