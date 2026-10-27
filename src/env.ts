import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_PATH: z.string().default('./data/app.db'),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.enum(['anthropic', 'none']).default('none'),
  LLM_API_KEY: z.string().optional(),
  LLM_EXTRACT_MODEL: z.string().default('claude-haiku-5-5'),
  LLM_DRAFT_MODEL: z.string().default('claude-opus-5-5'),
  REFRESH_FAILURE_THRESHOLD: z.coerce.number().default(3),
  RATING_WARN_DELTA: z.coerce.number().default(0.5),
  PLACES_CALL_CAP: z.coerce.number().default(200),
  PROTOCOL_SOURCE_ALLOWLIST: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return result.data;
}
