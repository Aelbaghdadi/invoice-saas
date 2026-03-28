import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { processInvoice } from "@/lib/processInvoice";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (invoice.status !== "UPLOADED") {
    return NextResponse.json({ error: "Already processed" }, { status: 400 });
  }

  await processInvoice(id, session.user.id);

  const updated = await prisma.invoice.findUnique({ where: { id } });
  return NextResponse.json({ success: true, invoice: updated });
}
