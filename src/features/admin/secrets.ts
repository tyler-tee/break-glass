import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { appSecrets } from '../../db/schema.js';
import type { Env } from '../../env.js';

export type SecretName = 'adminHash' | 'sessionSecret' | 'placesKey' | 'anthropicKey';

// Logical secret -> env var that overrides it, and the app_secrets row key it is stored under.
const SOURCES = {
  adminHash: { envVar: 'ADMIN_PASSWORD_HASH', dbKey: 'admin_password_hash' },
  sessionSecret: { envVar: 'SESSION_SECRET', dbKey: 'session_secret' },
  placesKey: { envVar: 'GOOGLE_PLACES_API_KEY', dbKey: 'google_places_api_key' },
  anthropicKey: { envVar: 'LLM_API_KEY', dbKey: 'anthropic_api_key' },
} as const satisfies Record<SecretName, { envVar: keyof Env; dbKey: string }>;

/** Thrown when code tries to change a secret the environment provides. Names the secret, never its value. */
export class EnvProvidedSecretError extends Error {
  constructor(public secret: SecretName) {
    super(`${secret} is set by the server environment (${SOURCES[secret].envVar}) and cannot be changed here`);
    this.name = 'EnvProvidedSecretError';
  }
}

export type SecretsStore = {
  getAdminHash(): string | undefined;
  setAdminHash(hash: string): void;
  clearAdminHash(): void;
  /** Env SESSION_SECRET, else the stored one, generating and persisting 32 random bytes (hex) on first use. */
  getSessionSecret(): string;
  rotateSessionSecret(): void;
  getPlacesKey(): string | undefined;
  /** A blank value is a no-op (keeps the existing key); use removePlacesKey to clear. */
  setPlacesKey(value: string): void;
  removePlacesKey(): void;
  getAnthropicKey(): string | undefined;
  /** A blank value is a no-op (keeps the existing key); use removeAnthropicKey to clear. */
  setAnthropicKey(value: string): void;
  removeAnthropicKey(): void;
  isEnvProvided(secret: SecretName): boolean;
};

const newSessionSecret = (): string => randomBytes(32).toString('hex');

export function createSecretsStore(db: Db, env: Env): SecretsStore {
  const envValue = (s: SecretName): string | undefined => {
    const v = env[SOURCES[s].envVar];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  const isEnvProvided = (s: SecretName): boolean => envValue(s) !== undefined;

  const readDb = (s: SecretName): string | undefined =>
    db.select({ value: appSecrets.value }).from(appSecrets).where(eq(appSecrets.key, SOURCES[s].dbKey)).get()?.value;

  const get = (s: SecretName): string | undefined => envValue(s) ?? readDb(s);

  const guard = (s: SecretName): void => {
    if (isEnvProvided(s)) throw new EnvProvidedSecretError(s);
  };

  const write = (s: SecretName, value: string): void => {
    guard(s);
    const updatedAt = new Date();
    db.insert(appSecrets)
      .values({ key: SOURCES[s].dbKey, value, updatedAt })
      .onConflictDoUpdate({ target: appSecrets.key, set: { value, updatedAt } })
      .run();
  };

  const remove = (s: SecretName): void => {
    guard(s);
    db.delete(appSecrets).where(eq(appSecrets.key, SOURCES[s].dbKey)).run();
  };

  const setKey = (s: SecretName, value: string): void => {
    guard(s);
    const trimmed = value.trim();
    if (trimmed === '') return;
    write(s, trimmed);
  };

  return {
    getAdminHash: () => get('adminHash'),
    setAdminHash: (hash) => {
      guard('adminHash');
      if (hash === '') throw new Error('adminHash must not be empty');
      write('adminHash', hash);
    },
    clearAdminHash: () => remove('adminHash'),
    getSessionSecret: () => {
      const existing = get('sessionSecret');
      if (existing !== undefined) return existing;
      // Insert-if-absent then re-read, so two processes racing on first boot agree on one secret.
      db.insert(appSecrets)
        .values({ key: SOURCES.sessionSecret.dbKey, value: newSessionSecret(), updatedAt: new Date() })
        .onConflictDoNothing()
        .run();
      const stored = readDb('sessionSecret');
      if (stored === undefined) throw new Error('sessionSecret could not be persisted');
      return stored;
    },
    rotateSessionSecret: () => write('sessionSecret', newSessionSecret()),
    getPlacesKey: () => get('placesKey'),
    setPlacesKey: (v) => setKey('placesKey', v),
    removePlacesKey: () => remove('placesKey'),
    getAnthropicKey: () => get('anthropicKey'),
    setAnthropicKey: (v) => setKey('anthropicKey', v),
    removeAnthropicKey: () => remove('anthropicKey'),
    isEnvProvided,
  };
}
