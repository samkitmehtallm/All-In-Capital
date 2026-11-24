/**
 * Architecture test: nothing that reaches the database or a model may be
 * imported by a client component.
 *
 * `import 'server-only'` is the usual way to state this, and it is used where it
 * can be. It cannot be used everywhere: `src/lib/email/draft.ts` and
 * `src/lib/queue/runners.ts` are both imported by CLI entry points (`pnpm draft`,
 * `pnpm worker`), and that marker throws the moment a plain Node process loads
 * the module. It is also not transitive, so marking a caller never protected
 * `getStore` underneath it.
 *
 * So the boundary is asserted here instead, by reading the imports. This is
 * stronger than the marker in two ways: it covers the modules that cannot carry
 * one, and it names the offending file and the chain that reached it rather than
 * failing at build time with a stack trace in a bundler.
 *
 * What is at stake is the service key. It bypasses row-level security by design,
 * which is safe only while it stays on the server.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/** Modules that must never end up in a browser bundle. */
const SERVER_ONLY = [
  join('src', 'lib', 'db'),
  join('src', 'lib', 'email', 'draft.ts'),
  join('src', 'lib', 'queue'),
  join('src', 'lib', 'gateway'),
  join('src', 'lib', 'application.ts'),
  join('src', 'lib', 'board.ts'),
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

const FILES = walk(SRC);

function isClientComponent(file: string): boolean {
  const head = readFileSync(file, 'utf8').slice(0, 200);
  return /^\s*['"]use client['"]/m.test(head);
}

/** Local imports only: a bare specifier is a package, not a file. */
function localImportsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const re = /\bfrom\s+['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

/**
 * Resolve an extensionless specifier the way the bundler would.
 *
 * `./foo` may be `foo.ts`, `foo.tsx` or `foo/index.ts`. Returning null for an
 * unresolvable path is correct rather than a failure: a type-only import of a
 * `.d.ts`, for instance, is not a module that ships.
 */
function resolveImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

function isServerOnly(file: string): boolean {
  const rel = relative(ROOT, file);
  return SERVER_ONLY.some((p) => rel === p || rel.startsWith(p + sep));
}

/** Every file reachable from `entry`, with the chain that got there. */
function reachableFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    for (const specifier of localImportsOf(file)) {
      const target = resolveImport(file, specifier);
      if (!target || seen.has(target)) continue;
      const nextChain = [...chain, target];
      seen.set(target, nextChain);
      queue.push({ file: target, chain: nextChain });
    }
  }
  return seen;
}

describe('the server boundary', () => {
  const clientComponents = FILES.filter(isClientComponent);

  it('finds the client components, so this test is not vacuously passing', () => {
    assert.ok(clientComponents.length >= 2, `only found ${clientComponents.length} client components`);
  });

  it('keeps every database, gateway and queue module out of the browser bundle', () => {
    const violations: string[] = [];

    for (const component of clientComponents) {
      for (const [file, chain] of reachableFrom(component)) {
        if (!isServerOnly(file)) continue;
        violations.push(chain.map((f) => relative(ROOT, f)).join('\n      -> '));
      }
    }

    assert.deepEqual(
      violations,
      [],
      `A client component reaches a server-only module:\n\n      ${violations.join('\n\n      ')}\n\n` +
        'Pass the data in as props from a server component instead.',
    );
  });

  it('allows a client component to import the linter, which is pure', () => {
    // The composer imports the lint types, and that has to stay allowed: the
    // linter touches no database, calls no model, and reads no environment.
    const lint = join(SRC, 'lib', 'email', 'lint.ts');
    assert.ok(!isServerOnly(lint));
    assert.equal(localImportsOf(lint).length, 0, 'the linter must stay dependency-free');
  });
});
