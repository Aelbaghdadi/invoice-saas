/**
 * Lo que comparten la ficha del administrador y la del gestor: el cliente,
 * sus cifras, sus periodos, sus gestores y sus grupos. Quien llama ya ha
 * comprobado el acceso (misma asesoria o asignacion).
 */
import { prisma } from "@/lib/prisma";
import { buildPeriodRows, clientStatsFrom, type ClientStats, type PeriodRow } from "@/lib/clientSheet";

export type ClientSheetClient = {
  id: string;
  name: string;
  cif: string;
  email: string | null;
  accountingProgram: string | null;
  equivalenceSurchargeCustomer: boolean;
  simplifiedSupplierAccount: string | null;
  simplifiedExpenseAccount: string | null;
  contactName: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: Date;
  advisoryFirmId: string;
};

export type ClientSheetData = {
  client: ClientSheetClient;
  stats: ClientStats;
  periods: PeriodRow[];
  workers: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  learnedProviders: number;
};

export async function loadClientSheet(clientId: string): Promise<ClientSheetData | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true, name: true, cif: true, email: true, accountingProgram: true,
      equivalenceSurchargeCustomer: true, simplifiedSupplierAccount: true, simplifiedExpenseAccount: true,
      contactName: true, phone: true, notes: true, createdAt: true, advisoryFirmId: true, isUnclassifiedBucket: true,
      assignedWorkers: { select: { worker: { select: { id: true, name: true } } }, orderBy: { worker: { name: "asc" } } },
      groupMemberships: { select: { group: { select: { id: true, name: true } } } },
    },
  });
  // El buzon «Sin clasificar» no tiene ficha.
  if (!client || client.isUnclassifiedBucket) return null;

  const [statusRows, exported, readyToExport, periodCounts, periodExported, closures, learnedProviders] = await Promise.all([
    prisma.invoice.groupBy({ by: ["status"], where: { clientId }, _count: { _all: true } }),
    prisma.invoice.count({ where: { clientId, exportBatchItems: { some: {} } } }),
    prisma.invoice.count({ where: { clientId, status: "VALIDATED", exportBatchId: null } }),
    prisma.invoice.groupBy({
      by: ["periodType", "periodYear", "periodMonth", "type", "status"],
      where: { clientId },
      _count: { _all: true },
    }),
    prisma.invoice.groupBy({
      by: ["periodType", "periodYear", "periodMonth"],
      where: { clientId, exportBatchItems: { some: {} } },
      _count: { _all: true },
    }),
    prisma.periodClosure.findMany({
      where: { clientId },
      select: { month: true, year: true, closedAt: true, reopenedAt: true },
    }),
    prisma.providerRoutingRule.count({ where: { clientId, ambiguous: false } }),
  ]);

  const { assignedWorkers, groupMemberships, ...rest } = client;
  return {
    client: { ...rest, isUnclassifiedBucket: undefined } as ClientSheetClient,
    stats: clientStatsFrom(
      statusRows.map((r) => ({ status: r.status, count: r._count._all })),
      { exported, readyToExport },
    ),
    periods: buildPeriodRows({
      counts: periodCounts.map((r) => ({
        periodType: r.periodType, periodYear: r.periodYear, periodMonth: r.periodMonth,
        type: r.type, status: r.status, count: r._count._all,
      })),
      exported: periodExported.map((r) => ({
        periodType: r.periodType, periodYear: r.periodYear, periodMonth: r.periodMonth, count: r._count._all,
      })),
      closures,
    }),
    workers: assignedWorkers.map((a) => a.worker),
    groups: groupMemberships.map((m) => m.group),
    learnedProviders,
  };
}
