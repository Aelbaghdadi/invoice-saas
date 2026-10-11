"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isValidNIF, formatNIF } from "@/lib/validators";
import { duplicateFieldMessage } from "@/lib/clientDuplicateMessage";

export type EditClientState = { success?: boolean; error?: string; errors?: Record<string, string[]> } | null;

const schema = z.object({
  name: z.string().trim().min(2, "Mínimo 2 caracteres").max(160, "Máximo 160 caracteres"),
  cif: z.string().trim().min(9, "El CIF debe tener 9 caracteres").max(9, "El CIF debe tener 9 caracteres")
    .transform(formatNIF)
    .refine(isValidNIF, "CIF/NIF inválido — comprueba el formato y la letra de control"),
  accountingProgram: z.string().trim().max(60, "Máximo 60 caracteres"),
  contactName: z.string().trim().max(120, "Máximo 120 caracteres"),
  phone: z.string().trim().max(40, "Máximo 40 caracteres").regex(/^[+0-9 ().\-/]*$/, "Solo números, espacios y + ( ) . -"),
  notes: z.string().max(5000, "Máximo 5.000 caracteres"),
});

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : "";
}

/**
 * Edita la ficha del cliente (F-046, la parte que no es el acceso al portal):
 * razon social, CIF, software, contacto, telefono y notas internas. El CIF es
 * unico en toda la plataforma: si choca, se dice cual es el campo.
 */
export async function updateClient(clientId: string, _prev: EditClientState, formData: FormData): Promise<EditClientState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };
  const firmId = session.user.advisoryFirmId;
  if (!firmId) return { error: "No autorizado" };

  const parsed = schema.safeParse({
    name: field(formData, "name"),
    cif: field(formData, "cif"),
    accountingProgram: field(formData, "accountingProgram"),
    contactName: field(formData, "contactName"),
    phone: field(formData, "phone"),
    notes: field(formData, "notes"),
  });
  if (!parsed.success) return { errors: parsed.error.flatten().fieldErrors as Record<string, string[]> };

  // Solo un cliente real de esta asesoria: el buzon «Sin clasificar» no se edita.
  const client = await prisma.client.findFirst({
    where: { id: clientId, advisoryFirmId: firmId, isUnclassifiedBucket: false },
    select: { id: true },
  });
  if (!client) return { error: "Cliente no encontrado" };

  const d = parsed.data;
  try {
    await prisma.client.update({
      where: { id: clientId },
      data: {
        name: d.name,
        cif: d.cif.toUpperCase(),
        accountingProgram: d.accountingProgram || null,
        contactName: d.contactName || null,
        phone: d.phone || null,
        notes: d.notes.trim() || null,
      },
    });
  } catch (err) {
    return { error: duplicateFieldMessage(err) };
  }

  revalidatePath(`/dashboard/admin/clients/${clientId}`);
  revalidatePath(`/dashboard/worker/clients/${clientId}`);
  revalidatePath("/dashboard/admin/clients");
  revalidatePath("/dashboard/worker/clients");
  return { success: true };
}
