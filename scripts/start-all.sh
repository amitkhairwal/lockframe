#!/usr/bin/env bash
# API and worker in one container, for a host that gives one free web service and no worker.
# If either process exits, stop the other too, so the host restarts the whole container.
node --import tsx apps/worker/src/index.ts &
node --import tsx apps/api/src/index.ts &
trap 'kill $(jobs -p) 2>/dev/null' TERM INT
wait -n
code=$?
kill $(jobs -p) 2>/dev/null
wait
exit $code
