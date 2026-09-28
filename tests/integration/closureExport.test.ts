// F-041 (revisión 1 del PR #13, punto 1): el «Exportar» de un cierre lleva
// a la exportación trimestral si el periodo cerrado es un trimestre.
import { describe, it, expect, beforeEach } from "vitest";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { closureExportSelections } from "@/lib/closureExport";

let w: FirmWorld;
beforeEach(async () => {
  w = await makeFirm("A");
});

describe("closureExportSelections", () => {
  it("un T3 subido en trimestral (month=7): trimestral", async () => {
    await makeInvoice(w.client, { periodType: "QUARTERLY", periodMonth: 7, periodYear: 2026 });
    expect(await closureExportSelections([{ clientId: w.client.id, month: 7, year: 2026 }], w.firm.id)).toEqual([
      { clientId: w.client.id, periodType: "QUARTERLY", month: 7, year: 2026, type: "ALL" },
    ]);
  });

  it("mensual, sin facturas o un mes que no empieza trimestre: mensual", async () => {
    await makeInvoice(w.client, { periodType: "MONTHLY", periodMonth: 4, periodYear: 2026 });
    await makeInvoice(w.client, { periodType: "QUARTERLY", periodMonth: 8, periodYear: 2026, totalAmount: 242 });
    const result = await closureExportSelections([
      { clientId: w.client.id, month: 4, year: 2026 },
      { clientId: w.client.id, month: 10, year: 2026 },
      { clientId: w.client.id, month: 8, year: 2026 },
    ], w.firm.id);
    expect(result.map((s) => s.periodType)).toEqual(["MONTHLY", "MONTHLY", "MONTHLY"]);
  });

  it("las facturas de otra asesoría no cuentan", async () => {
    const b = await makeFirm("B");
    await makeInvoice(b.client, { periodType: "QUARTERLY", periodMonth: 7, periodYear: 2026 });
    const [selection] = await closureExportSelections([{ clientId: b.client.id, month: 7, year: 2026 }], w.firm.id);
    expect(selection.periodType).toBe("MONTHLY");
  });
});
