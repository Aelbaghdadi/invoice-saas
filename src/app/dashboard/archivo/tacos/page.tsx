import { redirect } from "next/navigation";
import { Layers } from "lucide-react";
import { auth } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { ArchiveTabs } from "@/components/archive/ArchiveTabs";
import { TacoFilters } from "@/components/archive/TacoFilters";
import { TacoList } from "@/components/archive/TacoList";
import { tacoViewer } from "@/lib/archiveAccess";
import { listTacos } from "@/lib/tacoData";
import { parseTacoListParams, tacosHref, type TacoListParams } from "@/lib/tacoListParams";

type Props = { searchParams: Promise<TacoListParams> };

/**
 * La pestaña Tacos del archivo (5.6): los tacos de papel que ve (B-R20), con
 * su estado y su caja, y las subidas digitales recientes (para «Era papel:
 * crear taco»). La propia página comprueba el rol y el acceso.
 */
export default async function TacosPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = session.user.role;
  if (role !== "ADMIN" && role !== "WORKER") redirect("/dashboard");
  const viewer = await tacoViewer(session);
  if (!viewer) redirect("/dashboard");

  const query = parseTacoListParams(await searchParams);
  const list = await listTacos(viewer, {
    estado: query.estado,
    clientId: query.clientId ?? undefined,
    year: query.year ?? undefined,
    caja: query.caja || undefined,
    page: query.page,
  });
  const digital = query.estado === "digitales";
  const filtered = query.estado !== "todos" || query.clientId != null || query.year != null || !!query.caja;
  const empty = digital
    ? "No hay subidas digitales en los últimos 30 días."
    : filtered
      ? "No hay tacos con estos filtros."
      : "Todavía no hay tacos. Se crean al subir papel marcando «Es papel escaneado aquí».";

  return (
    <div>
      <PageHeader
        title="Archivo"
        description="Dónde está cada factura, si su original es electrónico o papel y hasta cuándo hay que conservarla."
      />
      <ArchiveTabs active="tacos" />
      <TacoFilters
        values={{ estado: query.estado, clientId: query.clientId, year: query.year, caja: query.caja }}
        clients={list.clients}
        years={list.years}
      />
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {list.rows.length === 0 ? (
          <EmptyState icon={Layers} title={digital ? "Sin subidas digitales" : "Sin tacos"} description={empty} />
        ) : (
          <>
            <TacoList rows={list.rows} digital={digital} />
            <Pagination
              window={list.window}
              noun={digital ? ["subida", "subidas"] : ["taco", "tacos"]}
              hrefFor={(page) => tacosHref({ ...query, page })}
            />
          </>
        )}
      </div>
    </div>
  );
}
