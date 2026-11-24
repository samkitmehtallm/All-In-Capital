import { NextResponse } from 'next/server';

import { getStore } from '../../../lib/db/index';
import { normaliseWhitespace } from '../../../lib/ingest/form-parser';

/**
 * One document page, with a quote located in it.
 *
 * The brief asks for "the PDF page with the quote highlighted". This returns the
 * extracted page text and the character range the quote occupies, and the drawer
 * marks it. There is no page image because this machine has no PDF rasteriser, and
 * an image would be worse anyway: text can be selected, searched and read by a
 * screen reader, and the pipeline's verbatim check already proved the quote is
 * really there. The original PDF is linked beside it for anyone who wants the
 * typeset page.
 *
 * Matching is done on normalised whitespace, because the extractor breaks lines
 * mid-sentence and a quote verified against `norm_text` will not be found in
 * `raw_text` by a naive indexOf.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('app');
  const kind = url.searchParams.get('kind');
  const page = Number(url.searchParams.get('page'));
  const quote = url.searchParams.get('quote') ?? '';

  if (!slug || (kind !== 'deck' && kind !== 'form') || !Number.isInteger(page) || page < 1) {
    return NextResponse.json(
      { ok: false, error: 'Expected app, kind (deck or form) and a page number.' },
      { status: 400 },
    );
  }

  const store = await getStore();
  const app = await store.selectOne<{ id: string; company_name: string }>('applications', { slug });
  if (!app) return NextResponse.json({ ok: false, error: 'No such application.' }, { status: 404 });

  const document = await store.selectOne<{ id: string; filename: string; page_count: number }>(
    'documents',
    { application_id: app.id, kind },
  );
  if (!document) {
    return NextResponse.json({ ok: false, error: 'No such document.' }, { status: 404 });
  }

  const row = await store.selectOne<{ norm_text: string; page_number: number }>('doc_pages', {
    document_id: document.id,
    page_number: page,
  });
  if (!row) return NextResponse.json({ ok: false, error: 'No such page.' }, { status: 404 });

  const text = row.norm_text;
  const needle = normaliseWhitespace(quote);
  const start = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;

  return NextResponse.json({
    ok: true,
    company: app.company_name,
    kind,
    filename: document.filename,
    page,
    pageCount: document.page_count,
    text,
    // Null when the quote is not on this page, which the drawer says plainly
    // rather than silently showing an unhighlighted page.
    match: start >= 0 ? { start, end: start + needle.length } : null,
  });
}
