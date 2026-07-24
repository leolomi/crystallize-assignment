#!/usr/bin/env bash
#
# Crash-resume demo. Requires `bun run api` + `bun run dispatcher` running.
#
# Submits a 50k-row job, lets the dispatcher spawn a runner, kill -9's that
# runner mid-job, then re-fires it and proves the final state is correct with
# no double-applied rows.
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
echo "  task = $TASK_ID (dispatcher will claim + spawn a runner)"

echo "▶ waiting for the runner to make progress…"
RPID=""
for _ in $(seq 1 50); do
  RPID=$(pgrep -f "runner/main.ts $TASK_ID" | head -1 || true)
  DONE=$(q "select count(*) from task_row where task_id='$TASK_ID' and status='done'")
  [ -n "$RPID" ] && [ "$DONE" -gt 500 ] && break
  sleep 0.3
done
echo "  runner pid = $RPID, $DONE rows done"

echo "▶ kill -9 $RPID  (hard crash, mid-transaction)"
kill -9 "$RPID"; sleep 1

echo "── state right after the crash ─────────────────────────────"
printf "  task status         : %s\n" "$(q "select status from task where id='$TASK_ID'")"
printf "  rows done / pending : %s / %s\n" \
  "$(q "select count(*) from task_row where task_id='$TASK_ID' and status='done'")" \
  "$(q "select count(*) from task_row where task_id='$TASK_ID' and status='pending'")"
printf "  products applied    : %s\n" "$(m 'db.products.countDocuments()')"

echo "▶ re-fire the runner (what a stale-runner sweeper / redeploy would do)"
bun run runner "$TASK_ID" 2>&1 | grep -E 'COMPLETED|FAILED' || true

echo "── final state ─────────────────────────────────────────────"
printf "  task status         : %s\n" "$(q "select status from task where id='$TASK_ID'")"
printf "  rows done           : %s / %s\n" \
  "$(q "select count(*) from task_row where task_id='$TASK_ID' and status='done'")" "$ROWS"
printf "  products applied    : %s / %s   (unique by _id — no dupes possible)\n" \
  "$(m 'db.products.countDocuments()')" "$ROWS"
printf "  rows applied twice  : %s   <-- must be 0 (no double-apply)\n" \
  "$(q "select count(*) from task_row where task_id='$TASK_ID' and attempts>1")"

rm -f "$JOB"
