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

  // File storage (Phase 4): order photos + garment images live on this server's disk.
  UPLOAD_DIR: z.string().default('./uploads'),
  /** Safety ceiling per uploaded image, in MB. 0 = no limit at all. Originals are stored byte-for-byte (no recompression). */
  UPLOAD_MAX_MB: z.coerce.number().min(0).default(100),
  /** Order photos older than this many days are deleted by the daily job. 0 = never auto-delete. Overridable via settings.order_photo_retention_days. */
  PHOTO_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  /** Serve /uploads from this process (dev). In production let nginx serve UPLOAD_DIR directly. */
  SERVE_UPLOADS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ALLOWED_IMAGE_TYPES: z.string().default('jpg,jpeg,png,webp'),

  // Multi-tenant mode (SaaS, one database per business). Unset CONTROL_DB_NAME = classic single-business mode.
  CONTROL_DB_NAME: z.string().default(''),
  CONTROL_DB_HOST: z.string().optional(),
  CONTROL_DB_PORT: z.coerce.number().optional(),
  CONTROL_DB_USER: z.string().optional(),
  CONTROL_DB_PASS: z.string().optional(),
  /** Encrypts per-tenant DB passwords / app secrets stored in the control DB. */
  CONTROL_MASTER_KEY: z.string().default(''),

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
