/**
 * Quien es el que mira el soporte. La sesion no lleva el nombre de usuario,
 * y SUPPORT_USERNAMES va por nombre de usuario: una consulta por peticion.
 */
import { prisma } from "@/lib/prisma";
import { isSupportStaff, type SupportActor } from "@/lib/support";

type SessionUser = { id: string; role: string; advisoryFirmId?: string | null };

export async function supportActorFor(user: SessionUser): Promise<SupportActor> {
  const staff = parseStaffUsernamesConfigured()
    ? await prisma.user.findUnique({ where: { id: user.id }, select: { username: true } })
      .then((u) => isSupportStaff(u?.username))
      .catch(() => false)
    : false;
  return { id: user.id, role: user.role, advisoryFirmId: user.advisoryFirmId ?? null, staff };
}

/** Sin la variable no hace falta ir a la base de datos. */
function parseStaffUsernamesConfigured(): boolean {
  return (process.env.SUPPORT_USERNAMES ?? "").trim().length > 0;
}
