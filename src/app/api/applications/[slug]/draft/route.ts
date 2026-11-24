import { NextResponse } from 'next/server';

import { getStore } from '../../../../../lib/db/index';
import { draftForApplication, saveEdit } from '../../../../../lib/email/draft';
import { lintEmail, TEMPLATES, type Template } from '../../../../../lib/email/lint';
import { noteForChip, REDO_CHIPS, type RedoChip } from '../../../../../lib/email/compose';

/**
 * Draft, redraft, and save an edit.
 *
 * `POST` writes a new draft, optionally with a redo instruction. `PATCH` saves
 * an edit and returns a fresh lint result for the panel. `PUT` lints without
 * saving, which is what the live panel calls while she is still typing.
 *
 * The split matters: linting is pure and costs nothing, so the panel can run on
 * every keystroke, while drafting costs a model call and only runs when asked.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isTemplate(value: unknown): value is Template {
  return typeof value === 'string' && (TEMPLATES as readonly string[]).includes(value);
}

function isChip(value: unknown): value is RedoChip {
  return typeof value === 'string' && value in REDO_CHIPS;
}

async function applicationIdFor(slug: string): Promise<string | null> {
  const store = await getStore();
  const app = await store.selectOne<{ id: string }>('applications', { slug });
  return app ? String(app.id) : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const applicationId = await applicationIdFor(slug);
  if (!applicationId) return NextResponse.json({ ok: false, error: 'No such application.' }, { status: 404 });

  let payload: { template?: unknown; chip?: unknown; note?: unknown } = {};
  try {
    payload = await request.json();
  } catch {
    // An empty body means "draft with the suggested template", which is the
    // common case when Riya just opens the application.
  }

  // A chip and a free note are the same thing to the composer: an instruction.
  // The chip's wording is fixed here rather than in the browser so that the
  // phrasing the model sees cannot be edited by whoever calls this route.
  const note = isChip(payload.chip)
    ? noteForChip(payload.chip)
    : typeof payload.note === 'string' && payload.note.trim().length > 0
      ? payload.note.trim().slice(0, 300)
      : null;

  try {
    const draft = await draftForApplication({
      slug,
      template: isTemplate(payload.template) ? payload.template : undefined,
      note,
    });

    return NextResponse.json({
      ok: true,
      draft: {
        id: draft.id,
        template: draft.template,
        subject: draft.subject,
        body: draft.body,
        generation: draft.generation,
        lint: draft.lint,
        examplesShown: draft.examplesShown,
        costInr: draft.costInr,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A guard refusal is not a server fault and must not read like one: it means
    // the draft was stopped before it could leave, which is the system working.
    const guarded = /tried to send|GuardError/i.test(message);
    return NextResponse.json(
      {
        ok: false,
        error: guarded
          ? 'The draft was stopped before it could be written, because it would have contained a founder contact detail. This needs an engineer.'
          : message,
      },
      { status: guarded ? 422 : 500 },
    );
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const applicationId = await applicationIdFor(slug);
  if (!applicationId) return NextResponse.json({ ok: false, error: 'No such application.' }, { status: 404 });

  const body = (await request.json()) as { draftId?: unknown; subject?: unknown; body?: unknown };
  if (typeof body.draftId !== 'string' || typeof body.subject !== 'string' || typeof body.body !== 'string') {
    return NextResponse.json({ ok: false, error: 'Expected draftId, subject and body.' }, { status: 400 });
  }

  const { lint } = await saveEdit({ draftId: body.draftId, subject: body.subject, body: body.body });
  return NextResponse.json({ ok: true, lint });
}

/** Lint only. No model, no database, no cost: safe to call while typing. */
export async function PUT(request: Request) {
  const body = (await request.json()) as { template?: unknown; subject?: unknown; body?: unknown };
  if (!isTemplate(body.template) || typeof body.subject !== 'string' || typeof body.body !== 'string') {
    return NextResponse.json({ ok: false, error: 'Expected template, subject and body.' }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    lint: lintEmail({ template: body.template, subject: body.subject, body: body.body }),
  });
}
