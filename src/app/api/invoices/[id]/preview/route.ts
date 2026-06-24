import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canReadInvoice } from "@/lib/invoiceAccess";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { fileType: true, clientId: true, routingCandidateIds: true },
  });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!(await canReadInvoice(session.user, invoice))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Garage está en la red interna: en vez de una URL firmada del storage,
  // devolvemos una URL same-origin que sirve el binario por proxy (/raw, con el
  // mismo control de acceso). Así el navegador nunca habla con Garage.
  return NextResponse.json({ url: `/api/invoices/${id}/raw`, fileType: invoice.fileType });
}
