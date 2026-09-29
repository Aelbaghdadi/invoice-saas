import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendClosureReminder } from "@/lib/email";
import { verifyCronSecret } from "@/lib/cronAuth";

/**
 * Monthly cron: sends reminders to clients whose previous month is not yet closed.
 * Runs on the 5th of each month (configured in vercel.json).
 */
async function handle(req: Request) {
  if (!verifyCronSecret(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  // Remind about the previous month
  const targetMonth = now.getMonth() === 0 ? 12 : now.getMonth(); // previous month (1-12)
  const targetYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  // Find all clients (excluyendo el buzón técnico "Sin clasificar", cuyo
  // email es sintético y no debe recibir recordatorios, y los clientes sin
  // acceso al portal, que no tienen email al que avisar).
  const clients = await prisma.client.findMany({
    where: { isUnclassifiedBucket: false, email: { not: null } },
    select: { id: true, name: true, email: true },
  });

  let sent = 0;
  let failed = 0;

  for (const client of clients) {
    // Check if period is already closed
    const closure = await prisma.periodClosure.findUnique({
      where: {
        clientId_month_year: {
          clientId: client.id,
          month: targetMonth,
          year: targetYear,
        },
      },
    });

    // Skip if already closed (and not reopened). No se guarda si ya se
    // mando el recordatorio: cada ejecucion lo reenvia (una vez al mes).
    if (closure && !closure.reopenedAt) continue;

    const result = await sendClosureReminder({
      clientEmail: client.email!,
      clientName: client.name,
      month: targetMonth,
      year: targetYear,
    });

    // Solo cuenta lo que Resend acepto; el motivo de cada fallo ya esta en
    // el log de send.
    if (result.ok) sent++;
    else failed++;
  }

  return NextResponse.json({ sent, failed, month: targetMonth, year: targetYear });
}

// GET y POST con el mismo handler y la misma comprobacion del secreto: la
// Scheduled Task de Coolify (o un cron externo) puede llamar con cualquiera
// de los dos (F-007; antes un POST daba 405).
export const GET = handle;
export const POST = handle;
