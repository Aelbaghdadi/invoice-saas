"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import * as XLSX from "xlsx";

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

  // Skip header row, parse data rows
  // Expected A3 format: Cuenta | Descripcion | NIF
  const entries = new Map<string, { nif: string; name: string; supplierAccount: string; expenseAccount: string }>();
  const errors: string[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const cuenta = String(row[0] ?? "").trim();
    const descripcion = String(row[1] ?? "").trim();
    const nif = String(row[2] ?? "").trim().replace(/\s/g, "");

    if (!cuenta || !nif) continue; // Skip empty rows

    // Determine account type by prefix
    const prefix = cuenta.split(".")[0] ?? cuenta.substring(0, 3);
    const prefixNum = parseInt(prefix, 10);

    const existing = entries.get(nif) ?? { nif, name: descripcion, supplierAccount: "", expenseAccount: "" };

    if (prefixNum >= 400 && prefixNum < 500) {
      // 4xx = cuenta proveedor/cliente
      existing.supplierAccount = cuenta;
    } else if ((prefixNum >= 600 && prefixNum < 700) || (prefixNum >= 700 && prefixNum < 800)) {
      // 6xx = gasto, 7xx = ingreso
      existing.expenseAccount = cuenta;
    } else {
      // Unknown prefix — try to assign intelligently
      if (!existing.supplierAccount) {
        existing.supplierAccount = cuenta;
      } else if (!existing.expenseAccount) {
        existing.expenseAccount = cuenta;
      }
    }

    if (!existing.name && descripcion) existing.name = descripcion;
    entries.set(nif, existing);
  }

  if (entries.size === 0) {
    return { error: "No se encontraron cuentas v\u00e1lidas en el archivo. Formato esperado: Cuenta | Descripci\u00f3n | NIF" };
  }

  // Upsert all entries
  let imported = 0;
  for (const entry of entries.values()) {
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
  nif: z.string().min(1, "NIF obligatorio"),
  name: z.string().min(1, "Nombre obligatorio"),
  supplierAccount: z.string().min(1, "Cuenta proveedor obligatoria"),
  expenseAccount: z.string().min(1, "Cuenta gasto obligatoria"),
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

  const existing = await prisma.accountEntry.findUnique({
    where: { clientId_nif: { clientId, nif: parsed.data.nif } },
  });
  if (existing) return { error: `Ya existe una cuenta para el NIF ${parsed.data.nif}` };

  await prisma.accountEntry.create({
    data: {
      clientId,
      ...parsed.data,
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

  await prisma.accountEntry.update({
    where: { id: entryId },
    data: {
      ...parsed.data,
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
