/**
 * Rate limiter en memoria (sliding window simple por key).
 *
 * Apto para single-instance. Para multi-instance conviene migrar a Redis o a
 * Upstash Ratelimit. El MVP corre en una sola instancia, asi que esto basta.
 *
 * Uso:
 *   const rl = rateLimit({ windowMs: 60_000, max: 5 });
 *   const ok = rl.check(`login:${ip}:${email}`);
 *   if (!ok.allowed) return 429(retryAfter: ok.retryAfterMs);
 */

type Hit = { count: number; resetAt: number };

type Options = {
  windowMs: number;
  max: number;
};

const STORE = new Map<string, Hit>();

// Limpieza oportunista cada N checks para evitar fugas de memoria.
let checkCounter = 0;
function gc() {
  if (++checkCounter < 500) return;
  checkCounter = 0;
  const now = Date.now();
  for (const [k, v] of STORE) {
    if (v.resetAt <= now) STORE.delete(k);
  }
}

export function rateLimit({ windowMs, max }: Options) {
  return {
    check(key: string): { allowed: boolean; retryAfterMs: number; remaining: number } {
      gc();
      const now = Date.now();
      const hit = STORE.get(key);
      if (!hit || hit.resetAt <= now) {
        STORE.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterMs: 0, remaining: max - 1 };
      }
      if (hit.count >= max) {
        return { allowed: false, retryAfterMs: hit.resetAt - now, remaining: 0 };
      }
      hit.count += 1;
      return { allowed: true, retryAfterMs: 0, remaining: max - hit.count };
    },
    reset(key: string) {
      STORE.delete(key);
    },
  };
}

/** Extrae la IP del request respetando proxies habituales. */
export function getClientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}

// Instancias compartidas para endpoints sensibles
export const loginRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
export const resetPasswordRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
