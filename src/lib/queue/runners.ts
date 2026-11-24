/**
 * The pipeline steps, as job runners.
 *
 * Deliberately NOT marked `server-only`. That marker exists to keep a module out
 * of a client bundle, and it throws outside a React server context — which breaks
 * `pnpm worker` and the load test, both of which are plain Node. This module is
 * reached from the cron route and from the CLI, never from a component, so the
 * marker would buy nothing and cost both entry points.
 *
 * `scripts/run-pipeline.ts` runs the same logic straight through for a whole batch,
 * which is the right shape for a one-off report. This is the same work expressed as
 * independently resumable units, which is what the queue needs: a step that fails
 * must be retryable without redoing the five before it.
 *
 * Each runner reads what the previous one wrote, rather than passing values in
 * memory. That is slower and it is the point — it is what makes a step resumable
 * after the process holding it died.
 */

import { createHash, randomUUID } from 'node:crypto';

import { getStore } from '../db/index';
import { embed } from '../gateway/index';
import { evaluateG1 } from '../gates/g1-stage-cheque';
import { evaluateG2 } from '../gates/g2-regulatory';
import { evaluateG3 } from '../gates/g3-portfolio-conflict';
import { evaluateG4 } from '../gates/g4-integrity';
import { extractClaims } from '../pipeline/extract-claims';
import { evidenceCoverage, rankOne, type RankInput } from '../pipeline/rank';
import { reconcile, type ClaimLike, type ReconCheck } from '../pipeline/reconcile';
import { buildQueryPlan, research } from '../pipeline/research';
import { scoreApplication } from '../pipeline/score';
import { redact, type FounderIdentity } from '../redact';
import { lensForSector, resolveWeights, type Criterion } from '../rubric';
import type { Step, StepRunner } from './jobs';

const RUBRIC_VERSION = 1;

interface Loaded {
  app: {
    id: string;
    company_name: string;
    one_liner: string | null;
    sector_declared: string | null;
    stage_declared: string | null;
    location: string | null;
    raise_text: string | null;
    post_money_text: string | null;
    received_at: string;
  };
  documents: Array<{ id: string; kind: string }>;
  founders: Array<{ id: string; token: string; role: string | null; background_form: string }>;
  contacts: FounderIdentity[];
  formFields: Array<{ label: string; value: string }>;
  pages: Record<string, { redacted: string[]; normalised: string[] }>;
}

async function load(applicationId: string): Promise<Loaded> {
  const store = await getStore();
  const app = await store.selectOne<Loaded['app'] & Record<string, unknown>>('applications', {
    id: applicationId,
  });
  if (!app) throw new Error(`Application ${applicationId} no longer exists.`);

  const documents = await store.select<{ id: string; kind: string }>('documents', {
    application_id: applicationId,
  });
  const founders = await store.select<Loaded['founders'][number] & Record<string, unknown>>(
    'founders',
    { application_id: applicationId },
  );
  const formFields = await store.select<{ label: string; value: string }>('form_fields', {
    application_id: applicationId,
  });

  const contacts: FounderIdentity[] = [];
  for (const f of founders) {
    const row = await store.selectOne<{ full_name: string; email: string | null; linkedin_url: string | null }>(
      'founder_contacts',
      { founder_id: f.id },
    );
    contacts.push({
      token: f.token,
      fullName: row?.full_name ?? '',
      email: row?.email ?? null,
      linkedinUrl: row?.linkedin_url ?? null,
    });
  }

  const pages: Loaded['pages'] = {};
  for (const doc of documents) {
    const rows = await store.select<{ page_number: number; redacted_text: string; norm_text: string }>(
      'doc_pages',
      { document_id: doc.id },
    );
    rows.sort((a, b) => a.page_number - b.page_number);
    pages[doc.kind] = {
      redacted: rows.map((r) => r.redacted_text),
      normalised: rows.map((r) => r.norm_text),
    };
  }

  return { app, documents, founders, contacts, formFields, pages };
}

async function storedClaims(
  applicationId: string,
): Promise<Array<ClaimLike & { id: string; source: 'deck' | 'form'; period: string | null }>> {
  const store = await getStore();
  const documents = await store.select<{ id: string; kind: string }>('documents', {
    application_id: applicationId,
  });
  const rows = await store.select<{
    id: string;
    metric: string;
    canonical: string | null;
    value_text: string | null;
    value_num: number | null;
    period: string | null;
    is_target: boolean;
    quote: string;
    page_number: number;
    document_id: string;
  }>('claims', { application_id: applicationId });

  return rows.map((c) => ({
    id: String(c.id),
    metric: c.metric,
    canonical: c.canonical ?? 'other',
    value_text: c.value_text,
    value_num: c.value_num,
    period: c.period,
    is_target: Boolean(c.is_target),
    quote: c.quote,
    page: c.page_number,
    source: (documents.find((d) => d.id === c.document_id)?.kind as 'deck' | 'form') ?? 'deck',
  }));
}

async function storedChecks(applicationId: string): Promise<ReconCheck[]> {
  const store = await getStore();
  const rows = await store.select<{
    check_key: string;
    title: string;
    severity: string;
    formula: string | null;
    expected: string | null;
    found: string | null;
    plain: string;
  }>('recon_checks', { application_id: applicationId });

  return rows.map((c) => ({
    checkKey: c.check_key,
    title: c.title,
    severity: c.severity as ReconCheck['severity'],
    formula: c.formula,
    expected: c.expected,
    found: c.found,
    plain: c.plain,
  }));
}

export interface RunnerOptions {
  /** Research is expensive and reaches outside the fund's files, so it is opt-in. */
  includeResearch?: boolean;
}

export function buildRunners(options: RunnerOptions = {}): Partial<Record<Step, StepRunner>> {
  return {
    async extract(applicationId) {
      const store = await getStore();
      const { app, documents, contacts, pages } = await load(applicationId);
      const traceId = randomUUID();

      for (const kind of ['deck', 'form'] as const) {
        const doc = documents.find((d) => d.kind === kind);
        const page = pages[kind];
        if (!doc || !page) continue;

        const result = await extractClaims({
          applicationId,
          documentId: doc.id,
          kind,
          company: app.company_name,
          redactedPages: page.redacted,
          normalisedPages: page.normalised,
          founders: contacts,
          traceId,
        });

        for (const c of result.claims) {
          await store.upsert(
            'claims',
            {
              application_id: applicationId,
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
              dedupe_key: createHash('sha256').update(`${c.metric}|${c.quote}`).digest('hex'),
            },
            ['application_id', 'dedupe_key'],
          );
        }
      }
    },

    async reconcile(applicationId) {
      const store = await getStore();
      const { founders, formFields, pages } = await load(applicationId);
      const claims = await storedClaims(applicationId);

      const checks = reconcile({
        deckPages: pages.deck?.normalised ?? [],
        claims,
        formFields,
        // Raw, deliberately: this comparison runs in-process with no model.
        founderBackgrounds: founders.map((f) => f.background_form),
      });

      for (const c of checks) {
        await store.upsert(
          'recon_checks',
          {
            application_id: applicationId,
            check_key: c.checkKey,
            title: c.title,
            severity: c.severity,
            formula: c.formula,
            expected: c.expected,
            found: c.found,
            plain: c.plain,
            page_number: c.pageNumber ?? null,
            document_kind: c.documentKind ?? null,
          },
          ['application_id', 'check_key'],
        );
      }
    },

    ...(options.includeResearch
      ? {
          async research(applicationId: string) {
            const store = await getStore();
            const { app, founders, contacts } = await load(applicationId);

            const plan = buildQueryPlan({
              company: app.company_name,
              oneLiner: app.one_liner,
              location: app.location,
              sector: app.sector_declared,
              founders: contacts.map((c, i) => ({
                token: c.token,
                fullName: c.fullName,
                role: founders[i]?.role ?? null,
              })),
            });

            const outcome = await research({
              applicationId,
              plan,
              company: app.company_name,
              subjectDescription:
                `${app.company_name}: ${app.one_liner ?? ''} Based in ${app.location ?? 'India'}. ` +
                founders.map((f) => `[${f.token}] ${f.role ?? 'founder'}`).join('; '),
              founders: contacts,
            });

            for (const q of outcome.queries) {
              await store.insert('research_queries', {
                application_id: applicationId,
                intent: q.intent,
                subject_token: q.subjectToken,
                query: q.query,
                provider: 'openrouter-web',
                result_count: q.resultCount,
                was_empty: q.wasEmpty,
              });
            }
            const anyQuery = await store.selectOne<{ id: string }>('research_queries', {
              application_id: applicationId,
            });
            for (const f of outcome.findings) {
              await store.insert('research_findings', {
                query_id: anyQuery?.id ? String(anyQuery.id) : null,
                application_id: applicationId,
                url: f.url,
                domain: f.domain,
                title: f.title,
                quote: f.quote ?? '',
                quote_verified: f.quoteVerified,
                is_primary_source: f.isPrimarySource,
                confirms: f.confirms,
                set_aside_reason: f.setAsideReason,
              });
            }
          },
        }
      : {}),

    async gates(applicationId) {
      const store = await getStore();
      const { app, contacts, formFields, pages } = await load(applicationId);
      const checks = await storedChecks(applicationId);
      const traceId = randomUUID();

      const g1 = evaluateG1({
        stageDeclared: app.stage_declared,
        raiseText: app.raise_text,
        postMoneyText: app.post_money_text,
        existingInvestorsText: formFields.find((f) => f.label === 'Existing investors')?.value ?? null,
      });

      const [vector] = await embed([`${app.company_name}. ${app.one_liner ?? ''}`], { step: 'gate_g3' });
      const g3 = await evaluateG3(store, vector);
      const g4 = evaluateG4(checks);
      const g2 = await evaluateG2({
        applicationId,
        company: app.company_name,
        oneLiner: app.one_liner,
        sector: app.sector_declared,
        pages: pages.deck?.redacted ?? [],
        founders: contacts,
        traceId,
      });

      for (const gate of [g1, g2, g3, g4]) {
        await store.upsert(
          'gate_results',
          {
            application_id: applicationId,
            gate_key: gate.gateKey,
            tripped: gate.tripped,
            plain_name: gate.plainName,
            reason: gate.reason,
            citations: gate.citations,
            decided_by: gate.decidedBy,
            rubric_version: RUBRIC_VERSION,
          },
          ['application_id', 'gate_key'],
        );
      }
    },

    async score(applicationId) {
      const store = await getStore();
      const { app, founders, contacts } = await load(applicationId);
      const claims = await storedClaims(applicationId);
      const checks = await storedChecks(applicationId);

      const confirmed = await store.select<{ domain: string; confirms: string | null; quote: string; is_primary_source: boolean; set_aside_reason: string | null }>(
        'research_findings',
        { application_id: applicationId },
      );

      const scored = await scoreApplication({
        applicationId,
        company: app.company_name,
        sector: app.sector_declared,
        lens: lensForSector(app.sector_declared),
        evidence: {
          claims,
          checks,
          // Redacted: this reaches a model.
          founderBackgrounds: founders.map((f) => redact(f.background_form, contacts).text),
          externalConfirmations: confirmed
            .filter((f) => f.set_aside_reason === null && f.confirms)
            .map((f) => ({
              domain: f.domain,
              confirms: f.confirms ?? '',
              quote: f.quote,
              isPrimarySource: Boolean(f.is_primary_source),
            })),
        },
        founders: contacts,
        rubricVersion: RUBRIC_VERSION,
      });

      for (const s of scored.scores) {
        await store.upsert(
          'criterion_scores',
          {
            application_id: applicationId,
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
    },

    async rank(applicationId) {
      const store = await getStore();
      const { app } = await load(applicationId);

      const scores = await store.select<{ criterion_key: string; score: number; confidence: string; claim_ids: string[] | null }>(
        'criterion_scores',
        { application_id: applicationId, view: 'revealed' },
      );
      if (scores.length === 0) throw new Error('Nothing to rank: this application has no scores.');

      const gates = await store.select<{ gate_key: string; tripped: boolean }>('gate_results', {
        application_id: applicationId,
        tripped: true,
      });

      const { weights } = resolveWeights('revealed', lensForSector(app.sector_declared));
      const weightedScore =
        Math.round(
          scores.reduce(
            (sum, s) => sum + Number(s.score) * (weights[s.criterion_key as Criterion['key']] ?? 0),
            0,
          ) * 100,
        ) / 100;

      const confidence = {} as Record<Criterion['key'], 'high' | 'med' | 'low'>;
      for (const s of scores) {
        confidence[s.criterion_key as Criterion['key']] = s.confidence as 'high' | 'med' | 'low';
      }

      const input: RankInput = {
        applicationId,
        weightedScore,
        confidence,
        trippedGates: gates.map((g) => g.gate_key),
        evidenceCoverage: evidenceCoverage(scores.map((s) => ({ claim_ids: s.claim_ids ?? [] }))),
        sectorResolved: app.sector_declared,
        receivedAt: String(app.received_at),
      };
      const out = rankOne(input);

      await store.upsert(
        'assessments',
        {
          application_id: applicationId,
          view: 'revealed',
          weighted_score: weightedScore,
          recommendation: out.recommendation,
          lane: out.lane,
          bucket: out.bucket,
          evidence_coverage: input.evidenceCoverage,
          rating_word: out.ratingWord,
          headline: out.because,
          rubric_version: RUBRIC_VERSION,
        },
        ['application_id'],
      );
    },
  };
}
