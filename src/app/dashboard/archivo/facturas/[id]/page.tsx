import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CalendarClock, ChevronLeft, Download, ExternalLink, FileText, Hash, History, Layers, MapPin } from "lucide-react";
import { auth } from "@/lib/auth";
import { Badge } from "@/components/ui/Badge";
import { InvoiceStatusBadge } from "@/components/ui/InvoiceStatusBadge";
import { AttachOriginalForm } from "@/components/archive/AttachOriginalForm";
import { MediumBadge } from "@/components/archive/MediumBadge";
import { MediumSelect } from "@/components/archive/MediumSelect";
import { PlacePaperButton } from "@/components/archive/PlacePaperButton";
import { RetentionHoldForm } from "@/components/archive/RetentionHoldForm";
import { canAccessArchiveInvoice } from "@/lib/archiveAccess";
import { loadArchiveInvoice, type ArchiveInvoiceDetail } from "@/lib/archiveData";
import { invoiceOrderLabel, pageRangeLabel, tacoLabel } from "@/lib/paperLocation";
import { fiscalYearLabel, fiscalYearOf, RETENTION_MIN_YEARS } from "@/lib/archiveRules";
import { archiveTabHref, clientSheetPath } from "@/lib/clientSheet";
import { formatDateEs, formatDateTimeEs, formatDayEs } from "@/lib/dates";
import { formatEur } from "@/lib/format";
import { AUDIT_FIELD_LABELS, formatAuditValue } from "@/lib/invoiceStatuses";
import { MEDIUM_SOURCE_LABELS, RETENTION_HOLD_LABELS } from "@/lib/originalMedium";
import { reviewHref } from "@/lib/reviewNavigation";

type Props = { params: Promise<{ id: string }> };

const ANALYZING = ["UPLOADED", "ANALYZING"];

function Block({ title, icon: Icon, children }: { title: string; icon: typeof FileText; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold text-slate-800">
        <Icon className="h-4 w-4 text-slate-400" />
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

const buttonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50";

/** Extensión de un nombre de fichero, para el botón: «.docx». */
function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]{2,5})$/i.exec(filename);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/**
 * El bloque «Ubicación» (5.12): dónde está el papel y lo que se puede hacer
 * (ver el taco, sacar la factura de él o ponerle ubicación). Una rechazada
 * también: su papel sigue estando (B-R14 solo la salta en «a todas»). En el
 * buzón no: su cliente aún no es el de la factura.
 */
function LocationBlock({ detail, invoiceId }: { detail: ArchiveInvoiceDetail; invoiceId: string }) {
  const { row, client, wholeTacoRange, tacoPdfUrl } = detail;
  const { location, arrivalBatch } = row;
  const fiscalYear = detail.fiscalYear.startYear;
  const canPlace = !client.isUnclassifiedBucket;
  const inTaco = location.tacoId != null;
  const place = (label: string, target: { moveInvoiceId: string } | { invoiceIds: string[] }) =>
    canPlace ? <PlacePaperButton target={target} clientId={client.id} fiscalYear={fiscalYear} label={label} /> : null;

  return (
    <Block title="Ubicación" icon={MapPin}>
      {inTaco ? (
        <>
          <p className="text-[16px] font-bold leading-snug text-slate-900">{location.text}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <Link href={`/dashboard/archivo/tandas/${location.tacoId}`} className={buttonClass}>
              {location.tacoNumber != null ? `Ver el ${tacoLabel(location.tacoNumber)}` : "Ver el taco"}
            </Link>
            {place("Sacar del taco…", { moveInvoiceId: invoiceId })}
          </div>
        </>
      ) : location.kind === "electronic" ? (
        <p className="text-[13px] text-slate-600">Original electrónico: no hay papel que guardar.</p>
      ) : location.kind === "client" ? (
        <>
          <p className="text-[13px] text-slate-700">Lo guarda el cliente.</p>
          <div className="mt-2">{place("Poner ubicación…", { invoiceIds: [invoiceId] })}</div>
        </>
      ) : location.kind === "unconfirmed" ? (
        <>
          <p className="text-[13px] text-slate-700">Falta confirmar si hay papel. Si lo hay, pon dónde está.</p>
          <div className="mt-2">{place("Poner ubicación…", { invoiceIds: [invoiceId] })}</div>
        </>
      ) : (
        <>
          <p className="text-[13px] font-semibold text-amber-700">Sin ubicación.</p>
          <div className="mt-2">{place("Poner ubicación…", { invoiceIds: [invoiceId] })}</div>
        </>
      )}
      {wholeTacoRange && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-[13px] text-slate-600">
          <span>
            {wholeTacoRange.end > wholeTacoRange.start ? "Págs." : "Pág."} {pageRangeLabel(wholeTacoRange.start, wholeTacoRange.end)} del PDF del{" "}
            {tacoLabel(wholeTacoRange.tacoNumber)} ({invoiceOrderLabel(wholeTacoRange.order)} factura)
          </span>
          {tacoPdfUrl && (
            <a href={tacoPdfUrl} target="_blank" rel="noopener" className={buttonClass}>
              <ExternalLink className="h-4 w-4 text-slate-400" />
              Ver el PDF del taco entero
            </a>
          )}
        </div>
      )}
      {arrivalBatch && (
        <p className="mt-3 border-t border-slate-100 pt-3 text-[13px] text-slate-600">
          Llegó en la subida del {formatDayEs(arrivalBatch.createdAt)} ({arrivalBatch.fileCount.toLocaleString("es-ES")}{" "}
          {arrivalBatch.fileCount === 1 ? "fichero" : "ficheros"}).{" "}
          <Link href={`/dashboard/archivo/tandas/${arrivalBatch.id}`} className="font-medium text-blue-700 hover:underline">
            Ver la subida
          </Link>
        </p>
      )}
    </Block>
  );
}

/**
 * Ficha de archivo de una factura: el original a un clic, si es electrónico o
 * papel, el nº de registro, hasta cuándo se conserva y su historial en el
 * archivo. Comprueba el rol y el acceso ella misma (R22): sin acceso, 404.
 */
export default async function ArchiveInvoicePage({ params }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = session.user.role;
  if (role !== "ADMIN" && role !== "WORKER") redirect("/dashboard");
  const firmId = session.user.advisoryFirmId;
  if (!firmId) notFound();

  const { id } = await params;
  if (!(await canAccessArchiveInvoice(session, id))) notFound();
  const detail = await loadArchiveInvoice(id, firmId);
  if (!detail) notFound();

  const { row, client } = detail;
  const startMonth = client.fiscalYearStartMonth;
  const original = `/api/archive/invoices/${id}/original`;
  const thisPath = `/dashboard/archivo/facturas/${id}`;
  const back = client.isUnclassifiedBucket
    ? { href: "/dashboard/archivo", label: "Volver al archivo" }
    : { href: archiveTabHref(clientSheetPath(role, client.id), { fiscalYear: detail.fiscalYear.startYear }), label: `Volver al archivo de ${client.name}` };
  const analyzing = ANALYZING.includes(row.status);
  const inSplit = detail.splitRoot != null || row.split != null;
  // «Conservar hasta» es el cierre de un ejercicio más RETENTION_MIN_YEARS:
  // el ejercicio del que cuentan los años sale de la propia fecha.
  const retentionFrom = row.retainUntil
    ? fiscalYearLabel(
      fiscalYearOf(row.retainUntil.getUTCFullYear(), row.retainUntil.getUTCMonth() + 1, startMonth).startYear - RETENTION_MIN_YEARS,
      startMonth,
    )
    : null;

  return (
    <div className="mx-auto max-w-5xl">
      <Link href={back.href} className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" />
        {back.label}
      </Link>

      {/* Cabecera */}
      <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12px] text-slate-500">
              {client.isUnclassifiedBucket ? (
                <span className="font-medium text-slate-700">{client.name}</span>
              ) : (
                <Link href={clientSheetPath(role, client.id)} className="font-medium text-slate-700 hover:text-blue-700">{client.name}</Link>
              )}
              <span className="font-mono"> · {client.cif}</span>
              <span> · Ejercicio {detail.fiscalYear.label} · {row.periodLabel}</span>
            </p>
            <h1 className="mt-1 break-words text-[20px] font-bold tracking-tight text-slate-900">
              {row.invoiceNumber ?? detail.filename}
            </h1>
            <p className="mt-0.5 text-[13px] text-slate-600">
              {row.thirdPartyName ?? "Sin tercero"}
              {row.thirdPartyCif && <span className="font-mono text-slate-400"> · {row.thirdPartyCif}</span>}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
              <Badge variant={row.type === "PURCHASE" ? "blue" : "purple"}>{row.type === "PURCHASE" ? "Recibida" : "Emitida"}</Badge>
              <InvoiceStatusBadge status={row.status} />
              <span className="tabular-nums">Fecha {formatDateEs(row.invoiceDate)}</span>
              <span className="text-slate-300">·</span>
              <span className="font-semibold tabular-nums text-slate-700">{formatEur(row.totalAmount)}</span>
              <span className="text-slate-300">·</span>
              <span className="tabular-nums">{row.type === "SALE" ? "Subida el" : "Recibida el"} {formatDayEs(row.receivedAt)}</span>
            </div>
            {row.warnings.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {row.warnings.map((w) => (
                  <span
                    key={w.code}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      w.code === "split_part" ? "bg-slate-100 text-slate-600" : "border border-amber-200 bg-amber-50 text-amber-700"
                    }`}
                  >
                    {w.label}
                  </span>
                ))}
              </div>
            )}
            {row.status === "REJECTED" && row.rejectionReason && (
              <p className="mt-2 text-[12px] text-red-600">Rechazada: {row.rejectionReason}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={original}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-blue-700"
            >
              <ExternalLink className="h-4 w-4" />
              Ver el original
            </a>
            <Link href={reviewHref(id, { back: thisPath })} className={buttonClass}>Abrir en revisión</Link>
            {role === "ADMIN" && (
              <Link href={`/dashboard/admin/invoices/${id}`} className={buttonClass}>Ver la factura</Link>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Block title="Original" icon={FileText}>
          {detail.originalDocument ? (
            <>
              <p className="text-[13px] text-slate-600">
                El original es <span className="font-medium text-slate-800">{detail.originalDocument.filename}</span>
                {detail.originalDocument.fromSplitRoot ? ", de todo el documento dividido" : ""}. La app lee su copia en PDF.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <a href={original} className={buttonClass}>
                  <Download className="h-4 w-4 text-slate-400" />
                  Descargar el original ({extensionOf(detail.originalDocument.filename)})
                </a>
                <a href={`${original}?copia=1`} target="_blank" rel="noopener" className={buttonClass}>
                  <ExternalLink className="h-4 w-4 text-slate-400" />
                  Ver la copia en PDF
                </a>
              </div>
            </>
          ) : detail.splitRoot ? (
            <>
              <p className="text-[13px] text-slate-600">
                Es una parte de <span className="font-medium text-slate-800">{detail.splitRoot.filename}</span>, que se
                dividió en varias facturas: el original es el documento entero.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <a href={original} target="_blank" rel="noopener" className={buttonClass}>
                  <ExternalLink className="h-4 w-4 text-slate-400" />
                  Ver el documento entero
                </a>
                <a href={`${original}?copia=1`} target="_blank" rel="noopener" className={buttonClass}>
                  <Layers className="h-4 w-4 text-slate-400" />
                  Ver solo esta parte
                </a>
              </div>
            </>
          ) : (
            <>
              <p className="break-all text-[13px] text-slate-600">
                <span className="font-medium text-slate-800">{detail.filename}</span>
              </p>
              <div className="mt-3">
                <a href={original} target="_blank" rel="noopener" className={buttonClass}>
                  <ExternalLink className="h-4 w-4 text-slate-400" />
                  Ver el original
                </a>
              </div>
            </>
          )}
          <AttachOriginalForm
            invoiceId={id}
            current={detail.originalDocument ? { filename: detail.originalDocument.filename } : null}
            split={inSplit}
            disabled={analyzing}
          />
        </Block>

        <Block title="Electrónico o papel" icon={Layers}>
          <div className="flex flex-wrap items-center gap-2">
            <MediumBadge medium={row.medium} reason={row.mediumReasonLabel} />
            {row.mediumReasonLabel && <span className="text-[13px] text-slate-600">{row.mediumReasonLabel}</span>}
          </div>
          <p className="mt-1.5 text-[12px] text-slate-500">
            {row.mediumSource ? <>Origen: {MEDIUM_SOURCE_LABELS[row.mediumSource].toLowerCase()}.</> : "Aún sin decidir."}
            {detail.pdfProducer && <> PDF hecho con «{detail.pdfProducer}».</>}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <MediumSelect
              key={`${row.medium}-${row.mediumSource}`}
              id="archivo-medio"
              invoiceIds={[id]}
              medium={row.medium}
              source={row.mediumSource}
              disabled={analyzing}
            />
          </div>
          {analyzing ? (
            <p className="mt-2 text-[11px] text-slate-400">Se está analizando: cuando termine, podrás cambiarlo.</p>
          ) : inSplit ? (
            <p className="mt-2 text-[11px] text-slate-400">Es un documento dividido: cambiarlo cambia también el resto de sus partes.</p>
          ) : null}
        </Block>

        <LocationBlock detail={detail} invoiceId={id} />

        <Block title="Nº de registro" icon={Hash}>
          {row.registerNumber ? (
            <p>
              <span className="font-mono text-[20px] font-bold text-slate-900">{row.registerNumber}</span>
              {row.registeredAt && <span className="ml-2 text-[13px] text-slate-500">registrada el {formatDayEs(row.registeredAt)}</span>}
            </p>
          ) : (
            <p className="text-[13px] text-slate-600">Se pone al exportar a A3.</p>
          )}
          <p className="mt-1.5 text-[11px] text-slate-400">Nº del archivo, no el de A3.</p>
        </Block>

        <Block title="Conservar hasta" icon={CalendarClock}>
          {row.retainUntil ? (
            <p className="text-[13px] text-slate-600">
              <span className="text-[16px] font-bold tabular-nums text-slate-900">{formatDateEs(row.retainUntil)}</span>
              <span> · {RETENTION_MIN_YEARS} años desde el cierre del ejercicio {retentionFrom}</span>
            </p>
          ) : (
            <p className="text-[13px] text-slate-600">
              <span className="font-semibold text-slate-900">Sin fecha</span>: conservar más
              {row.retentionHoldReason && <> ({RETENTION_HOLD_LABELS[row.retentionHoldReason]})</>}
              {detail.retentionHoldNote && <span className="block text-[12px] text-slate-500">{detail.retentionHoldNote}</span>}
            </p>
          )}
          <div className="mt-4 border-t border-slate-100 pt-4">
            <RetentionHoldForm
              key={`${row.retentionHold}-${row.retentionHoldReason}-${detail.retentionHoldNote}`}
              invoiceIds={[id]}
              initial={{ hold: row.retentionHold, reason: row.retentionHoldReason, note: detail.retentionHoldNote }}
              suggested={detail.suggestedRetentionHold}
            />
          </div>
        </Block>
      </div>

      <div className="mt-5">
        <Block title="Historial del archivo" icon={History}>
          {detail.history.length === 0 ? (
            <p className="text-[13px] text-slate-500">Aún no hay cambios en el archivo de esta factura.</p>
          ) : (
            <ol className="divide-y divide-slate-100">
              {detail.history.map((h) => {
                const label = AUDIT_FIELD_LABELS[h.field] ?? h.field;
                const before = formatAuditValue(h.oldValue, h.field);
                const after = formatAuditValue(h.newValue, h.field);
                return (
                  <li key={h.id} className="flex flex-col gap-0.5 py-2.5 text-[13px] sm:flex-row sm:items-baseline sm:gap-3">
                    <span className="whitespace-nowrap text-[12px] tabular-nums text-slate-400">{formatDateTimeEs(h.createdAt)}</span>
                    <span className="min-w-0 flex-1 text-slate-700">
                      <span className="font-medium">{label}</span>:{" "}
                      {h.field === "originalMedium" && before === after ? <>confirmado «{after}»</> : <>{before} → {after}</>}
                    </span>
                    <span className="text-[12px] text-slate-500">{h.userName}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </Block>
      </div>
    </div>
  );
}
