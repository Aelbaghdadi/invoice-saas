import { describe, it, expect } from "vitest";
import { parseInvoiceNumber, findNumberingGaps } from "@/lib/invoiceNumbering";

const gapsOf = (numbers: string[]) =>
  findNumberingGaps(numbers.map((n, i) => ({ id: `id${i}`, invoiceNumber: n })));

describe("parseInvoiceNumber", () => {
  it("separa serie y correlativo en formatos habituales", () => {
    expect(parseInvoiceNumber("2026-045")).toMatchObject({ prefix: "2026-", suffix: "", seq: 45 });
    expect(parseInvoiceNumber("FRA0001")).toMatchObject({ prefix: "FRA", seq: 1 });
    expect(parseInvoiceNumber("A/123")).toMatchObject({ prefix: "A/", seq: 123 });
    expect(parseInvoiceNumber("12")).toMatchObject({ prefix: "", seq: 12 });
  });

  it("en NNNN/AAAA el correlativo es el numero y no el año", () => {
    expect(parseInvoiceNumber("EXP-0007/2026")).toMatchObject({
      prefix: "EXP-", suffix: "/2026", seq: 7, width: 4,
    });
    expect(parseInvoiceNumber("45/2026")).toMatchObject({ prefix: "", suffix: "/2026", seq: 45 });
    expect(parseInvoiceNumber("45-2026")).toMatchObject({ seq: 45 });
  });

  it("en AAAA/NNNN (año delante) el correlativo es el ultimo tramo", () => {
    expect(parseInvoiceNumber("2026/045")).toMatchObject({ prefix: "2026/", seq: 45 });
    expect(parseInvoiceNumber("2026/1234")).toMatchObject({ prefix: "2026/", seq: 1234 });
  });

  it("un numero que solo es un año sin correlativo delante se trata como correlativo", () => {
    expect(parseInvoiceNumber("A-2025")).toMatchObject({ prefix: "A-", seq: 2025 });
  });

  it("formatos reales: sufijo de rectificativa, nombre en medio, año delante", () => {
    expect(parseInvoiceNumber("SM-2026-0142-R")).toMatchObject({
      prefix: "SM-2026-", suffix: "-R", seq: 142, width: 4,
    });
    expect(parseInvoiceNumber("F-2026-Cliente4-0001")).toMatchObject({
      prefix: "F-2026-Cliente4-", seq: 1,
    });
    expect(parseInvoiceNumber("2025/073")).toMatchObject({ prefix: "2025/", seq: 73 });
  });

  it("devuelve null si no tiene ningun digito", () => {
    expect(parseInvoiceNumber("SIN-NUMERO")).toBeNull();
  });
});

describe("findNumberingGaps", () => {
  it("detecta un hueco simple (1, 2, 4 -> falta el 3)", () => {
    const gaps = gapsOf(["1", "2", "4"]);
    expect(gaps.get("id2")).toEqual({ previousNumber: "2", missing: ["3"] });
    expect(gaps.size).toBe(1);
  });

  it("detecta varios numeros que faltan", () => {
    expect(gapsOf(["1", "5"]).get("id1")?.missing).toEqual(["2", "3", "4"]);
  });

  it("ordena aunque lleguen desordenadas", () => {
    expect(gapsOf(["4", "1", "2"]).get("id0")).toEqual({ previousNumber: "2", missing: ["3"] });
  });

  it("no avisa cuando la numeracion es correlativa o con una sola factura", () => {
    expect(gapsOf(["1", "2", "3"]).size).toBe(0);
    expect(gapsOf(["1"]).size).toBe(0);
  });

  it("ignora facturas sin numero o sin digitos", () => {
    const gaps = findNumberingGaps([
      { id: "a", invoiceNumber: "1" },
      { id: "b", invoiceNumber: null },
      { id: "c", invoiceNumber: "SIN-NUMERO" },
      { id: "d", invoiceNumber: "2" },
    ]);
    expect(gaps.size).toBe(0);
  });

  it("no mezcla series distintas", () => {
    const gaps = gapsOf(["A-1", "B-1", "A-3"]);
    expect(gaps.get("id2")?.missing).toEqual(["A-2"]);
    expect(gaps.size).toBe(1);
  });

  it("ignora saltos enormes (probable serie mal agrupada, no un hueco real)", () => {
    expect(gapsOf(["1", "9999"]).size).toBe(0);
  });

  it("NNNN/AAAA: detecta el hueco y lo devuelve con el mismo formato", () => {
    const gaps = gapsOf(["EXP-0005/2026", "EXP-0006/2026", "EXP-0008/2026"]);
    expect(gaps.get("id2")).toEqual({
      previousNumber: "EXP-0006/2026",
      missing: ["EXP-0007/2026"],
    });
  });

  it("NNNN/AAAA: un año nuevo empieza otra secuencia, sin falso hueco", () => {
    expect(gapsOf(["EXP-0098/2025", "EXP-0099/2025", "EXP-0001/2026"]).size).toBe(0);
  });

  it("AAAA-NNN: detecta el hueco dentro del mismo año", () => {
    expect(gapsOf(["2026-044", "2026-046"]).get("id1")?.missing).toEqual(["2026-045"]);
  });

  it("rectificativas (-R) llevan su propia serie: no se mezclan con las ordinarias", () => {
    expect(gapsOf(["SM-2026-0141", "SM-2026-0142-R", "SM-2026-0143"]).get("id2")?.missing)
      .toEqual(["SM-2026-0142"]);
    expect(gapsOf(["SM-2026-0140-R", "SM-2026-0142-R"]).get("id1")?.missing)
      .toEqual(["SM-2026-0141-R"]);
  });

  it("numero con el nombre del cliente en medio", () => {
    expect(gapsOf(["F-2026-Cliente4-0001", "F-2026-Cliente4-0003"]).get("id1")?.missing)
      .toEqual(["F-2026-Cliente4-0002"]);
  });

  it("año delante: 2025/073 y 2025/075", () => {
    expect(gapsOf(["2025/073", "2025/075"]).get("id1")?.missing).toEqual(["2025/074"]);
  });
});
