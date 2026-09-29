import { describe, it, expect } from "vitest";
import { auditChainHeads, planAuditRecords, type AuditChainRow } from "@/lib/auditLog";

function ids(...list: string[]) {
  const queue = [...list];
  return () => queue.shift()!;
}

const T0 = new Date("2026-09-26T10:00:00.000Z");

describe("planAuditRecords", () => {
  it("mantiene el hash de siempre (mismo computeAuditHash y mismos campos)", () => {
    // Valores calculados con el algoritmo antes de este cambio.
    const records = planAuditRecords(
      [
        { invoiceId: "inv1", userId: "u1", field: "export", newValue: "Exportada (batch: b1, formato: a3excel)" },
        { invoiceId: "inv1", userId: "u1", field: "status", oldValue: "VALIDATED", newValue: "X" },
        // Sin oldValue ni newValue (vaciar un campo): se guardan como null y
        // entran en el hash como "". Si alguien cambiara ese "" por "null",
        // todos los registros historicos con NULL dejarian de verificar.
        { invoiceId: "inv1", userId: "u1", field: "f" },
      ],
      new Map(),
      T0,
      ids("cA", "cB", "cC"),
    );
    expect(records[0]).toMatchObject({
      id: "cA",
      prevId: null,
      prevHash: "GENESIS",
      oldValue: null,
      createdAt: T0,
      hash: "9e364ddf8a7ab9f0cc9e79e909f77c4addbd7a51b401b97152de619925e91c42",
    });
    expect(records[1]).toMatchObject({
      id: "cB",
      prevId: "cA",
      prevHash: records[0].hash,
      createdAt: new Date("2026-09-26T10:00:00.001Z"),
      hash: "d842078ddf7f5e8b124afd5999a2bb087fdb304838063c9026cf1b5173aa21ec",
    });
    expect(records[2]).toMatchObject({
      id: "cC",
      prevId: "cB",
      prevHash: records[1].hash,
      createdAt: new Date("2026-09-26T10:00:00.002Z"),
      hash: "7001344aab5baf9499aaff251e5936b5ed46ba6f81fcf80c94d3d9bb069a275f",
    });
    // null, no "": la BD guarda NULL y la verificacion lo lee asi.
    expect(records[2].oldValue).toBeNull();
    expect(records[2].newValue).toBeNull();
  });

  it("encadena detrás de la cabeza existente de cada factura", () => {
    const heads = new Map([["inv1", { id: "old", hash: "h-old", createdAt: new Date("2026-01-01T00:00:00Z") }]]);
    const [record] = planAuditRecords(
      [{ invoiceId: "inv1", userId: "u1", field: "export" }],
      heads,
      T0,
      ids("new"),
    );
    expect(record.prevId).toBe("old");
    expect(record.prevHash).toBe("h-old");
    expect(record.createdAt).toEqual(T0);
  });

  it("cada factura lleva su propia cadena", () => {
    const records = planAuditRecords(
      [
        { invoiceId: "inv1", userId: "u1", field: "export" },
        { invoiceId: "inv2", userId: "u1", field: "export" },
      ],
      new Map(),
      T0,
      ids("a", "b"),
    );
    expect(records.map((r) => [r.prevId, r.prevHash])).toEqual([[null, "GENESIS"], [null, "GENESIS"]]);
  });

  it("nunca repite ni retrocede el createdAt dentro de una cadena", () => {
    const heads = new Map([["inv1", { id: "old", hash: "h", createdAt: T0 }]]);
    const records = planAuditRecords(
      [
        { invoiceId: "inv1", userId: "u1", field: "a" },
        { invoiceId: "inv1", userId: "u1", field: "b" },
      ],
      heads,
      T0,
      ids("x", "y"),
    );
    expect(records.map((r) => r.createdAt.toISOString())).toEqual([
      "2026-09-26T10:00:00.001Z",
      "2026-09-26T10:00:00.002Z",
    ]);
  });
});

describe("auditChainHeads", () => {
  const row = (id: string, prevId: string | null, ms: number, invoiceId = "inv1"): AuditChainRow => ({
    id,
    invoiceId,
    prevId,
    hash: `h-${id}`,
    createdAt: new Date(T0.getTime() + ms),
  });

  it("devuelve el último eslabón de cada factura", () => {
    const heads = auditChainHeads([row("a", null, 0), row("b", "a", 5), row("x", null, 0, "inv2")]);
    expect(heads.get("inv1")?.id).toBe("b");
    expect(heads.get("inv2")?.id).toBe("x");
  });

  it("con dos eslabones en el mismo milisegundo elige el que no tiene sucesor", () => {
    // "z" > "b" por id: sin mirar prevId se habría elegido "z", que ya tiene sucesor.
    const heads = auditChainHeads([row("a", null, 0), row("z", "a", 5), row("b", "z", 5)]);
    expect(heads.get("inv1")?.id).toBe("b");
  });

  it("sin registros no hay cabeza: la cadena empieza en GENESIS", () => {
    expect(auditChainHeads([]).size).toBe(0);
  });
});
