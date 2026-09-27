#!/bin/sh
# Arranque del contenedor: aplica migraciones pendientes y luego levanta Next.
# `migrate deploy` es idempotente y seguro (solo aplica lo pendiente; Prisma usa
# un advisory lock, así que no pisa nada aunque arranque más de una instancia).
set -e

echo "→ Aplicando migraciones de base de datos (prisma migrate deploy)…"
npx prisma migrate deploy

echo "→ Arrancando Next.js en :${PORT:-3000}…"
# node directo y no `npx`: con npx, el SIGTERM de un Redeploy le llegaba a npm
# y Node moria sin margen para terminar los after() en curso (el OCR de las
# facturas recien subidas). Coolify tiene que esperar al menos 120 s antes
# del SIGKILL (ver DEPLOY.md).
exec node node_modules/next/dist/bin/next start -p "${PORT:-3000}" -H "${HOSTNAME:-0.0.0.0}"
