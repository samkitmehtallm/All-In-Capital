/**
 * Live provider check.
 *
 * Answers one question in about three seconds: can this machine actually reach a
 * model, through which route, at what cost. The fund has no engineer, so when
 * something stops working this is the first thing the runbook says to run.
 *
 *   pnpm live-check              # whatever .env.local is configured for
 *   pnpm live-check openrouter   # force the direct production route
 *   pnpm live-check portkey      # force the local gateway route
 *   pnpm live-check offline      # prove the no-key path still works
 *
 * It writes its ledger row to a scratch directory, so a check never pollutes the
 * real cost report.
 */

import './load-env';

import {
  callModel,
  embeddingsAreReal,
  selectEmbeddingProvider,
  selectProvider,
} from '../src/lib/gateway/index';
import { DATA_NOT_INSTRUCTIONS } from '../src/lib/gateway/guards';
import { registerOfflineHandler } from '../src/lib/gateway/providers/offline';

const forced = process.argv[2];

async function main() {
  process.env.LOCAL_DATA_DIR = process.env.LOCAL_DATA_DIR ?? '.data/live-check';

  if (forced) {
    process.env.MODEL_PROVIDER = forced;
    // Forcing the direct route means ignoring the gateway address, otherwise
    // selectProvider would keep preferring Portkey.
    if (forced !== 'portkey') delete process.env.PORTKEY_BASE_URL;
  }

  // So `pnpm live-check offline` proves the no-key path rather than erroring.
  registerOfflineHandler('live_check', () => JSON.stringify({ ok: true, model_said: 'reconciled' }));

  const chat = selectProvider();
  const embedder = selectEmbeddingProvider();

  console.log(`\n  chat provider   ${chat.name}`);
  console.log(`  embed provider  ${embedder.name}${embeddingsAreReal() ? '' : '  (stand-in vectors, NOT semantic)'}`);

  const started = Date.now();
  const res = await callModel({
    step: 'live_check',
    system: `Reply with JSON only: {"ok": true, "model_said": "<one short word>"}.\n\n${DATA_NOT_INSTRUCTIONS}`,
    user: 'Say the word: reconciled',
    temperature: 0,
  });

  console.log(`\n  model           ${res.model}`);
  console.log(`  reply           ${res.text.trim().replace(/\s+/g, ' ').slice(0, 100)}`);
  console.log(`  tokens          ${res.inputTokens} in / ${res.outputTokens} out`);
  console.log(`  cost            INR ${res.costInr.toFixed(4)}`);
  console.log(`  latency         ${res.latencyMs} ms (wall ${Date.now() - started} ms)`);
  console.log(`  retries         ${res.retries}${res.fellBack ? ' (fell back to the second model)' : ''}`);
  console.log(`  cached          ${res.cached}\n`);

  if (!embeddingsAreReal()) {
    console.log('  Retrieval (memo passages, the G3 conflict check, style examples) is');
    console.log('  running on deterministic stand-in vectors. Set GEMINI_API_KEY for real');
    console.log('  embeddings: OpenRouter has no embedding endpoint.\n');
  }
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
