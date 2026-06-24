# Imagen de producción para Coolify (build pack: Dockerfile, puerto 3000).
#
# Estrategia: en lugar del output `standalone` recortado de Next, enviamos las
# node_modules de PRODUCCIÓN completas. Motivo: `prisma migrate deploy` necesita
# el CLI de Prisma (que a su vez arrastra @prisma/engines, postgres, etc.) en el
# contenedor, y recortarlo a mano es frágil. Con las deps de producción el
# arranque ejecuta las migraciones de forma fiable y luego `next start`.

# ---- base ----
FROM node:22-alpine AS base
# openssl: lo necesita el engine de Prisma. libc6-compat: binarios nativos en alpine.
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# ---- deps (todas: dev + prod, para el build) ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- builder ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# El script "build" ya hace `prisma generate && next build`.
RUN npm run build

# ---- prod-deps (solo producción; incluye el CLI de Prisma porque está en
#      dependencies) + cliente Prisma generado ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
RUN npx prisma generate

# ---- runner ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Build de Next + estáticos + configs
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json
# Prisma: schema + migraciones + config (para `migrate deploy` en el arranque)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# Bootstrap del primer admin (node plano, sin tsx)
COPY --from=builder /app/scripts/bootstrap-admin.mjs ./scripts/bootstrap-admin.mjs
# node_modules de producción (next, @prisma/client + cliente generado, prisma CLI, pg, dotenv…)
COPY --from=prod-deps /app/node_modules ./node_modules

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh && chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
