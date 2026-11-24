-- Where a check can be looked at.
--
-- A check that says the market size is ten times its own inputs is only useful if
-- the reader can get to the slide in one click. The market checks know their page;
-- credential and deck-vs-form checks span two documents and legitimately have no
-- single page, so these stay nullable rather than being faked.
alter table recon_checks
  add column if not exists page_number integer,
  add column if not exists document_kind text;
