// Reglas de validación en el servidor (paso 15: F-009, F-014, F-022, F-025,
// F-058), contra Postgres: lo que la acción rechaza no llega a la BD.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { reviewForm, settleAction, validate } from "./helpers/reviewForm";
import { saveInvoiceFields } from "@/app/dashboard/worker/review/[id]/actions";

let w: FirmWorld;
let id: string;
const row = () => prisma.invoice.findUniqueOrThrow({ where: { id }, include: { vatLines: true } });
const form = async (extra: Record<string, string>) => reviewForm(id, (await row()).updatedAt, w.client, extra);
const save = async (extra: Record<string, string>) => settleAction(saveInvoiceFields(null, await form(extra)));

beforeEach(async () => {
  w = await makeFirm("A");
  ({ id } = await makeInvoice(w.client));
  await prisma.invoiceVatLine.create({ data: { invoiceId: id, position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 } });
  signInAs(w.worker);
});

describe("líneas de IVA incompletas (F-014)", () => {
  // El caso de la auditoría: la segunda línea sin %; antes se guardaba solo
  // la primera y el total 176 quedaba descuadrado sin que nadie lo viera.
  const incompleta = {
    vatLines: JSON.stringify([
      { taxBase: "100", vatRate: "21", vatAmount: "21" },
      { taxBase: "50", vatRate: "", vatAmount: "5" },
    ]),
    totalAmount: "176",
  };
  const mensaje = "La línea 2 de IVA está incompleta: falta el % de IVA. Rellénala (0 si es exenta) o bórrala.";

  it.each([
    ["guardar", () => save(incompleta)],
    ["validar", async () => validate(await form(incompleta))],
  ])("%s: { error } con la línea que falta y la factura no cambia", async (_accion, act) => {
    const antes = await row();
    expect((await act()).error).toBe(mensaje);
    const despues = await row();
    expect(despues).toEqual(antes);
    expect(despues.vatLines).toHaveLength(1);
  });

  it("una exenta con solo la base tampoco se pierde", async () => {
    const r = await save({
      vatLines: JSON.stringify([{ taxBase: "100", vatRate: "21", vatAmount: "21" }, { taxBase: "50", vatRate: "", vatAmount: "" }]),
      totalAmount: "171",
    });
    expect(r.error).toBe("La línea 2 de IVA está incompleta: falta el % de IVA y la cuota. Rellénala (0 si es exenta) o bórrala.");
    expect((await row()).vatLines).toHaveLength(1);
  });

  it("completa con 0 % y cuota 0 sí se guarda, y la fila vacía se ignora", async () => {
    const r = await save({
      vatLines: JSON.stringify([
        { taxBase: "100", vatRate: "21", vatAmount: "21" },
        { taxBase: "50", vatRate: "0", vatAmount: "0" },
        { taxBase: "", vatRate: "", vatAmount: "" },
      ]),
      totalAmount: "171",
    });
    expect(r.error).toBeNull();
    const lines = (await row()).vatLines.sort((a, b) => a.position - b.position);
    expect(lines.map((l) => [Number(l.taxBase), Number(l.vatRate), Number(l.vatAmount)])).toEqual([[100, 21, 21], [50, 0, 0]]);
  });
});
