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
  const search = `%${q}%`;

  type Result = {
    type: "client" | "invoice";
    id: string;
    title: string;
    subtitle: string;
    href: string;
  };

  const results: Result[] = [];

  // ── Search clients ──────────────────────────────────────────────────────
  if (role === "ADMIN" || role === "WORKER") {
    const clients = await prisma.client.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { cif:  { contains: q, mode: "insensitive" } },
        ],
      },
      take: 5,
      select: { id: true, name: true, cif: true },
    });

    for (const c of clients) {
      const base = role === "ADMIN" ? "/dashboard/admin/clients" : "/dashboard/worker/clients";
      results.push({
        type: "client",
        id: c.id,
        title: c.name,
        subtitle: c.cif,
        href: `${base}/${c.id}`,
      });
    }
  }

  // ── Search invoices ─────────────────────────────────────────────────────
  if (role === "ADMIN" || role === "WORKER") {
    const invoices = await prisma.invoice.findMany({
      where: {
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
      const base = role === "ADMIN" ? "/dashboard/admin/invoices" : "/dashboard/worker/invoices";
      results.push({
        type: "invoice",
        id: inv.id,
        title: inv.invoiceNumber ?? inv.filename,
        subtitle: `${inv.client.name} — ${inv.status}`,
        href: `${base}/${inv.id}`,
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
