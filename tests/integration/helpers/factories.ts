import type { Invoice, InvoiceStatus, Prisma } from "@prisma/client";
import { prisma } from "./db";
import type { TestSessionUser } from "./session";

/**
 * Datos de prueba. makeFirm crea una asesoria completa (admin, gestor
 * asignado a un cliente con acceso al portal y un par de facturas);
 * makeTwoFirms crea dos, «A» y «B», para los tests de aislamiento entre
 * asesorias. Los CIF y emails llevan la etiqueta para no chocar.
 *
 * No se genera passwordHash real: estos usuarios no pasan por el login.
 */
export type FirmWorld = {
  tag: string;
  firm: { id: string; name: string };
  admin: TestSessionUser & { username: string };
  worker: TestSessionUser & { username: string };
  clientUser: TestSessionUser & { username: string };
  client: { id: string; name: string; cif: string; advisoryFirmId: string };
  invoices: { pending: Invoice; validated: Invoice };
};

let sequence = 0;
const next = () => ++sequence;

/** CIF con formato de sociedad (letra + 8 digitos); unico en la ejecucion. */
function fakeCif(letter: string) {
  return `${letter}${String(10_000_000 + next()).slice(-8)}`;
}

export async function makeUser(
  firmId: string | null,
  role: "ADMIN" | "WORKER" | "CLIENT",
  label: string,
) {
  const n = next();
  const user = await prisma.user.create({
    data: {
      username: `${label}${n}`,
      email: `${label}${n}@pruebas.es`,
      passwordHash: "sin-login",
      name: label,
      role,
      advisoryFirmId: firmId,
    },
  });
  return { id: user.id, role, advisoryFirmId: firmId, username: user.username };
}

export async function makeInvoice(
  client: { id: string },
  overrides: Partial<Prisma.InvoiceUncheckedCreateInput> & { status?: InvoiceStatus } = {},
): Promise<Invoice> {
  const n = next();
  return prisma.invoice.create({
    data: {
      filename: `f${n}.pdf`,
      storageKey: `${client.id}/2026-09/f${n}.pdf`,
      fileType: "application/pdf",
      type: "PURCHASE",
      periodMonth: 9,
      periodYear: 2026,
      clientId: client.id,
      status: "PENDING_REVIEW",
      invoiceNumber: `F-${n}`,
      invoiceDate: new Date("2026-09-10"),
      issuerName: "Proveedor SL",
      issuerCif: "B12345674",
      taxBase: 100,
      vatRate: 21,
      vatAmount: 21,
      totalAmount: 121,
      ...overrides,
    },
  });
}

export async function makeFirm(tag: string): Promise<FirmWorld> {
  const firm = await prisma.advisoryFirm.create({ data: { name: `Asesoría ${tag}`, cif: fakeCif("A") } });
  const admin = await makeUser(firm.id, "ADMIN", `admin${tag.toLowerCase()}`);
  const worker = await makeUser(firm.id, "WORKER", `gestor${tag.toLowerCase()}`);
  const clientUser = await makeUser(null, "CLIENT", `cliente${tag.toLowerCase()}`);
  const client = await prisma.client.create({
    data: {
      name: `Cliente ${tag} SL`,
      cif: fakeCif("B"),
      email: `contacto-${tag.toLowerCase()}${next()}@pruebas.es`,
      advisoryFirmId: firm.id,
      userId: clientUser.id,
    },
  });
  await prisma.workerClientAssignment.create({ data: { workerId: worker.id, clientId: client.id } });
  const pending = await makeInvoice(client, { status: "PENDING_REVIEW" });
  const validated = await makeInvoice(client, { status: "VALIDATED" });
  return {
    tag,
    firm: { id: firm.id, name: firm.name },
    admin,
    worker,
    clientUser,
    client: { id: client.id, name: client.name, cif: client.cif, advisoryFirmId: firm.id },
    invoices: { pending, validated },
  };
}

export async function makeTwoFirms() {
  return { a: await makeFirm("A"), b: await makeFirm("B") };
}
