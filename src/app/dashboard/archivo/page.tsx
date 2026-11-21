import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import { ArchiveSearch } from "@/components/archive/ArchiveSearch";
import { ArchiveSummary } from "@/components/archive/ArchiveSummary";
import { archiveScope } from "@/lib/archiveAccess";
import { loadArchiveMetrics, searchArchive } from "@/lib/archiveData";
import { firstSearchParam, parseIntInRange } from "@/lib/listing";

type Props = { searchParams: Promise<{ q?: string | string[]; ejercicio?: string | string[] }> };

const BASE_PATH = "/dashboard/archivo";

/**
 * El archivo de facturas de la asesoría (o de los clientes del gestor): el
 * buscador «¿Dónde está?» y el resumen por cliente y ejercicio. La propia
 * página comprueba el rol: el proxy deja entrar en /dashboard a cualquiera.
 */
export default async function ArchivePage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = session.user.role;
  if (role !== "ADMIN" && role !== "WORKER") redirect("/dashboard");
  const scope = await archiveScope(session);
  if (!scope) redirect("/dashboard");

  const sp = await searchParams;
  const q = (firstSearchParam(sp.q) ?? "").trim().slice(0, 100);
  const selectedYear = parseIntInRange(firstSearchParam(sp.ejercicio), 2000, 2100) ?? null;
  const [metrics, results] = await Promise.all([
    loadArchiveMetrics(scope),
    q ? searchArchive(scope, q) : Promise.resolve(null),
  ]);

  const hrefForYear = (startYear: number) => {
    const params = new URLSearchParams({ ejercicio: String(startYear) });
    if (q) params.set("q", q);
    return `${BASE_PATH}?${params}`;
  };

  return (
    <div>
      <PageHeader
        title="Archivo"
        description="Dónde está cada factura, si su original es electrónico o papel y hasta cuándo hay que conservarla."
      />
      <ArchiveSearch
        basePath={BASE_PATH}
        role={role}
        query={q}
        results={results}
        keep={{ ejercicio: selectedYear != null ? String(selectedYear) : undefined }}
      />
      <ArchiveSummary metrics={metrics} role={role} selectedYear={selectedYear} hrefForYear={hrefForYear} />
    </div>
  );
}
