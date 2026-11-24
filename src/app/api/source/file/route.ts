import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NextResponse } from 'next/server';

import { getStore } from '../../../../lib/db/index';

/**
 * Serve the original PDF, so "open the original page" shows the typeset page in
 * the browser's own viewer at #page=N.
 *
 * Two things this route will not do:
 *
 *  - It will not take a filename from the query string. The filename comes from
 *    the `documents` row for the requested application, so there is no path a
 *    caller can supply and therefore no traversal to defend against.
 *  - It will not serve a file whose bytes no longer match the sha256 recorded at
 *    ingest. If the file on disk has changed, every claim quoted from it was
 *    verified against different content, and showing it as the source would be a
 *    quiet lie about provenance.
 */

const RAW_DIR = join(process.cwd(), 'data', 'raw');

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('app');
  const kind = url.searchParams.get('kind');

  if (!slug || (kind !== 'deck' && kind !== 'form')) {
    return NextResponse.json(
      { ok: false, error: 'Expected app and kind (deck or form).' },
      { status: 400 },
    );
  }

  const store = await getStore();
  const app = await store.selectOne<{ id: string }>('applications', { slug });
  if (!app) return NextResponse.json({ ok: false, error: 'No such application.' }, { status: 404 });

  const document = await store.selectOne<{ filename: string; sha256: string }>('documents', {
    application_id: app.id,
    kind,
  });
  if (!document) {
    return NextResponse.json({ ok: false, error: 'No such document.' }, { status: 404 });
  }

  // Defence in depth: the name came from our own database, but a basename check
  // costs nothing and makes the guarantee local to this file.
  if (document.filename.includes('/') || document.filename.includes('..')) {
    return NextResponse.json({ ok: false, error: 'Unexpected filename.' }, { status: 400 });
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(join(RAW_DIR, document.filename));
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error:
          'The original file is not available in this deployment. The page text is still shown in the drawer.',
      },
      { status: 404 },
    );
  }

  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== document.sha256) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'This file has changed since the application was read, so it is not the document the claims were checked against. Re-run the pipeline.',
      },
      { status: 409 },
    );
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${document.filename}"`,
      // Founder documents. Never cached by a shared cache.
      'cache-control': 'private, max-age=0, must-revalidate',
    },
  });
}
