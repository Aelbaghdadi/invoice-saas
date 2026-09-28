// F-041: la vista previa cuenta las sin validar del periodo, y el fichero
// trimestral se llama por su trimestre.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { GET as exportPreview, POST as exportDownload } from "@/app/api/export/route";

let w: FirmWorld;
const april = { periodMonth: 4, invoiceDate: new Date("2026-04-15") };

const preview = async (periodType = "MONTHLY") => {
  const res = await exportPreview(new NextRequest(
    `http://app.local/api/export?clientId=${w.client.id}&periodType=${periodType}&month=4&year=2026&preview=1`,
  ));
  expect(res.status).toBe(200);
  return res.json();
};

beforeEach(async () => {
  w = await makeFirm("A");
  signInAs(w.admin);
  await makeInvoice(w.client, { ...april, status: "VALIDATED", invoiceNumber: "OK" });
});

describe("sin validar en la vista previa (F-041)", () => {
  it("cuenta las pendientes del periodo, y no las rechazadas ni las de otro periodo o asesoría", async () => {
    await makeInvoice(w.client, { ...april, status: "PENDING_REVIEW", totalAmount: 242 });
    await makeInvoice(w.client, { ...april, status: "NEEDS_ATTENTION", totalAmount: 363 });
    await makeInvoice(w.client, { ...april, status: "REJECTED", totalAmount: 484 });
    await makeInvoice(w.client, { periodMonth: 5, status: "PENDING_REVIEW", totalAmount: 605 });
    const b = await makeFirm("B");
    await makeInvoice(b.client, { ...april, status: "PENDING_REVIEW" });
    const body = await preview();
    expect([body.count, body.notValidated]).toEqual([1, 2]);
    // En trimestral, las de mayo también.
    expect((await preview("QUARTERLY")).notValidated).toBe(3);
  });

  it("sin pendientes, 0", async () => {
    expect((await preview()).notValidated).toBe(0);
  });
});

describe("nombre del fichero (F-041)", () => {
  it("trimestral: «T2», no el primer mes", async () => {
    const res = await exportDownload(new NextRequest("http://app.local/api/export", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", host: "app.local" },
      body: JSON.stringify({ clientId: w.client.id, periodType: "QUARTERLY", month: 4, year: 2026 }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("2026-T2_a3excel.xlsx");
    const batch = await prisma.exportBatch.findFirstOrThrow();
    expect(batch.periodType).toBe("QUARTERLY");
  });
});
