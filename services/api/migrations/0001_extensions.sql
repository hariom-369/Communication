-- Extensions required by the schema design (docs/database.md):
--   citext  — case-insensitive usernames and email addresses
--   pg_trgm — trigram indexes for public directory search (ADR-025)
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
