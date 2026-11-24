-- All In Capital — 0013 record when Riya edits a draft
--
-- `created_at` is when the model wrote it. An edit is a different event, and the
-- §11 payback calculation needs to tell them apart: "sent as-is" means no edit
-- row, and that is the number the whole fine-tuning case turns on.

alter table email_drafts
  add column if not exists edited_at timestamptz;
