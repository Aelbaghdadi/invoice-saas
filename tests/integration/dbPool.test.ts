// F-080: el pool de la app tiene tope de conexiones y de tiempo por consulta.
import { describe, it, expect } from "vitest";
import { prisma } from "./helpers/db";
import { DB_POOL_MAX, DB_STATEMENT_TIMEOUT_MS } from "@/lib/prisma";

describe("pool de la BD (F-080)", () => {
  it("cada conexión tiene statement_timeout de 15 s", async () => {
    expect(DB_STATEMENT_TIMEOUT_MS).toBe(15_000);
    const [row] = await prisma.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    expect(row.statement_timeout).toBe("15s");
  });

  it("una consulta que pasa del tope se corta", async () => {
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '200ms'`);
      await tx.$queryRaw`SELECT pg_sleep(1)::text`;
    })).rejects.toThrow(/statement timeout/);
  });

  it(`como mucho ${DB_POOL_MAX} conexiones a la vez, aunque se pidan más`, { timeout: 20_000 }, async () => {
    const sleeping = () => prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND query LIKE '%pg_sleep(0.8)%' AND state = 'active' AND pid <> pg_backend_pid()`;
    let peak = 0;
    const load = Promise.all(Array.from({ length: DB_POOL_MAX + 10 }, () => prisma.$queryRaw`SELECT pg_sleep(0.8)::text`));
    // El muestreo también necesita una conexión: se mira mientras duran.
    const sampler = (async () => {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 150));
        peak = Math.max(peak, (await sleeping())[0].n);
      }
    })();
    await Promise.all([load, sampler]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(DB_POOL_MAX);
  });
});
