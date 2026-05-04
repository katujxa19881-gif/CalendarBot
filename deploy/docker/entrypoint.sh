#!/usr/bin/env sh
set -eu

if [ -f /app/.env ]; then
  echo "Using /app/.env"
fi

npx prisma migrate deploy
exec "$@"
