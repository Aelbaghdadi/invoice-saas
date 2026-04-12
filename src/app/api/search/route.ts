import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ results: [] }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ results: [] });

  const role = session.user.role;

  type Result = {
    type: "client" | "invoice";
    id: string;
    title: string;
    subtitle: string;
    href: string;
  };

  const results: Result[] = [];

  // ── Get worker's assigned client IDs (if applicable) ─────────────────
  let workerClientIds: string[] | undefined;
  if (role === "WORKER") {
    const assignments = await prisma.workerClientAssignment.findMany({
      where: { workerId: session.user.id },
      select: { clientId: true },
    });
    workerClientIds = assignments.map((a) => a.clientId);
  }

  // ── Search clients ──────────────────────────────────────────────────────
  if (role === "ADMIN" || role === "WORKER") {
    const clients = await prisma.client.findMany({
      where: {
        ...(workerClientIds ? { id: { in: workerClientIds } } : {}),
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { cif:  { contains: q, mode: "insensitive" } },
        ],
      },
      take: 5,
      select: { id: true, name: true, cif: true },
    });

    for (const c of clients) {
      results.push({
        type: "client",
        id: c.id,
        title: c.name,
        subtitle: c.cif,
        href: role === "ADMIN"
          ? `/dashboard/admin/clients/${c.id}`
          : `/dashboard/worker/clients`,
      });
    }
  }

  // ── Search invoices ─────────────────────────────────────────────────────
  if (role === "ADMIN" || role === "WORKER") {
    const invoices = await prisma.invoice.findMany({
      where: {
        ...(workerClientIds ? { clientId: { in: workerClientIds } } : {}),
        OR: [
          { filename:      { contains: q, mode: "insensitive" } },
          { invoiceNumber: { contains: q, mode: "insensitive" } },
          { issuerName:    { contains: q, mode: "insensitive" } },
          { issuerCif:     { contains: q, mode: "insensitive" } },
        ],
      },
      take: 5,
      include: { client: { select: { name: true } } },
    });

    for (const inv of invoices) {
      results.push({
        type: "invoice",
        id: inv.id,
        title: inv.invoiceNumber ?? inv.filename,
        subtitle: `${inv.client.name} — ${inv.status}`,
        href: role === "ADMIN"
          ? `/dashboard/admin/invoices/${inv.id}`
          : `/dashboard/worker/review/${inv.id}`,
      });
    }
  }

  // Clients can only search their own invoices
  if (role === "CLIENT") {
    const client = await prisma.client.findUnique({
      where: { userId: session.user.id },
    });

    if (client) {
      const invoices = await prisma.invoice.findMany({
        where: {
          clientId: client.id,
          OR: [
            { filename:      { contains: q, mode: "insensitive" } },
            { invoiceNumber: { contains: q, mode: "insensitive" } },
          ],
        },
        take: 5,
      });

      for (const inv of invoices) {
        results.push({
          type: "invoice",
          id: inv.id,
          title: inv.invoiceNumber ?? inv.filename,
          subtitle: inv.status,
          href: `/dashboard/client/invoices`,
        });
      }
    }
  }

  return NextResponse.json({ results });
}
