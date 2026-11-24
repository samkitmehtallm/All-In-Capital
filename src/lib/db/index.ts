/**
 * Store factory.
 *
 * `DATA_BACKEND=supabase` uses Postgres through the service key; anything else uses
 * the local JSON store. Test and live are separate databases by configuration, not
 * by convention: SUPABASE_URL for live, SUPABASE_TEST_URL when NODE_ENV=test, and a
 * refusal to start if a test run would point at the live project (brief §2.8).
 */

import { LocalStore } from './local';
import type { Store } from './store';

export * from './store';

let instance: Store | null = null;

export async function getStore(): Promise<Store> {
  if (instance) return instance;

  const backend = process.env.DATA_BACKEND ?? 'local';

  if (backend === 'supabase') {
    const { SupabaseStore } = await import('./supabase');
    instance = new SupabaseStore();
  } else {
    instance = new LocalStore();
  }

  return instance;
}

/** Tests and scripts that need a clean slate. */
export function setStore(store: Store | null): void {
  instance = store;
}
