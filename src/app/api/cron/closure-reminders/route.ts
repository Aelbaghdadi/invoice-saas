import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendClosureReminder } from "@/lib/email";

/**
 * Monthly cron: sends reminders to clients whose previous month is not yet closed.
 * Runs on the 5th of each month (configured in vercel.json).
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  // Remind about the previous month
  const targetMonth = now.getMonth() === 0 ? 12 : now.getMonth(); // previous month (1-12)
  const targetYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  // Find all clients
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, email: true },
  });

  let sent = 0;

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

    // Skip if already closed (and not reopened), or reminder already sent
    if (closure && !closure.reopenedAt) continue;

    await sendClosureReminder({
      clientEmail: client.email,
      clientName: client.name,
      month: targetMonth,
      year: targetYear,
    });

    sent++;
  }

  return NextResponse.json({ sent, month: targetMonth, year: targetYear });
}
