/**
 * Offline provider — a deterministic test double, not a model.
 *
 * Every step that calls a model registers an offline handler here. That keeps three
 * things true: the full pipeline runs in CI with no key and no spend, the volume
 * test measures the queue rather than a provider's rate limit, and a test can assert
 * on exact output instead of "something plausible".
 *
 * It is named `offline` everywhere it is recorded, so no cost report or trace can be
 * mistaken for a real run.
 */

import { createHash } from 'node:crypto';

import type { ModelRequest } from '../types';

export type OfflineHandler = (req: ModelRequest) => string | Promise<string>;

const handlers = new Map<string, OfflineHandler>();

export function registerOfflineHandler(step: string, handler: OfflineHandler): void {
  handlers.set(step, handler);
}

export function hasOfflineHandler(step: string): boolean {
  return handlers.has(step);
}

/** Stable pseudo-random in [0,1) derived from a string, so runs are reproducible. */
export function seededUnit(seed: string): number {
  const hash = createHash('sha256').update(seed).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}

export const offlineProvider = {
  name: 'offline',

  async generate(model: string, req: ModelRequest) {
    const handler = handlers.get(req.step);
    if (!handler) {
      throw new Error(
        `No offline handler registered for step "${req.step}". Register one with ` +
          'registerOfflineHandler so the pipeline stays runnable without an API key.',
      );
    }
    const text = await handler(req);
    return {
      text,
      // Token counts are approximated at 4 characters per token purely so the
      // volume test and cost plumbing exercise the same code path. Cost is zero.
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
    };
  },

  /**
   * Deterministic embeddings: a hashed bag of character trigrams.
   *
   * Not semantic, but stable and sensitive to overlapping wording, which is enough
   * for tests of the retrieval plumbing. Real similarity comes from Gemini.
   */
  async embed(_model: string, texts: string[], dim = 768): Promise<number[][]> {
    return texts.map((text) => {
      const vec = new Array<number>(dim).fill(0);
      const clean = text.toLowerCase().replace(/\s+/g, ' ');
      for (let i = 0; i < clean.length - 2; i += 1) {
        const gram = clean.slice(i, i + 3);
        const h = createHash('md5').update(gram).digest();
        vec[h.readUInt16BE(0) % dim] += 1;
      }
      const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  },
};
