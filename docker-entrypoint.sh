#!/bin/sh
# Arranque del contenedor: aplica migraciones pendientes y luego levanta Next.
# `migrate deploy` es idempotente y seguro (solo aplica lo pendiente; Prisma usa
# un advisory lock, así que no pisa nada aunque arranque más de una instancia).
set -e

echo "→ Aplicando migraciones de base de datos (prisma migrate deploy)…"
npx prisma migrate deploy

echo "→ Arrancando Next.js en :${PORT:-3000}…"
exec npx next start -p "${PORT:-3000}" -H "${HOSTNAME:-0.0.0.0}"
