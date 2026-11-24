import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Architecture test (brief §3): the model gateway is the only file allowed to call
 * a model, and this is what makes that claim true rather than aspirational.
 *
 * Without it, the send-less guard, the spend cap, the cache and the cost ledger are
 * all optional — any step could import the SDK and quietly skip every one of them.
 */

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/** Packages that talk to a model provider. */
const PROVIDER_PACKAGES = [
  '@google/genai',
  '@google-cloud/aiplatform',
  'openai',
  '@anthropic-ai/sdk',
  'portkey-ai',
  '@portkey-ai/gateway',
  'cohere-ai',
  '@mistralai/mistralai',
  'groq-sdk',
  'ollama',
];

/** Only these files may import one. */
const ALLOWED = [
  join('src', 'lib', 'gateway', 'providers'),
];

/** Provider endpoints that a hand-rolled fetch could reach instead of the SDK. */
const PROVIDER_ENDPOINTS = [
  'generativelanguage.googleapis.com',
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai/api',
  'api.portkey.ai',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function isAllowed(file: string): boolean {
  const rel = relative(ROOT, file);
  return ALLOWED.some((prefix) => rel.startsWith(prefix + sep) || rel.startsWith(prefix));
}

describe('the gateway is the only module that calls a model', () => {
  const files = walk(SRC);

  it('finds source files to check', () => {
    assert.ok(files.length > 0, 'no TypeScript files found under src/');
  });

  it('no file outside gateway/providers imports a provider SDK', () => {
    const offenders: string[] = [];

    for (const file of files) {
      if (isAllowed(file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const pkg of PROVIDER_PACKAGES) {
        // Match an import or require of the package, not a mention in a comment.
        const re = new RegExp(
          String.raw`(?:^|\n)\s*(?:import[^;]*from\s*|import\s*\(|require\s*\()\s*['"]${pkg.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          )}`,
        );
        if (re.test(source)) offenders.push(`${relative(ROOT, file)} imports ${pkg}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Only src/lib/gateway/providers may import a model SDK.\n${offenders.join('\n')}`,
    );
  });

  it('no file outside gateway/providers calls a provider endpoint directly', () => {
    const offenders: string[] = [];

    for (const file of files) {
      if (isAllowed(file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const host of PROVIDER_ENDPOINTS) {
        if (source.includes(host)) offenders.push(`${relative(ROOT, file)} references ${host}`);
      }
    }

    assert.deepEqual(offenders, [], offenders.join('\n'));
  });

  it('every provider implementation lives in the allowed directory', () => {
    const providerDir = join(SRC, 'lib', 'gateway', 'providers');
    const providers = readdirSync(providerDir).filter((f) => f.endsWith('.ts'));
    assert.ok(providers.includes('gemini.ts'), 'expected a gemini provider');
    assert.ok(providers.includes('offline.ts'), 'expected an offline provider');
  });
});
