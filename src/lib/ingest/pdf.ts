/**
 * PDF text extraction, one entry per page.
 *
 * Page-level granularity is not incidental: a claim's quote has to be verifiable
 * against the page it was taken from, and the source drawer shows that page with the
 * quote highlighted. Merged text would make both impossible.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { extractText, getDocumentProxy } from 'unpdf';

import { normaliseWhitespace } from './form-parser';

export interface ExtractedDocument {
  filename: string;
  sha256: string;
  pageCount: number;
  /** Raw page text, as extracted. */
  pages: string[];
  /** Whitespace-normalised page text, used for verbatim quote verification. */
  normalisedPages: string[];
}

export async function extractPdf(path: string): Promise<ExtractedDocument> {
  const buffer = readFileSync(path);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  const pages = Array.isArray(text) ? text : [text];
  return {
    filename: path.split('/').pop() ?? path,
    sha256,
    pageCount: totalPages,
    pages,
    normalisedPages: pages.map(normaliseWhitespace),
  };
}

/**
 * Is `quote` present verbatim on `pageText`?
 *
 * Compared after whitespace normalisation, because the extractor inserts line breaks
 * mid-sentence, and capped at 25 words, because a "quote" longer than that is a
 * paraphrase of the page rather than a citation of it (brief §7.2).
 */
export function quoteAppearsOnPage(quote: string, pageText: string, maxWords = 25): boolean {
  const q = normaliseWhitespace(quote);
  if (!q) return false;
  if (q.split(' ').length > maxWords) return false;
  return normaliseWhitespace(pageText).toLowerCase().includes(q.toLowerCase());
}
