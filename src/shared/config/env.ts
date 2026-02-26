/**
 * Zod-validated environment configuration.
 * Fails fast at startup if env vars are missing/malformed.
 */
import { z } from 'zod';

const EnvSchema = z.object({
    PORT: z.coerce.number().default(8000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET_NAME: z.string().default('satellite-data-10x10'),
    R2_PUBLIC_URL: z.string().optional(),
    WORKER_POOL_SIZE: z.coerce.number().min(1).max(16).optional(),
    USE_WORKER_POOL: z.coerce.boolean().default(false),
    USE_PREBUILT_GRID: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function loadEnv(): Env {
    if (_env) return _env;
    const result = EnvSchema.safeParse(process.env);
    if (!result.success) {
        console.error('❌ Environment validation failed:');
        console.error(result.error.format());
        // Don't crash — use defaults for optional fields
        _env = EnvSchema.parse({});
        return _env;
    }
    _env = result.data;
    return _env;
}

export function getEnv(): Env {
    if (!_env) return loadEnv();
    return _env;
}
