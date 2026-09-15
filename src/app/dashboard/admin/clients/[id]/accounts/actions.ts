"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import * as XLSX from "xlsx";
import { normalizePlanAccount } from "@/lib/accountingAccount";
import { accountEntryKey } from "@/lib/supplierMatching";
import { groupPlanRows } from "@/lib/accountPlanImport";

type ActionState = { success?: boolean; error?: string; imported?: number; errors?: string[] } | null;

// ─── Import from Excel ──────────────────────────────────────────────────────

export async function importAccountsFromExcel(
  clientId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };
  const firmId = session.user.advisoryFirmId ?? undefined;

  // Verify client belongs to firm
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.advisoryFirmId !== firmId) return { error: "Cliente no encontrado" };

  const file = formData.get("file") as File | null;
  if (!file) return { error: "No se ha seleccionado archivo" };
  if (file.size > 10 * 1024 * 1024) return { error: "El archivo supera 10MB" };

  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { error: "El archivo no contiene hojas de datos" };

  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // Formato A3: Cuenta | Descripcion | NIF, con la primera fila de cabecera.
  const { entries, errors } = groupPlanRows(rows);

  if (entries.length === 0) {
    // El primer motivo va como error principal y la lista lleva solo el resto:
    // antes el primero salia repetido en los dos sitios.
    const [primerError, ...restoErrores] = errors;
    return {
      error: primerError ?? "No se encontraron cuentas v\u00e1lidas en el archivo. Formato esperado: Cuenta | Descripci\u00f3n | NIF",
      errors: restoErrores.length > 0 ? restoErrores : undefined,
    };
  }

  // Upsert all entries
  let imported = 0;
  for (const entry of entries) {
    try {
      await prisma.accountEntry.upsert({
        where: { clientId_nif: { clientId, nif: entry.nif } },
        create: {
          clientId,
          nif: entry.nif,
          name: entry.name || entry.nif,
          supplierAccount: entry.supplierAccount,
          expenseAccount: entry.expenseAccount,
        },
        update: {
          name: entry.name || undefined,
          ...(entry.supplierAccount ? { supplierAccount: entry.supplierAccount } : {}),
          ...(entry.expenseAccount ? { expenseAccount: entry.expenseAccount } : {}),
        },
      });
      imported++;
    } catch (e) {
      errors.push(`NIF ${entry.nif}: ${e instanceof Error ? e.message : "Error desconocido"}`);
    }
  }

  return { success: true, imported, errors: errors.length > 0 ? errors : undefined };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

const accountSchema = z.object({
  // La clave canonica se calcula despues con accountEntryKey (necesita
  // tambien el nombre): asi alta manual, importador y revision usan
  // exactamente la misma.
  nif: z.string().trim().min(1, "NIF obligatorio"),
  name: z.string().min(1, "Nombre obligatorio"),
  supplierAccount: z.string().trim().min(1, "Cuenta proveedor obligatoria").transform(normalizePlanAccount),
  expenseAccount: z.string().trim().min(1, "Cuenta gasto obligatoria").transform(normalizePlanAccount),
  defaultVatRate: z.coerce.number().min(0).max(100).optional(),
});

export async function createAccountEntry(
  clientId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };
  const firmId = session.user.advisoryFirmId ?? undefined;

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.advisoryFirmId !== firmId) return { error: "Cliente no encontrado" };

  const parsed = accountSchema.safeParse({
    nif: formData.get("nif"),
    name: formData.get("name"),
    supplierAccount: formData.get("supplierAccount"),
    expenseAccount: formData.get("expenseAccount"),
    defaultVatRate: formData.get("defaultVatRate") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join(", ") };

  const nif = accountEntryKey(parsed.data.nif, parsed.data.name);
  if (!nif) return { error: "NIF no utilizable. Escribe un NIF con contenido o un nombre reconocible" };

  const existing = await prisma.accountEntry.findUnique({
    where: { clientId_nif: { clientId, nif } },
  });
  if (existing) return { error: `Ya existe una cuenta para el NIF ${nif}` };

  await prisma.accountEntry.create({
    data: {
      clientId,
      ...parsed.data,
      nif,
      defaultVatRate: parsed.data.defaultVatRate ?? null,
    },
  });

  return { success: true };
}

export async function updateAccountEntry(
  entryId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };
  const firmId = session.user.advisoryFirmId ?? undefined;

  const entry = await prisma.accountEntry.findUnique({
    where: { id: entryId },
    include: { client: true },
  });
  if (!entry || entry.client.advisoryFirmId !== firmId) return { error: "No encontrado" };

  const parsed = accountSchema.safeParse({
    nif: formData.get("nif"),
    name: formData.get("name"),
    supplierAccount: formData.get("supplierAccount"),
    expenseAccount: formData.get("expenseAccount"),
    defaultVatRate: formData.get("defaultVatRate") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join(", ") };

  // Misma clave que el importador y la revision. Una fila SINNIF: que se
  // edita conserva su clave: pasarla por parseTaxId la dejaba en "NNIF:..."
  // (lee "SI" como prefijo de Eslovenia) y dejaba de casar.
  const nif = accountEntryKey(parsed.data.nif, parsed.data.name);
  if (!nif) return { error: "NIF no utilizable. Escribe un NIF con contenido o un nombre reconocible" };

  // El NIF se normaliza, asi que puede acabar chocando con otra fila del
  // mismo cliente (p.ej. editar "PT515160873" cuando ya existe "515160873").
  // Sin esta comprobacion, Prisma lanzaria un P2002 crudo a la UI: las
  // server actions devuelven error, no lanzan.
  const colision = await prisma.accountEntry.findUnique({
    where: { clientId_nif: { clientId: entry.clientId, nif } },
  });
  if (colision && colision.id !== entryId) {
    return { error: `Ya existe otra cuenta con el NIF ${nif} en este cliente` };
  }

  await prisma.accountEntry.update({
    where: { id: entryId },
    data: {
      ...parsed.data,
      nif,
      defaultVatRate: parsed.data.defaultVatRate ?? null,
    },
  });

  return { success: true };
}

export async function deleteAccountEntry(entryId: string): Promise<ActionState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };
  const firmId = session.user.advisoryFirmId ?? undefined;

  const entry = await prisma.accountEntry.findUnique({
    where: { id: entryId },
    include: { client: true },
  });
  if (!entry || entry.client.advisoryFirmId !== firmId) return { error: "No encontrado" };

  await prisma.accountEntry.delete({ where: { id: entryId } });
  return { success: true };
}

// ─── Cuenta genérica para facturas simplificadas ──────────────────────────────

/**
 * Guarda la cuenta de proveedor (y opcionalmente de gasto) por defecto para
 * facturas simplificadas / tickets sin datos suficientes de este cliente. El
 * gestor la aplica luego manualmente desde revisión. Vacío = sin configurar.
 */
export async function updateSimplifiedAccounts(
  clientId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };
  const firmId = session.user.advisoryFirmId ?? undefined;

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.advisoryFirmId !== firmId) return { error: "Cliente no encontrado" };

  const supplier = ((formData.get("simplifiedSupplierAccount") as string) ?? "").trim();
  const expense = ((formData.get("simplifiedExpenseAccount") as string) ?? "").trim();

  await prisma.client.update({
    where: { id: clientId },
    data: {
      simplifiedSupplierAccount: supplier || null,
      simplifiedExpenseAccount: expense || null,
    },
  });

  return { success: true };
}

// ─── Recargo de Equivalencia ────────────────────────────────────────────────

/**
 * Marca/desmarca a este cliente como minorista acogido a Recargo de
 * Equivalencia. Con el flag activo, sus facturas de compra sugieren
 * automáticamente % y cuota de recargo (mapeo habitual según el IVA) al
 * procesarlas — nunca sin este flag, para no inventar recargo en clientes
 * que no están en ese régimen.
 */
export async function updateEquivalenceSurcharge(
  clientId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };
  const firmId = session.user.advisoryFirmId ?? undefined;

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.advisoryFirmId !== firmId) return { error: "Cliente no encontrado" };

  const enabled = formData.get("equivalenceSurchargeCustomer") === "on";

  await prisma.client.update({
    where: { id: clientId },
    data: { equivalenceSurchargeCustomer: enabled },
  });

  return { success: true };
}
