#!/bin/sh
set -e

# If Litestream is configured (S3 bucket set), restore and replicate.
# Otherwise, run the relay directly (backward compatible).
if [ -n "$LITESTREAM_REPLICA_BUCKET" ] && command -v litestream >/dev/null 2>&1; then
  # Restore database from S3 if it exists (no-op on first deploy)
  litestream restore -if-replica-exists -config /app/litestream.yml /data/motebit.db

  # Start relay under litestream (WAL changes stream to S3)
  exec litestream replicate -exec "node dist/index.js" -config /app/litestream.yml
else
  # No Litestream — run relay directly (volume-only persistence)
  exec node dist/index.js
fi
