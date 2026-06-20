import { prisma } from "@/lib/prisma";
import { appError, type AppError } from "@/lib/errorCodes";

type Session = { user: { id: string; role: string; advisoryFirmId?: string | null } };

/**
 * Valida que el usuario pueda subir facturas a este cliente.
 * - CLIENT: solo a su propio Client (el linked via userId).
 * - WORKER: solo a clientes asignados.
 * - ADMIN: solo a clientes de su asesoria.
 *
 * Devuelve el cliente cargado (id+name+advisoryFirmId) si OK, o un
 * AppError si no. Centraliza la validacion para no repetir la logica
 * entre el endpoint de sign y el de register (ver S-22).
 */
export async function assertUploadClientAccess(
  session: Session,
  clientId: string,
): Promise<{ ok: true; client: { id: string; name: string; advisoryFirmId: string } } | { ok: false; error: AppError }> {
  const role = session.user.role;
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, advisoryFirmId: true, userId: true },
  });
  if (!client) return { ok: false, error: appError("ERR-UPLOAD-005", `clientId=${clientId}`) };

  if (role === "CLIENT") {
    if (client.userId !== session.user.id) {
      return { ok: false, error: appError("ERR-UPLOAD-005", "client no propio") };
    }
  } else if (role === "WORKER") {
    const a = await prisma.workerClientAssignment.findUnique({
      where: { workerId_clientId: { workerId: session.user.id, clientId } },
    });
    if (!a) return { ok: false, error: appError("ERR-UPLOAD-005", "worker sin asignacion") };
    // Defensa multitenant: la asignacion por si sola no garantiza que el
    // cliente sea de la firma del gestor (dato corrupto / migracion). Lo
    // exigimos explicitamente, igual que en la rama ADMIN. Asi todo candidato
    // de routingCandidateIds queda acotado a la firma ya en el limite.
    if (!session.user.advisoryFirmId || client.advisoryFirmId !== session.user.advisoryFirmId) {
      return { ok: false, error: appError("ERR-UPLOAD-005", "cliente fuera de la firma del gestor") };
    }
  } else if (role === "ADMIN") {
    if (!session.user.advisoryFirmId || client.advisoryFirmId !== session.user.advisoryFirmId) {
      return { ok: false, error: appError("ERR-UPLOAD-005", "cliente fuera de la firma del admin") };
    }
  } else {
    return { ok: false, error: appError("ERR-UPLOAD-005", `rol=${role} no permitido`) };
  }

  return {
    ok: true,
    client: { id: client.id, name: client.name, advisoryFirmId: client.advisoryFirmId },
  };
}

/** El periodo del cliente para subir debe estar abierto. */
export async function assertUploadPeriodOpen(
  clientId: string,
  month: number,
  year: number,
): Promise<{ ok: true } | { ok: false; error: AppError }> {
  const closure = await prisma.periodClosure.findUnique({
    where: { clientId_month_year: { clientId, month, year } },
  });
  if (closure && !closure.reopenedAt) {
    return {
      ok: false,
      error: appError("ERR-UPLOAD-004", `${month}/${year} clientId=${clientId}`),
    };
  }
  return { ok: true };
}
