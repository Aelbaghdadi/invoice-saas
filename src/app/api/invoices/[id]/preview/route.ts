import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createServerSupabase } from "@/lib/supabase";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Authorization: verify user has access to this invoice's client
  if (session.user.role === "WORKER") {
    const assignment = await prisma.workerClientAssignment.findUnique({
      where: {
        workerId_clientId: {
          workerId: session.user.id,
          clientId: invoice.clientId,
        },
      },
    });
    if (!assignment) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  } else if (session.user.role === "CLIENT") {
    const client = await prisma.client.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!client || client.id !== invoice.clientId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
  } else if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const supabase = createServerSupabase();
  if (!supabase) return NextResponse.json({ error: "Storage not configured" }, { status: 500 });

  const { data, error } = await supabase.storage
    .from("invoices")
    .createSignedUrl(invoice.storageKey, 600); // 10 min TTL

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ url: data.signedUrl, fileType: invoice.fileType });
}
