// Salir de la factura con el centinela de «cambios sin guardar» puesto
// (F-047): la accion redirige con replace, para no dejar en el historial la
// entrada repetida detras de la siguiente factura. Sin el, push (lo normal).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { reviewForm } from "./helpers/reviewForm";
import { deferInvoice, rejectInvoice, validateInvoice } from "@/app/dashboard/worker/review/[id]/actions";

let w: FirmWorld;
let id: string;
let nextId: string;

beforeEach(async () => {
  w = await makeFirm("A");
  ({ id } = await makeInvoice(w.client));
  ({ id: nextId } = await makeInvoice(w.client));
  await prisma.invoiceVatLine.create({ data: { invoiceId: id, position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 } });
  signInAs(w.worker);
});

/** El tipo de la redireccion ("push" | "replace") y a donde. */
async function redirectOf(p: Promise<unknown>) {
  const e = await p.then(
    (r) => { throw new Error(`no redirige: ${JSON.stringify(r)}`); },
    (err) => err as { message: string; url: string; redirectType: string },
  );
  expect(e.message).toBe("NEXT_REDIRECT");
  return { type: e.redirectType, url: e.url };
}

const simpleForm = (extra: Record<string, string>) => {
  const fd = new FormData();
  fd.set("invoiceId", id);
  fd.set("nextId", nextId);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
};

describe("redireccion al salir de la factura", () => {
  it.each([["", "push"], ["1", "replace"]])("validar con replaceHistory=%j hace %s", async (flag, type) => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    const fd = reviewForm(id, inv.updatedAt, w.client, { nextId, ...(flag ? { replaceHistory: flag } : {}) });
    expect(await redirectOf(validateInvoice(null, fd))).toEqual({ type, url: `/dashboard/worker/review/${nextId}` });
  });

  it.each([["", "push"], ["1", "replace"]])("posponer con replaceHistory=%j hace %s", async (flag, type) => {
    const fd = simpleForm(flag ? { replaceHistory: flag } : {});
    expect((await redirectOf(deferInvoice(null, fd))).type).toBe(type);
  });

  it.each([["", "push"], ["1", "replace"]])("rechazar con replaceHistory=%j hace %s", async (flag, type) => {
    const fd = simpleForm({ rejectionReason: "Ilegible", ...(flag ? { replaceHistory: flag } : {}) });
    expect((await redirectOf(rejectInvoice(null, fd))).type).toBe(type);
  });
});
