import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { ReviewForm } from "./ReviewForm";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role))
    redirect("/login");

  const { id } = await params;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { client: true },
  });
  if (!invoice) notFound();

  // Get all invoices in the same batch (same client + period), ordered by createdAt
  const batchInvoices = await prisma.invoice.findMany({
    where: {
      clientId:    invoice.clientId,
      periodMonth: invoice.periodMonth,
      periodYear:  invoice.periodYear,
      status:      { in: ["UPLOADED", "ANALYZING", "VALIDATED"] },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const idx     = batchInvoices.findIndex((i) => i.id === id);
  const prevId  = idx > 0 ? batchInvoices[idx - 1].id : null;
  const nextId  = idx < batchInvoices.length - 1 ? batchInvoices[idx + 1].id : null;
  const position = idx + 1;
  const total    = batchInvoices.length;

  const backHref =
    session.user.role === "ADMIN"
      ? `/dashboard/admin/invoices`
      : `/dashboard/worker/invoices`;

  return (
    <div className="-m-6 flex h-[calc(100vh-64px)] flex-col overflow-hidden">
      <ReviewForm
        invoice={invoice}
        prevId={prevId}
        nextId={nextId}
        position={position}
        batchTotal={total}
        backHref={backHref}
      />
    </div>
  );
}
