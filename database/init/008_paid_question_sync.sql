ALTER TABLE listener_questions
  ADD COLUMN IF NOT EXISTS external_question_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_listener_questions_external_id
  ON listener_questions (external_question_id)
  WHERE external_question_id IS NOT NULL;
