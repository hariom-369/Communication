#!/usr/bin/env bash
# Restore drill (docs/disaster-recovery.md §3, ops/runbooks/dr-restore.md): backs up a database
# with pg_dump, restores it into a new database, and proves the copy is whole before anyone
# relies on it — every table's row count equal, the same migrations applied, the audit log's
# hash chain intact, and the API boots on it and reports ready. Prints a JSON report with
# measured times; exits non-zero if any check fails.
#
#   SOURCE_URL=postgres://…/tessera  TARGET_ADMIN_URL=postgres://…/postgres \
#   API_DIR=services/api  ops/dr/restore-drill.sh > report.json
#
# SOURCE_URL needs read access to every table (tessera_readonly suffices); TARGET_ADMIN_URL must
# be able to create databases. The restore keeps owners and grants, so the roles of
# ops/db/roles.sql must exist on the target server. With API_ENV_FILE (shell exports for a
# development API configuration, without DATABASE_URL), the API is started on the copy.
# In AWS a restore is an RDS snapshot or point-in-time restore instead of pg_dump/pg_restore;
# the checks after it are the same (ops/runbooks/dr-restore.md).
set -euo pipefail

: "${SOURCE_URL:?}" "${TARGET_ADMIN_URL:?}"
API_DIR="${API_DIR:-services/api}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
target_db="restore_drill_$(date +%Y%m%d%H%M%S)"
target_url="$(python3 -c 'import sys, urllib.parse as u; p = u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/" + sys.argv[2])))' "$TARGET_ADMIN_URL" "$target_db")"
now() { date +%s.%N; }
since() { python3 -c "print(round($(now) - $1, 2))"; }

counts() {
  psql "$1" -X -q -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT format('SELECT %L || '' '' || count(*) FROM public.%I', tablename, tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \gexec
SQL
}
migrations() { psql "$1" -X -At -v ON_ERROR_STOP=1 -c "SELECT version || ' ' || checksum FROM schema_migrations ORDER BY version"; }

counts "$SOURCE_URL" > "$work/source.counts"
migrations "$SOURCE_URL" > "$work/source.migrations"

t=$(now)
pg_dump --format=custom --compress=6 --file="$work/backup.dump" "$SOURCE_URL"
dump_s=$(since "$t")
dump_bytes=$(stat -c %s "$work/backup.dump")

t=$(now)
psql "$TARGET_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$target_db\""
pg_restore --jobs=4 --exit-on-error --dbname="$target_url" "$work/backup.dump"
restore_s=$(since "$t")

t=$(now)
counts "$target_url" > "$work/target.counts"
migrations "$target_url" > "$work/target.migrations"
counts_equal=false; cmp -s "$work/source.counts" "$work/target.counts" && counts_equal=true
migrations_equal=false; cmp -s "$work/source.migrations" "$work/target.migrations" && migrations_equal=true
audit="$(cd "$API_DIR" && DATABASE_URL="$target_url" LOG_LEVEL=warn node dist/cli/verify-audit.js || true)"
verify_s=$(since "$t")

ready_s=None
if [ -n "${API_ENV_FILE:-}" ]; then
  t=$(now)
  # shellcheck disable=SC1090
  (source "$API_ENV_FILE"; cd "$API_DIR"; DATABASE_URL="$target_url" exec node dist/server.js) > "$work/api.log" 2>&1 &
  api=$!
  # shellcheck disable=SC1090
  health_port="$(source "$API_ENV_FILE"; echo "${HEALTH_PORT:-9090}")"
  for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$health_port/readyz" > /dev/null 2>&1; then ready_s=$(since "$t"); break; fi
    sleep 0.25
  done
  kill "$api" 2> /dev/null || true
  wait "$api" 2> /dev/null || true
fi

tables=$(wc -l < "$work/source.counts")
rows=$(awk '{ s += $2 } END { print s + 0 }' "$work/source.counts")
python3 - "$audit" <<PY
import json, sys
audit = json.loads(sys.argv[1]) if sys.argv[1].strip().startswith('{') else {"ok": False, "error": sys.argv[1]}
ready = $ready_s
report = {
    "targetDatabase": "$target_db",
    "tables": $tables,
    "rows": $rows,
    "dumpBytes": $dump_bytes,
    "seconds": {"dump": $dump_s, "restore": $restore_s, "verify": $verify_s, "apiReady": ready},
    "checks": {
        "rowCountsEqual": "$counts_equal" == "true",
        "migrationsEqual": "$migrations_equal" == "true",
        "auditChain": audit,
        "apiReady": ready is not None if "${API_ENV_FILE:-}" else None,
    },
}
ok = report["checks"]["rowCountsEqual"] and report["checks"]["migrationsEqual"] and audit.get("ok") is True \
    and report["checks"]["apiReady"] is not False
report["ok"] = ok
print(json.dumps(report, indent=2))
sys.exit(0 if ok else 1)
PY
