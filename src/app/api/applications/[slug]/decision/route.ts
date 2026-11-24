import { NextResponse } from 'next/server';

import { getStore } from '../../../../../lib/db/index';
import { embed } from '../../../../../lib/gateway/index';
import { redact } from '../../../../../lib/redact';

/**
 * Record Riya's decision, and remember it when it disagrees.
 *
 * This is the whole of Loop 1. There are no per-criterion override buttons: the
 * decision IS the correction. When it goes against the recommendation, a row is
 * written to `corrections` with the application's text redacted, embedded, and
 * available to the scorer on the next similar company.
 *
 * The redaction matters here specifically. A correction is retrieved and shown to a
 * model months later, by which time nobody remembers which company it came from —
 * so the company and founder names come out before it is ever stored, not before it
 * is sent.
 */

const DECISIONS = new Set(['advance', 'hold', 'pass']);

/** What the tool recommended, mapped into the same words as the decision. */
const RECOMMENDED_AS: Record<string, string> = {
  take_call: 'advance',
  dig_first: 'hold',
  pass: 'pass',
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  let body: { decision?: unknown; note?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Expected a JSON body.' }, { status: 400 });
  }

  const decision = String(body.decision ?? '');
  if (!DECISIONS.has(decision)) {
    return NextResponse.json(
      { ok: false, error: 'Decision must be advance, hold or pass.' },
      { status: 400 },
    );
  }

  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

  const store = await getStore();
  const app = await store.selectOne<{ id: string; company_name: string; one_liner: string | null }>(
    'applications',
    { slug },
  );
  if (!app) {
    return NextResponse.json({ ok: false, error: 'No such application.' }, { status: 404 });
  }

  const assessment = await store.selectOne<{ recommendation: string }>('assessments', {
    application_id: app.id,
  });
  const recommendedAs = assessment ? RECOMMENDED_AS[assessment.recommendation] ?? null : null;
  const disagreed = recommendedAs !== null && recommendedAs !== decision;

  // Sign-in is not built yet, so there is no identity to attribute this to. Writing
  // a plausible name would be worse than writing the truth: the audit trail is the
  // reason this table exists.
  const decidedBy = 'unauthenticated-local';

  const [decisionRow] = await store.insert('decisions', {
    application_id: app.id,
    decision,
    note,
    recommendation_at_decision: assessment?.recommendation ?? null,
    disagreed,
    decided_by: decidedBy,
  });

  let remembered = false;

  if (disagreed) {
    // The founders of THIS application, so their names come out of the text that
    // gets embedded and later shown to a scorer.
    const founders = await store.select<{ id: string; token: string }>('founders', {
      application_id: app.id,
    });
    const identities = await Promise.all(
      founders.map(async (f) => {
        const contact = await store.selectOne<{
          full_name: string;
          email: string | null;
          linkedin_url: string | null;
        }>('founder_contacts', { founder_id: f.id });
        return {
          token: f.token,
          fullName: contact?.full_name ?? '',
          email: contact?.email ?? null,
          linkedinUrl: contact?.linkedin_url ?? null,
        };
      }),
    );

    const subject = [app.one_liner ?? '', note ?? ''].filter(Boolean).join(' ');
    // The company name is removed too, not just the founders'. A correction that
    // names the company it came from is a correction that cannot be reused.
    const withoutCompany = subject.replace(new RegExp(app.company_name, 'gi'), 'this company');
    const redactedText = redact(withoutCompany, identities).text;

    let embedding: number[] | null = null;
    try {
      [embedding] = await embed([redactedText || 'a decision with no note'], {
        step: 'embed_correction',
      });
    } catch {
      // A correction without a vector is still worth keeping; it simply will not be
      // retrieved until it is backfilled. Losing the decision would be worse.
      embedding = null;
    }

    await store.insert('corrections', {
      decision_id: decisionRow.id,
      application_id: app.id,
      recommended: recommendedAs,
      decided: decision,
      note,
      redacted_text: redactedText,
      embedding,
    });
    remembered = true;
  }

  return NextResponse.json({ ok: true, disagreed, remembered });
}
