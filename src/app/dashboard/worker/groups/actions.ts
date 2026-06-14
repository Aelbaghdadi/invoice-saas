"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccessClient } from "@/lib/accessibleClients";
import { revalidatePath } from "next/cache";

export type GroupState = { ok?: boolean; error?: string } | null;

/** Valida que el gestor pueda manejar TODOS los clientes indicados (de su
 *  firma / asignados). Devuelve error si alguno no es accesible. */
async function assertClientsAccessible(
  session: { user: { id: string; role: string; advisoryFirmId?: string | null } },
  clientIds: string[],
): Promise<string | null> {
  for (const cid of clientIds) {
    if (!(await canAccessClient(session, cid))) return "Alguna empresa no es accesible";
  }
  // El cliente técnico "Sin clasificar" no puede ser miembro de un grupo.
  const buckets = await prisma.client.count({
    where: { id: { in: clientIds }, isUnclassifiedBucket: true },
  });
  if (buckets > 0) return "Empresa no válida";
  return null;
}

export async function createGroup(name: string, clientIds: string[]): Promise<GroupState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role) || !session.user.advisoryFirmId) {
    return { error: "No autorizado" };
  }
  const clean = name.trim();
  if (!clean) return { error: "El grupo necesita un nombre" };
  const ids = [...new Set(clientIds)];
  if (ids.length < 2) return { error: "Selecciona al menos 2 empresas" };
  const accErr = await assertClientsAccessible(session, ids);
  if (accErr) return { error: accErr };

  await prisma.clientGroup.create({
    data: {
      name: clean,
      advisoryFirmId: session.user.advisoryFirmId,
      members: { create: ids.map((clientId) => ({ clientId })) },
    },
  });
  revalidatePath("/dashboard/worker/groups");
  return { ok: true };
}

export async function updateGroup(groupId: string, name: string, clientIds: string[]): Promise<GroupState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role) || !session.user.advisoryFirmId) {
    return { error: "No autorizado" };
  }
  const group = await prisma.clientGroup.findUnique({ where: { id: groupId }, select: { advisoryFirmId: true } });
  if (!group || group.advisoryFirmId !== session.user.advisoryFirmId) return { error: "Grupo no encontrado" };

  const clean = name.trim();
  if (!clean) return { error: "El grupo necesita un nombre" };
  const ids = [...new Set(clientIds)];
  if (ids.length < 2) return { error: "Selecciona al menos 2 empresas" };
  const accErr = await assertClientsAccessible(session, ids);
  if (accErr) return { error: accErr };

  // Reemplazar miembros (borrar y recrear) + renombrar, en transacción.
  await prisma.$transaction([
    prisma.clientGroupMember.deleteMany({ where: { groupId } }),
    prisma.clientGroup.update({
      where: { id: groupId },
      data: { name: clean, members: { create: ids.map((clientId) => ({ clientId })) } },
    }),
  ]);
  revalidatePath("/dashboard/worker/groups");
  return { ok: true };
}

export async function deleteGroup(groupId: string): Promise<GroupState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role) || !session.user.advisoryFirmId) {
    return { error: "No autorizado" };
  }
  const group = await prisma.clientGroup.findUnique({ where: { id: groupId }, select: { advisoryFirmId: true } });
  if (!group || group.advisoryFirmId !== session.user.advisoryFirmId) return { error: "Grupo no encontrado" };

  await prisma.clientGroup.delete({ where: { id: groupId } }); // cascade borra miembros
  revalidatePath("/dashboard/worker/groups");
  return { ok: true };
}
