-- What a claim is ABOUT, from a closed vocabulary.
--
-- `metric` stays as the model's own free-text description, which is useful on
-- screen. `canonical` is what the reconciliation step pairs on across documents.
-- Added after the first full run compared payment volume against net revenue, and
-- read "INR 48,000 CAC per team" as a team of 48,000 people, because keyword
-- matching on free text cannot distinguish them.
alter table claims
  add column if not exists canonical text;

create index if not exists claims_canonical_idx on claims (application_id, canonical);
