import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  AlertTriangle, CheckCircle2, Clock, Zap, Lock, ArrowRight,
  Layers, PenLine,
} from "lucide-react";
import Link from "next/link";
import type { PeriodType } from "@prisma/client";
import { DONE_WORK, PENDING_WORK, PERIOD_BLOCKING_STATUSES } from "@/lib/invoiceStatuses";
import { periodLabel } from "@/lib/period";
import { QUEUE_ORDER } from "@/lib/reviewQueue";
import { reviewHref } from "@/lib/reviewNavigation";
import { startOfTodayInMadrid } from "@/lib/dates";

/**
 * Mesa de trabajo del gestor.
 *
 * Al entrar, tiene que ver en 3 segundos:
 *  1. Que requiere accion (incidencias).
 *  2. Donde hay trabajo rapido (clean buckets grandes).
 *  3. Que periodos estan listos para cerrar.
 *
 * Cada tarjeta lleva un CTA directo a la cola correcta con el bucket
 * adecuado, para que empezar a trabajar sea un solo click.
 */

type BatchRow = {
  clientId: string;
  clientName: string;
  periodType: PeriodType;
  periodMonth: number;
  periodYear: number;
  type: "PURCHASE" | "SALE";
  attentionCount: number;
  cleanCount: number;
  total: number;
  done: number;
  firstAttentionId: string | null;
  firstCleanId: string | null;
};

export default async function WorkerDashboard() {
  const session = await auth();
  if (!session?.user) return null;

  const assignments = await prisma.workerClientAssignment
    .findMany({
      where: { workerId: session.user.id },
      select: { clientId: true, client: { select: { id: true, name: true } } },
    })
    .catch(() => []);

  const clientIds = assignments.map((a) => a.clientId);

  // Cargamos de una vez las facturas relevantes + issues abiertas.
  const invoices = clientIds.length
    ? await prisma.invoice.findMany({
        // El buzon "Sin clasificar" no es un cliente: si el gestor lo tiene
        // asignado, saldria como periodo listo para cerrar.
        where: { clientId: { in: clientIds }, client: { isUnclassifiedBucket: false } },
        include: {
          client: { select: { id: true, name: true } },
          issues: { where: { status: "OPEN" }, select: { id: true } },
        },
        // Dentro de cada lote, el orden de la cola: la primera que se abre
        // es la 1 de la revision, no una pospuesta.
        orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, ...QUEUE_ORDER],
      })
    : [];

  // Agrupar por lote (cliente + periodo + tipo) para tarjetas accionables.
  const batchMap = new Map<string, BatchRow>();
  for (const inv of invoices) {
    // La original de una division no es una factura mas (sus hijas ya
    // cuentan): dejaba el lote en "4/5" y el periodo pendiente para siempre.
    if (inv.status === "SPLIT_SOURCE") continue;
    const key = `${inv.clientId}-${inv.periodYear}-${inv.periodMonth}-${inv.periodType}-${inv.type}`;
    let b = batchMap.get(key);
    if (!b) {
      b = {
        clientId: inv.clientId,
        clientName: inv.client.name,
        periodType: inv.periodType,
        periodMonth: inv.periodMonth,
        periodYear: inv.periodYear,
        type: inv.type as "PURCHASE" | "SALE",
        attentionCount: 0,
        cleanCount: 0,
        total: 0,
        done: 0,
        firstAttentionId: null,
        firstCleanId: null,
      };
      batchMap.set(key, b);
    }
    b.total++;
    const hasIssue = inv.issues.length > 0;
    if (DONE_WORK.includes(inv.status)) {
      b.done++;
    } else if (["NEEDS_ATTENTION", "OCR_ERROR"].includes(inv.status)) {
      b.attentionCount++;
      if (!b.firstAttentionId) b.firstAttentionId = inv.id;
    } else if (inv.status === "PENDING_REVIEW") {
      if (hasIssue) {
        b.attentionCount++;
        if (!b.firstAttentionId) b.firstAttentionId = inv.id;
      } else {
        b.cleanCount++;
        if (!b.firstCleanId) b.firstCleanId = inv.id;
      }
    }
    // UPLOADED/ANALYZING: procesandose, no accionable.
  }
  const batches = Array.from(batchMap.values());

  // KPIs de cabecera.
  const attentionTotal = batches.reduce((a, b) => a + b.attentionCount, 0);
  const cleanTotal = batches.reduce((a, b) => a + b.cleanCount, 0);
  // Del historial de estados y no de updatedAt: exportar tambien toca
  // updatedAt, y el dia que el admin exportaba salian cientos "validadas hoy".
  const validatedToday = clientIds.length
    ? (
        await prisma.invoiceStatusHistory.findMany({
          where: {
            toStatus: "VALIDATED",
            changedBy: session.user.id,
            createdAt: { gte: startOfTodayInMadrid() },
            invoice: { clientId: { in: clientIds } },
          },
          distinct: ["invoiceId"],
          select: { invoiceId: true },
        })
      ).length
    : 0;
  const pendingTotal = invoices.filter((i) => PENDING_WORK.includes(i.status)).length;

  // Cierres: periodos listos para cerrar (todo done y no cerrados).
  const pendingByPeriod = new Map<string, number>();
  const totalByPeriod = new Map<string, { clientId: string; clientName: string; periodType: PeriodType; month: number; year: number; done: number; total: number }>();
  for (const inv of invoices) {
    if (inv.status === "SPLIT_SOURCE") continue;
    const key = `${inv.clientId}-${inv.periodYear}-${inv.periodMonth}`;
    let acc = totalByPeriod.get(key);
    if (!acc) {
      acc = {
        clientId: inv.clientId,
        clientName: inv.client.name,
        periodType: inv.periodType,
        month: inv.periodMonth,
        year: inv.periodYear,
        done: 0,
        total: 0,
      };
      totalByPeriod.set(key, acc);
    }
    // El cierre va por cliente + mes + año: si en ese mes conviven lotes
    // mensuales y trimestrales, se nombra por el mes.
    if (acc.periodType !== inv.periodType) acc.periodType = "MONTHLY";
    acc.total++;
    // Mismo criterio que la accion de cerrar periodo y la pantalla de lotes.
    const pending = PERIOD_BLOCKING_STATUSES.includes(inv.status);
    if (!pending) acc.done++;
    if (pending) pendingByPeriod.set(key, (pendingByPeriod.get(key) ?? 0) + 1);
  }
  const readyKeys = Array.from(totalByPeriod.entries())
    .filter(([k, v]) => v.total > 0 && (pendingByPeriod.get(k) ?? 0) === 0)
    .map(([, v]) => v);

  const closedRows = readyKeys.length
    ? await prisma.periodClosure.findMany({
        where: {
          OR: readyKeys.map((r) => ({ clientId: r.clientId, month: r.month, year: r.year })),
          reopenedAt: null,
        },
        select: { clientId: true, month: true, year: true },
      })
    : [];
  const closedSet = new Set(closedRows.map((c) => `${c.clientId}-${c.year}-${c.month}`));
  const readyToClose = readyKeys.filter(
    (r) => !closedSet.has(`${r.clientId}-${r.year}-${r.month}`),
  );

  // Prioridad: incidencias primero (descendente), luego clean, luego fecha.
  batches.sort((a, b) => {
    if (a.attentionCount !== b.attentionCount) return b.attentionCount - a.attentionCount;
    if (a.cleanCount !== b.cleanCount) return b.cleanCount - a.cleanCount;
    return `${b.periodYear}-${b.periodMonth}`.localeCompare(`${a.periodYear}-${a.periodMonth}`);
  });

  const attentionBatches = batches.filter((b) => b.attentionCount > 0).slice(0, 4);
  const cleanBatches = batches.filter((b) => b.cleanCount > 0 && b.attentionCount === 0).slice(0, 4);

  const stats = [
    {
      label: "Con incidencias",
      value: attentionTotal,
      icon: AlertTriangle,
      color: "text-amber-600",
      bg: "bg-amber-50",
    },
    {
      label: "Listas para validar",
      value: cleanTotal,
      icon: Zap,
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    {
      label: "Pendientes totales",
      value: pendingTotal,
      icon: Clock,
      color: "text-slate-600",
      bg: "bg-slate-50",
    },
    {
      label: "Validadas hoy por ti",
      value: validatedToday,
      icon: CheckCircle2,
      color: "text-green-600",
      bg: "bg-green-50",
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[22px] font-bold text-slate-900">
          Hola, {session.user.name?.split(" ")[0] ?? "gestor"}
        </h1>
        <p className="mt-0.5 text-[13px] text-slate-500">
          {attentionTotal > 0
            ? `${attentionTotal} factura${attentionTotal !== 1 ? "s" : ""} requiere${attentionTotal !== 1 ? "n" : ""} tu atención.`
            : cleanTotal > 0
              ? `${cleanTotal} factura${cleanTotal !== 1 ? "s" : ""} lista${cleanTotal !== 1 ? "s" : ""} para validar.`
              : "No hay trabajo pendiente. Buen momento para un café."}
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4">
        {stats.map(({ label, value, icon: Icon, color, bg }) => (
          <div
            key={label}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg ${bg}`}>
              <Icon className={`h-4 w-4 ${color}`} />
            </div>
            <p className="text-2xl font-bold text-slate-900">{value}</p>
            <p className="mt-0.5 text-[12px] text-slate-500">{label}</p>
          </div>
        ))}
      </div>

      {/* Bloque 1: incidencias */}
      {attentionBatches.length > 0 && (
        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-slate-800">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Lo primero: resolver incidencias
            </h2>
            <Link
              href="/dashboard/worker/invoices?bucket=attention"
              className="flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700"
            >
              Ver todas <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {attentionBatches.map((b) => (
              <BatchCard
                key={`att-${b.clientId}-${b.periodYear}-${b.periodMonth}-${b.periodType}-${b.type}`}
                row={b}
                kind="attention"
              />
            ))}
          </div>
        </section>
      )}

      {/* Bloque 2: validaciones rapidas */}
      {cleanBatches.length > 0 && (
        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-slate-800">
              <Zap className="h-4 w-4 text-blue-600" />
              Trabajo rápido: validaciones listas
            </h2>
            <Link
              href="/dashboard/worker/invoices?bucket=clean"
              className="flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700"
            >
              Ver todas <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {cleanBatches.map((b) => (
              <BatchCard
                key={`cle-${b.clientId}-${b.periodYear}-${b.periodMonth}-${b.periodType}-${b.type}`}
                row={b}
                kind="clean"
              />
            ))}
          </div>
        </section>
      )}

      {/* Bloque 3: periodos listos para cerrar */}
      {readyToClose.length > 0 && (
        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-slate-800">
              <Lock className="h-4 w-4 text-emerald-600" />
              Periodos listos para cerrar
            </h2>
            {/* Lotes abre por defecto en "Pendientes", que esconde justo
                los completos: sin el estado, el periodo no aparecia. */}
            <Link
              href="/dashboard/worker/batch?estado=por_cerrar"
              className="flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700"
            >
              Ir a lotes <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
            <ul className="divide-y divide-emerald-100">
              {readyToClose.slice(0, 5).map((r) => (
                <li
                  key={`close-${r.clientId}-${r.year}-${r.month}`}
                  className="flex items-center justify-between py-2"
                >
                  <div className="text-[13px]">
                    <span className="font-medium text-slate-800">{r.clientName}</span>
                    <span className="ml-2 text-slate-500">
                      {periodLabel(r.periodType, r.month, r.year)}
                    </span>
                  </div>
                  <Link
                    href={`/dashboard/worker/batch?clientId=${r.clientId}&year=${r.year}&month=${r.month}&estado=por_cerrar`}
                    className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 border border-emerald-200"
                  >
                    <Lock className="h-3 w-3" />
                    Ir a cerrar
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Estado vacio: nada que hacer */}
      {attentionBatches.length === 0 &&
        cleanBatches.length === 0 &&
        readyToClose.length === 0 && (
          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-10 text-center shadow-sm">
            <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-green-400" />
            <p className="text-[14px] font-semibold text-slate-700">Todo al día</p>
            <p className="mt-1 text-[13px] text-slate-500">
              No hay facturas pendientes ni incidencias. Vuelve cuando lleguen subidas nuevas.
            </p>
            <Link
              href="/dashboard/worker/batch"
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50"
            >
              <Layers className="h-3.5 w-3.5" />
              Ver lotes
            </Link>
          </div>
        )}
    </div>
  );
}

/** Tarjeta compacta de un lote accionable: CTA directo a su cola. */
function BatchCard({
  row,
  kind,
}: {
  row: BatchRow;
  kind: "attention" | "clean";
}) {
  const count = kind === "attention" ? row.attentionCount : row.cleanCount;
  const firstId = kind === "attention" ? row.firstAttentionId : row.firstCleanId;
  const tone =
    kind === "attention"
      ? "border-amber-200 bg-amber-50/30"
      : "border-blue-200 bg-blue-50/30";
  const btnClass =
    kind === "attention"
      ? "bg-amber-500 hover:bg-amber-600 text-white"
      : "bg-blue-600 hover:bg-blue-700 text-white";
  const Icon = kind === "attention" ? AlertTriangle : PenLine;

  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-slate-800 truncate">
            {row.clientName}
          </p>
          <p className="text-[11px] text-slate-500">
            {periodLabel(row.periodType, row.periodMonth, row.periodYear)}
            {" · "}
            {row.type === "PURCHASE" ? "Recibidas" : "Emitidas"}
          </p>
        </div>
        <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700">
          {row.done}/{row.total}
        </span>
      </div>
      {firstId && (
        <Link
          href={reviewHref(firstId, { bucket: kind, back: "/dashboard/worker" })}
          prefetch
          className={`mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-semibold ${btnClass}`}
        >
          <Icon className="h-3.5 w-3.5" />
          {kind === "attention"
            ? `Resolver ${count} incidencia${count !== 1 ? "s" : ""}`
            : `Validar ${count} factura${count !== 1 ? "s" : ""}`}
        </Link>
      )}
    </div>
  );
}
