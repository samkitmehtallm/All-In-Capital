/**
 * The examples loop.
 *
 * "Each new invite is shown 3 of Riya's real sent emails (most similar first)
 * from a `style_examples` table. Every email she edits and sends is added to
 * that table."
 *
 * Two halves. The first reads her 60 historical emails out of the B6 export and
 * decides which of them are fit to imitate. The second retrieves the three
 * nearest to the application being drafted.
 *
 * ## Which rows are fit to imitate
 *
 * The brief plants two rows that break her own standard and says to drop them:
 * a 136-word boilerplate email and a "Dear Ms... Kind regards" one. They are not
 * marked in the file, so nothing here hard-codes their ids. The linter finds
 * them, which is the honest way round: an example that the linter would reject
 * cannot be shown to the model as the thing to copy, or the next draft inherits
 * the fault and the linter rejects that too.
 *
 * This also means the rule list and the example set can never drift apart. The
 * linter is the single definition of her standard.
 */

import { lintEmail, type Template } from './lint';
import { parseCsv } from '../ingest/csv';
import { redact } from '../redact';

export interface StyleExample {
  sourceRowId: string;
  template: Template;
  sector: string;
  stage: string;
  founderType: string;
  subject: string | null;
  /** Already redacted: the founder's name is [F1]. */
  body: string;
  wordCount: number;
  /** What the example is matched on. Never shown to the model as-is. */
  similarityText: string;
}

export interface LoadedExamples {
  clean: StyleExample[];
  /** Kept only to be reported. These are never shown to a model. */
  rejected: Array<{ sourceRowId: string; rules: string[] }>;
}

/**
 * What an example is embedded and matched on.
 *
 * Deliberately not the email body. Matching body-to-body would retrieve emails
 * that are worded alike, when what is wanted is emails written to a founder in
 * a like situation: same sector, same stage, same kind of traction number. The
 * body is what gets shown; this is what gets compared.
 */
export function similarityTextFor(parts: {
  sector: string;
  stage: string;
  founderType: string;
  tractionFacts: string;
}): string {
  return [
    `Sector: ${parts.sector}`,
    `Stage: ${parts.stage}`,
    `Founder type: ${parts.founderType}`,
    `Traction: ${parts.tractionFacts}`,
  ].join('\n');
}

/**
 * Read the B6 loop-2 export and keep the rows that pass the linter.
 *
 * The subject line is absent from the export, so examples carry none and the
 * subject rules are exercised only against generated drafts.
 */
export function loadLoop2Examples(csvText: string): LoadedExamples {
  const rows = parseCsv(csvText);
  const clean: StyleExample[] = [];
  const rejected: LoadedExamples['rejected'] = [];

  for (const row of rows) {
    const rowId = row.row_id;
    const final = row.riya_final_email;
    if (!final) continue;

    // Her sent emails are the first email in a thread: always an invite.
    const result = lintEmail({
      template: 'call_invite',
      // The export has no subject column. A placeholder that passes keeps the
      // subject rules from deciding which bodies are fit to imitate.
      subject: 'placeholder subject',
      body: final,
    });

    if (!result.passed) {
      rejected.push({ sourceRowId: rowId, rules: result.failures.map((f) => f.rule) });
      continue;
    }

    // The example is stored already masked, so nothing downstream can leak a
    // real founder's name by forgetting to redact at read time.
    const { text: body } = redact(final, [{ token: 'F1', fullName: row.founder_name }]);

    clean.push({
      sourceRowId: rowId,
      template: 'call_invite',
      sector: row.sector,
      stage: row.stage,
      founderType: row.founder_type,
      subject: null,
      body,
      wordCount: result.wordCount,
      similarityText: similarityTextFor({
        sector: row.sector,
        stage: row.stage,
        founderType: row.founder_type,
        tractionFacts: row.traction_facts,
      }),
    });
  }

  return { clean, rejected };
}

/** How many examples a draft is shown. The brief says three. */
export const EXAMPLES_PER_DRAFT = 3;

/**
 * Rank examples by similarity, most similar first.
 *
 * Takes pre-computed similarities so this stays pure and testable; the caller
 * does the vector search. Ties break towards the shorter email, because length
 * is the thing Riya edits most and the shorter one is the safer thing to copy.
 */
export function rankExamples<T extends { wordCount: number }>(
  scored: Array<{ example: T; similarity: number }>,
  limit = EXAMPLES_PER_DRAFT,
): T[] {
  return [...scored]
    .sort((a, b) => b.similarity - a.similarity || a.example.wordCount - b.example.wordCount)
    .slice(0, limit)
    .map((s) => s.example);
}

/** Render the retrieved examples for the prompt, most similar first. */
export function examplesAsPrompt(examples: Array<{ body: string; sector: string; stage: string }>): string {
  if (examples.length === 0) return '(No past emails available. Follow the shape above exactly.)';
  return examples
    .map(
      (e, i) =>
        `--- Email ${i + 1} (${e.stage} ${e.sector}; she sent this one) ---\n${e.body.trim()}`,
    )
    .join('\n\n');
}
