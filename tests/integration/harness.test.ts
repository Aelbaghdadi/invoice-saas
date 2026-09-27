import { describe, it, expect } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { getObjectBytes, putObject } from "@/lib/storage";

describe("harness de integración", () => {
  it("usa la base de datos de TEST_DATABASE_URL, con las migraciones aplicadas", async () => {
    const [{ current_database }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    expect(process.env.TEST_DATABASE_URL).toContain(current_database);
    const applied = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(Number(applied[0].n)).toBeGreaterThan(0);
  });

  it("deja escribir (este test) …", async () => {
    await prisma.advisoryFirm.create({ data: { name: "Asesoría", cif: "A00000001" } });
    expect(await prisma.advisoryFirm.count()).toBe(1);
  });

  it("… y el siguiente empieza con la base de datos vacía", async () => {
    expect(await prisma.advisoryFirm.count()).toBe(0);
  });

  it("el almacenamiento va al S3 en memoria", async () => {
    await putObject("c1/2026-09/prueba.txt", Buffer.from("hola"), "text/plain");
    expect(fakeS3().keys()).toEqual(["c1/2026-09/prueba.txt"]);
    expect((await getObjectBytes("c1/2026-09/prueba.txt")).toString()).toBe("hola");
  });
});
