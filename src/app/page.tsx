import { getBoard, LANES, type BoardCard } from '../lib/board';

/*
 * Board (home).
 *
 * A one-line headline in plain words, then four computed lanes. No source codes, no
 * scores as numbers, no cost, no model names — a founder reading over a partner's
 * shoulder should understand every word on this screen (brief §13).
 */

export const dynamic = 'force-dynamic';

export default async function BoardPage() {
  const board = await getBoard();
  const unplaced = board.cards.filter((c) => c.lane === null);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-[22px] leading-tight sm:text-[26px]">{board.headline}</h1>
        {board.pending ? (
          <p className="max-w-[62ch] text-[14px] leading-relaxed text-[var(--color-muted)]">
            {board.pending}
          </p>
        ) : null}
      </section>

      <section aria-label="Lanes" className="scroll-x -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="grid min-w-[900px] grid-cols-4 gap-4 lg:min-w-0">
          {LANES.map((lane) => {
            const cards = board.cards.filter((c) => c.lane === lane.key);
            return (
              <div key={lane.key} className="space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-[13.5px] font-semibold">{lane.label}</h2>
                  <span className="num text-[12px] text-[var(--color-subtle)]">{cards.length}</span>
                </div>

                {cards.length === 0 ? (
                  <p className="rounded-[12px] border border-dashed border-[var(--color-hairline)] px-3 py-6 text-center text-[12.5px] leading-relaxed text-[var(--color-subtle)]">
                    {lane.hint}
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {cards.map((card) => (
                      <li key={card.slug}>
                        <Card card={card} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {unplaced.length > 0 ? (
        <section aria-labelledby="being-read" className="space-y-3 pt-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="being-read" className="text-[13.5px] font-semibold">
              Read, not yet scored
            </h2>
            <span className="num text-[12px] text-[var(--color-subtle)]">{unplaced.length}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {unplaced.map((card) => (
              <Card key={card.slug} card={card} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Card({ card }: { card: BoardCard }) {
  return (
    <article className="card motion-quick p-3.5 hover:border-[var(--color-cobalt)]">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[14.5px] font-semibold leading-tight">{card.company}</h3>
        {card.ratingWord ? (
          <span className="text-[12px] text-[var(--color-muted)]">{card.ratingWord}</span>
        ) : null}
      </div>

      {card.oneLiner ? (
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-[var(--color-muted)]">
          {card.oneLiner}
        </p>
      ) : null}

      {card.judgement ? (
        <p className="mt-2.5 text-[13px] leading-snug">{card.judgement}</p>
      ) : null}

      {card.gates.length > 0 ? (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {card.gates.map((gate) => (
            <li
              key={gate.gateKey}
              className="rounded-[8px] bg-[var(--color-bad-tint)] px-2 py-1 text-[11.5px] font-medium text-[var(--color-bad)]"
              title={gate.reason}
            >
              {gate.plainName}
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--color-hairline)] pt-2.5 text-[11.5px] text-[var(--color-subtle)]">
        <div className="flex items-baseline gap-1.5">
          <dt className="sr-only">Raising</dt>
          <dd className="num text-[var(--color-muted)]">{card.raiseDisplay}</dd>
        </div>
        {card.sectorDeclared ? (
          <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">Sector</dt>
            <dd>{card.sectorDeclared}</dd>
          </div>
        ) : null}
        {card.location ? (
          <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">Location</dt>
            <dd>{card.location.split(',')[0]}</dd>
          </div>
        ) : null}
        <div className="ml-auto flex items-baseline gap-1.5">
          <dt className="sr-only">Pages read</dt>
          <dd className="num">{card.deckPages + card.formPages} pages</dd>
        </div>
      </dl>
    </article>
  );
}
