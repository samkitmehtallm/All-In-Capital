/**
 * Environment loading for scripts.
 *
 * Next.js reads `.env.local` ahead of `.env` automatically; a plain `tsx` script
 * does not, and `dotenv/config` only loads `.env`. Without this, a script reports
 * "OPENROUTER_API_KEY is not set" while the dev server using the same key works
 * fine — which sends you looking at the provider instead of the loader.
 *
 * Import this first, before anything that reads process.env:
 *   import './load-env';
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { config } from 'dotenv';

const ROOT = join(import.meta.dirname, '..');

// Same precedence as Next.js: .env.local wins, .env fills gaps. dotenv does not
// overwrite an already-set variable, so load the winner first.
for (const file of ['.env.local', '.env']) {
  const path = join(ROOT, file);
  if (existsSync(path)) config({ path, quiet: true });
}
