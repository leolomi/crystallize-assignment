#!/usr/bin/env bash
#
# Graceful-shutdown demo. Requires `bun run api` + `bun run dispatcher` running.
#
# Submits a 50k-row job, SIGTERMs the runner mid-job, and shows it drains its
# in-flight rows, exits 0, and leaves the task resumable — then finishes it.
set -euo pipefail

API=${API:-http://localhost:3000}
PG=${PG:-bulk-runner-postgres-1}
MONGO=${MONGO:-bulk-runner-mongo-1}
ROWS=${ROWS:-50000}
JOB=$(mktemp -t job.XXXXXX.ndjson)

q() { docker exec -e PGPASSWORD=postgres "$PG" psql -U postgres -d bulk_runner -tAc "$1"; }
m() { docker exec "$MONGO" mongosh bulk_runner --quiet --eval "$1"; }
jsonf() { bun -e 'process.stdout.write(JSON.parse(await Bun.stdin.text())["'"$1"'"]+"")'; }

echo "▶ clean slate + generate $ROWS-row job"
q "truncate task, task_row restart identity cascade" >/dev/null
m "db.products.drop(); db.catalogue_index.drop()" >/dev/null
bun run seed "$ROWS" "$JOB" >/dev/null

echo "▶ POST /tasks/product-price-updates"
TASK_ID=$(curl -s -XPOST "$API/tasks/product-price-updates" -H 'Content-Type: application/x-ndjson' --data-binary @"$JOB" | jsonf id)
echo "  task = $TASK_ID"

echo "▶ waiting for the runner to make progress…"
RPID=""
for _ in $(seq 1 50); do
  RPID=$(pgrep -f "runner/main.ts $TASK_ID" | head -1 || true)
  DONE=$(q "select count(*) from task_row where task_id='$TASK_ID' and status='done'")
  [ -n "$RPID" ] && [ "$DONE" -gt 500 ] && break
  sleep 0.3
done
echo "  runner pid = $RPID, $DONE rows done"

echo "▶ SIGTERM $RPID  (rolling-deploy signal)"
BEFORE=$(q "select count(*) from task_row where task_id='$TASK_ID' and status='done'")
kill -TERM "$RPID"
# wait for the process to exit
while kill -0 "$RPID" 2>/dev/null; do sleep 0.2; done
AFTER=$(q "select count(*) from task_row where task_id='$TASK_ID' and status='done'")

echo "── after graceful drain ────────────────────────────────────"
printf "  task status         : %s   (resumable, not corrupted)\n" "$(q "select status from task where id='$TASK_ID'")"
printf "  done at SIGTERM     : %s\n" "$BEFORE"
printf "  done after drain    : %s   (in-flight rows were finished, not abandoned)\n" "$AFTER"
printf "  rows pending        : %s\n" "$(q "select count(*) from task_row where task_id='$TASK_ID' and status='pending'")"

echo "▶ resume (fresh runner finishes the job)"
bun run runner "$TASK_ID" 2>&1 | grep -E 'COMPLETED|FAILED' || true

echo "── final state ─────────────────────────────────────────────"
printf "  task status         : %s\n" "$(q "select status from task where id='$TASK_ID'")"
printf "  rows done           : %s / %s\n" \
  "$(q "select count(*) from task_row where task_id='$TASK_ID' and status='done'")" "$ROWS"
printf "  rows applied twice  : %s   <-- must be 0\n" \
  "$(q "select count(*) from task_row where task_id='$TASK_ID' and attempts>1")"

rm -f "$JOB"
