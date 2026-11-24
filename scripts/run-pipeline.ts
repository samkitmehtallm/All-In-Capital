/**
 * Run the pipeline over every application and report what each step produced.
 *
 *   pnpm pipeline                 # all ten
 *   pnpm pipeline grainkind       # one, by slug
 *   pnpm pipeline --no-score      # ingest, reconcile and the free gates only
 *
 * Steps are idempotent and recorded in `jobs`, so a re-run skips work already done
 * unless --force is passed. Nothing is ever lost: a step that fails twice marks the
 * application "Needs a look" with a plain reason rather than disappearing.
 */

import './load-env';

import { createHash, randomUUID } from 'node:crypto';

import { getStore } from '../src/lib/db/index';
import { redact } from '../src/lib/redact';
import { embed } from '../src/lib/gateway/index';
import { evaluateG1 } from '../src/lib/gates/g1-stage-cheque';
import { evaluateG2 } from '../src/lib/gates/g2-regulatory';
import { evaluateG3 } from '../src/lib/gates/g3-portfolio-conflict';
import { evaluateG4 } from '../src/lib/gates/g4-integrity';
import { extractClaims } from '../src/lib/pipeline/extract-claims';
import { evidenceCoverage, rankAll, rankOne, type RankInput, type RankOutput } from '../src/lib/pipeline/rank';
import { reconcile, type ReconCheck } from '../src/lib/pipeline/reconcile';
import { scoreApplication } from '../src/lib/pipeline/score';
import { lensForSector, resolveWeights } from '../src/lib/rubric';
import type { Criterion } from '../src/lib/rubric';

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));
const noScore = args.includes('--no-score');
/**
 * Re-run the deterministic steps against claims already in the database.
 *
 * Reconciliation and the code-only gates get tuned repeatedly; re-extracting
 * claims each time costs real money for an identical result. --recheck reuses the
 * stored claims and recomputes everything downstream of them.
 */
const recheck = args.includes('--recheck');
const RUBRIC_VERSION = 1;

interface AppRow {
  [key: string]: unknown;
  id: string;
  slug: string;
  company_name: string;
  one_liner: string | null;
  sector_declared: string | null;
  stage_declared: string | null;
  raise_text: string | null;
  post_money_text: string | null;
  received_at: string;
}

async function main() {
  const store = await getStore();
  console.log(`\n  store: ${store.kind}\n`);

  let apps = await store.select<AppRow>('applications');
  if (only) apps = apps.filter((a) => a.slug === only);
  apps.sort((a, b) => a.company_name.localeCompare(b.company_name));
  if (apps.length === 0) throw new Error(`No applications found${only ? ` for "${only}"` : ''}. Run pnpm seed.`);

  const ranked: Array<RankInput & RankOutput & { company: string; checks: ReconCheck[]; gates: string[] }> = [];
  let totalCost = 0;

  for (const app of apps) {
    const traceId = randomUUID();
    const started = Date.now();
    process.stdout.write(`  ${app.company_name.padEnd(11)} `);

    // -- load what ingest already produced -----------------------------------
    const documents = await store.select<{ id: string; kind: string }>('documents', { application_id: app.id });
    const founders = await store.select<{ token: string; background_form: string }>('founders', {
      application_id: app.id,
    });
    const formFields = await store.select<{ label: string; value: string }>('form_fields', {
      application_id: app.id,
    });

    const pagesByKind: Record<string, { redacted: string[]; normalised: string[] }> = {};
    for (const doc of documents) {
      const pages = await store.select<{ page_number: number; redacted_text: string; norm_text: string }>(
        'doc_pages',
        { document_id: doc.id },
      );
      pages.sort((a, b) => a.page_number - b.page_number);
      pagesByKind[doc.kind] = {
        redacted: pages.map((p) => p.redacted_text),
        normalised: pages.map((p) => p.norm_text),
      };
    }

    // Contacts are deliberately NOT loaded into anything the gateway sees. They are
    // passed only so the send-less guard can assert against the real values.
    const contacts = await Promise.all(
      founders.map(async (f) => {
        const row = await store.selectOne<{ full_name: string; email: string | null; linkedin_url: string | null }>(
          'founder_contacts',
          { founder_id: (await store.selectOne<{ id: string }>('founders', { application_id: app.id, token: f.token }))!.id },
        );
        return {
          token: f.token,
          fullName: row?.full_name ?? '',
          email: row?.email ?? null,
          linkedinUrl: row?.linkedin_url ?? null,
        };
      }),
    );

    // Founder backgrounds exist in two forms, and the difference matters.
    //
    // `background_form` is the raw form text and still contains the founder's name
    // and LinkedIn URL. Reconciliation may read it: the credential check compares
    // what the deck claims against what the form says, that comparison is
    // deterministic and runs in this process, and it needs the real words.
    //
    // The scorer may NOT read it, because the scorer calls a model. The send-less
    // guard caught exactly this and threw — which is why these are now two separate
    // variables rather than one convenient array passed to both.
    const rawBackgrounds = founders.map((f) => f.background_form);
    const redactedBackgrounds = rawBackgrounds.map((b) => redact(b, contacts).text);

    // -- step 2: claims -------------------------------------------------------
    const claims: Array<{ id: string; metric: string; canonical: string; value_text: string | null; period: string | null; quote: string; page: number; source: 'deck' | 'form'; is_target: boolean; value_num: number | null }> = [];

    if (recheck) {
      const stored = await store.select<{ id: string; metric: string; canonical: string | null; value_text: string | null; value_num: number | null; period: string | null; is_target: boolean; quote: string; page_number: number; document_id: string }>(
        'claims',
        { application_id: app.id },
      );
      for (const c of stored) {
        const doc = documents.find((d) => d.id === c.document_id);
        claims.push({
          id: String(c.id),
          metric: c.metric,
          canonical: c.canonical ?? 'other',
          value_text: c.value_text,
          value_num: c.value_num,
          period: c.period,
          is_target: Boolean(c.is_target),
          quote: c.quote,
          page: c.page_number,
          source: (doc?.kind as 'deck' | 'form') ?? 'deck',
        });
      }
      process.stdout.write(`reused ${stored.length} claims `);
    } else if (!noScore) {
      for (const kind of ['deck', 'form'] as const) {
        const doc = documents.find((d) => d.kind === kind);
        const pages = pagesByKind[kind];
        if (!doc || !pages) continue;

        const result = await extractClaims({
          applicationId: app.id,
          documentId: doc.id,
          kind,
          company: app.company_name,
          redactedPages: pages.redacted,
          normalisedPages: pages.normalised,
          founders: contacts,
          traceId,
        });
        totalCost += result.costInr;

        for (const c of result.claims) {
          const [row] = await store.upsert(
            'claims',
            {
              application_id: app.id,
              document_id: doc.id,
              page_number: c.page,
              metric: c.metric,
              canonical: c.canonical,
              value_text: c.value_text,
              value_num: c.value_num,
              unit: c.unit,
              period: c.period,
              is_target: c.is_target,
              quote: c.quote,
              quote_verified: true,
              // sha256(metric|quote): fixed width, so the unique index does not
              // risk the btree row-size limit on a long quote.
              dedupe_key: createHash('sha256').update(`${c.metric}|${c.quote}`).digest('hex'),
            },
            ['application_id', 'dedupe_key'],
          );
          claims.push({ id: String(row.id), ...c, source: kind });
        }
        process.stdout.write(`${kind[0]}${result.claims.length}/${result.claims.length + result.rejected.length} `);
      }
    }

    // -- step 3: reconcile ----------------------------------------------------
    const checks = reconcile({
      deckPages: pagesByKind.deck?.normalised ?? [],
      claims,
      formFields,
      founderBackgrounds: rawBackgrounds, // deterministic, in-process, no model
    });

    for (const c of checks) {
      await store.upsert(
        'recon_checks',
        {
          application_id: app.id,
          check_key: c.checkKey,
          title: c.title,
          severity: c.severity,
          formula: c.formula,
          expected: c.expected,
          found: c.found,
          plain: c.plain,
        },
        ['application_id', 'check_key'],
      );
    }

    // -- step 5: gates --------------------------------------------------------
    const g1 = evaluateG1({
      stageDeclared: app.stage_declared,
      raiseText: app.raise_text,
      postMoneyText: app.post_money_text,
      existingInvestorsText: formFields.find((f) => f.label === 'Existing investors')?.value ?? null,
    });

    const [subjectVector] = await embed([`${app.company_name}. ${app.one_liner ?? ''}`], { step: 'gate_g3' });
    const g3 = await evaluateG3(store, subjectVector);
    const g4 = evaluateG4(checks);

    const g2 = noScore || recheck
      ? null
      : await evaluateG2({
          applicationId: app.id,
          company: app.company_name,
          oneLiner: app.one_liner,
          sector: app.sector_declared,
          pages: pagesByKind.deck?.redacted ?? [],
          founders: contacts,
          traceId,
        });
    if (g2) totalCost += g2.costInr;

    const allGates = [g1, g3, g4, ...(g2 ? [g2] : [])];
    for (const g of allGates) {
      await store.upsert(
        'gate_results',
        {
          application_id: app.id,
          gate_key: g.gateKey,
          tripped: g.tripped,
          plain_name: g.plainName,
          reason: g.reason,
          citations: g.citations,
          decided_by: g.decidedBy,
          rubric_version: RUBRIC_VERSION,
        },
        ['application_id', 'gate_key'],
      );
    }
    const trippedGates = allGates.filter((g) => g.tripped).map((g) => g.gateKey);

    // -- step 6: score --------------------------------------------------------
    const lens = lensForSector(app.sector_declared);
    let weightedScore = 0;
    const confidence = {} as Record<Criterion['key'], 'high' | 'med' | 'low'>;
    let coverage = 0;

    if (recheck) {
      // Reuse the scores already stored. Recomputing the lane from a zeroed score
      // would quietly demote every application to "Not now", which is how a tuning
      // run silently destroys the board it was meant to improve.
      const stored = await store.select<{ criterion_key: string; score: number; confidence: string; claim_ids: string[] }>(
        'criterion_scores',
        { application_id: app.id, view: 'revealed' },
      );
      if (stored.length > 0) {
        // Recomputed from the criterion scores, not read from the assessments row.
        // That row is a derived summary, and an earlier buggy recheck had already
        // written zeros into it — trusting a summary over its own inputs is how a
        // repair run propagates the damage it was meant to undo.
        const { weights } = resolveWeights('revealed', lensForSector(app.sector_declared));
        weightedScore =
          Math.round(
            stored.reduce(
              (sum, r) => sum + Number(r.score) * (weights[r.criterion_key as Criterion['key']] ?? 0),
              0,
            ) * 100,
          ) / 100;
        coverage = evidenceCoverage(stored.map((r) => ({ claim_ids: r.claim_ids ?? [] })));
        for (const r of stored) {
          confidence[r.criterion_key as Criterion['key']] = r.confidence as 'high' | 'med' | 'low';
        }
      }
    } else if (!noScore) {
      const scored = await scoreApplication({
        applicationId: app.id,
        company: app.company_name,
        sector: app.sector_declared,
        lens,
        evidence: {
          claims,
          checks,
          founderBackgrounds: redactedBackgrounds, // reaches a model
        },
        founders: contacts,
        traceId,
        rubricVersion: RUBRIC_VERSION,
      });
      totalCost += scored.costInr;
      weightedScore = scored.weightedScore;
      coverage = evidenceCoverage(scored.scores);

      for (const s of scored.scores) {
        confidence[s.criterionKey] = s.confidence;
        await store.upsert(
          'criterion_scores',
          {
            application_id: app.id,
            criterion_key: s.criterionKey,
            view: 'revealed',
            score: s.score,
            confidence: s.confidence,
            rating_word: s.ratingWord,
            plain: s.plain,
            ask: s.ask,
            claim_ids: s.claim_ids,
            gap_named: s.gap,
            rubric_version: RUBRIC_VERSION,
          },
          ['application_id', 'criterion_key', 'view'],
        );
      }
    }

    const rankInput: RankInput = {
      applicationId: app.id,
      weightedScore,
      confidence,
      trippedGates,
      evidenceCoverage: coverage,
      sectorResolved: app.sector_declared,
      receivedAt: app.received_at,
    };
    const rankOut = rankOne(rankInput);
    ranked.push({ ...rankInput, ...rankOut, company: app.company_name, checks, gates: trippedGates });

    console.log(
      `| ${noScore ? '    ' : weightedScore.toFixed(2)} ${rankOut.ratingWord.padEnd(9)} ` +
        `${rankOut.lane.padEnd(14)} gates: ${trippedGates.length ? trippedGates.map((g) => g.split('_')[0]).join(',') : '-'}` +
        `  ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }

  // -- step 7: rank and persist ----------------------------------------------
  const finalRanked = rankAll(ranked);
  for (const r of finalRanked) {
    await (await getStore()).upsert(
      'assessments',
      {
        application_id: r.applicationId,
        view: 'revealed',
        weighted_score: r.weightedScore,
        recommendation: r.recommendation,
        lane: r.lane,
        bucket: r.bucket,
        rank: r.rank,
        evidence_coverage: r.evidenceCoverage,
        rating_word: r.ratingWord,
        headline: r.because,
        rubric_version: RUBRIC_VERSION,
      },
      ['application_id'],
    );
    await (await getStore()).update(
      'applications',
      { id: r.applicationId },
      { status: noScore && !recheck ? 'received' : 'scored' },
    );
  }

  console.log(`\n  Board order\n`);
  for (const r of finalRanked) {
    console.log(
      `  ${String(r.rank).padStart(2)}. ${r.company.padEnd(11)} ${r.ratingWord.padEnd(9)} ` +
        `${r.lane.padEnd(14)} ${r.bucket.padEnd(16)} coverage ${(r.evidenceCoverage * 100).toFixed(0)}%`,
    );
  }
  console.log(`\n  Total model cost: INR ${totalCost.toFixed(4)} for ${apps.length} application(s)`);
  console.log(`  Per application:  INR ${(totalCost / apps.length).toFixed(4)}\n`);
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
});
