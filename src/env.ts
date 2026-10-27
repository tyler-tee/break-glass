import { readFileSync } from 'node:fs';
import { z } from 'zod';

const posInt = (def: number) => z.coerce.number().int().positive().default(def);

const envSchema = z.object({
  PORT: posInt(3000),
  DATABASE_PATH: z.string().default('./data/app.db'),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.enum(['anthropic', 'none']).default('none'),
  LLM_API_KEY: z.string().optional(),
  LLM_EXTRACT_MODEL: z.string().default('claude-haiku-5-5'),
  LLM_DRAFT_MODEL: z.string().default('claude-opus-5-5'),
  REFRESH_FAILURE_THRESHOLD: posInt(3),
  RATING_WARN_DELTA: z.coerce.number().min(0).default(0.5),
  PLACES_CALL_CAP: posInt(200),
  PLACES_MONTHLY_CAP: posInt(800),
  PROTOCOL_SOURCE_ALLOWLIST: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  // Empty strings (e.g. 'PORT=' in a .env file) count as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return result.data;
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[key] = value;
  }
  return out;
}

/** Load .env, then .env.local; .env.local overrides .env but never real environment variables. */
export function loadDotEnvFiles(
  paths: string[] = ['.env', '.env.local'],
  target: NodeJS.ProcessEnv = process.env,
): void {
  const fromShell = new Set(Object.keys(target));
  for (const file of paths) {
    try {
      for (const [k, v] of Object.entries(parseDotEnv(readFileSync(file, 'utf8')))) {
        if (!fromShell.has(k)) target[k] = v;
      }
    } catch {
      // file is optional
    }
  }
}
