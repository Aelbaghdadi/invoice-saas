"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { PaperBoxMode, PaperScanMode } from "@prisma/client";
import { useToast } from "@/components/ui/Toast";
import { Select } from "@/components/ui/Select";
import {
  Upload,
  FileText,
  FileCode2,
  Image,
  X,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Layers,
  Loader2,
  CloudUpload,
  Copy,
  ArrowUp,
  ArrowDown,
  Replace,
} from "lucide-react";
import { MONTH_OPTIONS, periodLabel, quarterFromMonth, quarterStartMonth, QUARTER_OPTIONS, type PeriodTypeName } from "@/lib/period";
import { yearMonthInMadrid } from "@/lib/dates";
import {
  batchLabel,
  defaultUploadTarget,
  isPeriodClosed,
  matchingOpenBatches,
  openBatchCounts,
  overlappingOpenBatches,
  pickBatchLabel,
  samePeriod,
  uploadNotice,
  type BatchPeriod,
  type ClosedPeriod,
  type OpenBatch,
} from "@/lib/batchTarget";
import {
  OFFICE_FILES_NOTICE,
  pageOf,
  settingsLockReason,
  type UploadListItem,
  type UploadListMode,
} from "@/lib/uploadListState";
import { tacoLabel } from "@/lib/paperLocation";
import { useUploadBatch, type BatchOutcome } from "./useUploadBatch";
import { PaperUploadOptions } from "./PaperUploadOptions";
import { DigitalBatchLine, PaperBatchPanel, type TacoPanel } from "./PaperBatchPanel";

type UploadType = "PURCHASE" | "SALE" | "UNKNOWN";

/** El periodo del formulario. Mes y trimestre van a la par: al cambiar de
 *  mensual a trimestral se ve el trimestre del mes elegido, y al reves. */
type PeriodState = { periodType: PeriodTypeName; month: number; quarter: number; year: number };

function periodStateOf(period: BatchPeriod): PeriodState {
  return {
    periodType: period.periodType,
    month: period.periodMonth,
    quarter: quarterFromMonth(period.periodMonth),
    year: period.periodYear,
  };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("es-ES")} ${n === 1 ? one : many}`;

/** Lo que admite la zona de soltar en cada modo. */
const ACCEPT: Record<UploadListMode, string> = {
  digital: ".pdf,.xml,.jpg,.jpeg,.png,.webp,.heic",
  perInvoice: ".pdf,.jpg,.jpeg,.png,.webp,.heic",
  wholePdf: ".pdf,application/pdf",
};

const DROP_TEXT: Record<UploadListMode, { title: string; link: string; help: string }> = {
  digital: {
    title: "Arrastra aquí las facturas o",
    link: "selecciona archivos",
    help: "PDF, XML, JPG, PNG, WEBP o HEIC (fotos de iPhone) · Máximo 20 MB por archivo",
  },
  perInvoice: {
    title: "Arrastra aquí los escaneos o",
    link: "selecciona archivos",
    help: "PDF, JPG, PNG, WEBP o HEIC · Máximo 20 MB por archivo · Se ordenan por nombre",
  },
  wholePdf: {
    title: "Arrastra aquí el PDF del taco o",
    link: "selecciónalo",
    help: "Un solo PDF de hasta 20 MB y 500 páginas",
  },
};

type DigitalLine = { batchId: string; fileCount: number; uploaded: number };

type Props = {
  clients: { id: string; name: string; cif: string }[];
  groups: { id: string; name: string; clientIds: string[] }[];
  /** Lotes abiertos de estos clientes (loadOpenBatches). */
  openBatches: OpenBatch[];
  /** Agrupacion de la ultima subida de cada cliente. */
  lastPeriodTypes: Record<string, PeriodTypeName>;
  /** Periodos con cierre activo de cada cliente: ahi no se puede subir. */
  closedPeriods: Record<string, ClosedPeriod[]>;
  /** Hora del servidor: lo que se propone sale igual al pintar y al hidratar. */
  now: string;
  /** Ajustes del papel de la asesoría: lo que sale marcado al subir papel y,
   *  con las cajas por cliente, el aviso de un taco de varios clientes. */
  firmPaperScanMode: PaperScanMode;
  firmPaperBoxMode: PaperBoxMode;
};

export function WorkerUploadForm({
  clients,
  groups,
  openBatches,
  lastPeriodTypes,
  closedPeriods,
  now: nowIso,
  firmPaperScanMode,
  firmPaperBoxMode,
}: Props) {
  const { success, error: toastError, info, warning } = useToast();
  const router = useRouter();
  const now = new Date(nowIso);
  // El periodo que se propone para un cliente y un tipo: su lote abierto o,
  // sin el, el del mes anterior (defaultUploadTarget).
  const proposedPeriod = (forClientId: string, forType: UploadType) =>
    periodStateOf(defaultUploadTarget({
      openBatches: openBatches.filter((b) => b.clientId === forClientId),
      type: forType,
      lastPeriodType: lastPeriodTypes[forClientId] ?? null,
      closedPeriods: closedPeriods[forClientId] ?? [],
      now,
    }));
  // «Clasificar entre varios» no tiene un cliente: lo que se propone a uno
  // sin lotes ni subidas (mensual, el mes anterior), no lo del primero de la lista.
  const unassignedPeriod = () =>
    periodStateOf(defaultUploadTarget({ openBatches: [], type: "UNKNOWN", lastPeriodType: null, now }));
  const uploads = useUploadBatch();
  const { list } = uploads;
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  // Modo de subida: "single" = un cliente; "classify" = clasificar por CIF
  // entre varias empresas candidatas (grupo guardado o selección ad-hoc).
  const [mode, setMode] = useState<"single" | "classify">("single");
  // Tras subir entre varios: cuántas se están repartiendo. El reparto se hace
  // al leerlas, después de la subida; sin este aviso no se sabía dónde verlo.
  const [classifyNotice, setClassifyNotice] = useState<number | null>(null);
  const [candidateIds, setCandidateIds] = useState<Set<string>>(new Set());
  const [groupId, setGroupId] = useState("");
  const [type, setType] = useState<UploadType>("PURCHASE");
  const [period, setPeriod] = useState<PeriodState>(() => proposedPeriod(clients[0]?.id ?? "", "PURCHASE"));
  // Tocado a mano (o elegido un lote): cambiar el tipo ya no lo vuelve a
  // proponer. Cambiar de cliente si.
  const [periodTouched, setPeriodTouched] = useState(false);
  const [isPaper, setIsPaper] = useState(false);
  const [scanMode, setScanMode] = useState<PaperScanMode>(firmPaperScanMode);
  const [tacoPanels, setTacoPanels] = useState<TacoPanel[]>([]);
  const [digitalLines, setDigitalLines] = useState<DigitalLine[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isPending = uploads.pending;

  const listMode: UploadListMode = !isPaper ? "digital" : scanMode === "WHOLE_PDF" ? "wholePdf" : "perInvoice";
  // Con ficheros de una tanda empezada sin subir, el cliente, el lote, el tipo
  // y el papel no cambian: irían a otra tanda y el montón quedaría partido.
  const lockReason = settingsLockReason(list);
  const settingsLocked = isPending || lockReason != null;

  const { periodType, quarter } = period;
  const effectivePeriodMonth = periodType === "QUARTERLY" ? quarterStartMonth(quarter) : period.month;
  const selection = { periodType, periodMonth: effectivePeriodMonth, periodYear: period.year, type };
  const clientOpenBatches = mode === "single" ? openBatches.filter((b) => b.clientId === clientId) : [];
  const matching = matchingOpenBatches(clientOpenBatches, selection);
  // Con «Detectar automáticamente» puede haber uno de cada tipo en el mismo periodo: un aviso por periodo.
  const overlapping = overlappingOpenBatches(clientOpenBatches, selection)
    .filter((b, i, all) => all.findIndex((o) => samePeriod(o, b)) === i);
  // La subida lo rechazaria fichero a fichero (ERR-UPLOAD-004): se dice antes.
  const selectionClosed = mode === "single" && isPeriodClosed(closedPeriods[clientId] ?? [], selection);
  const notice = uploadNotice(selection, matching, selectionClosed);

  const thisYear = yearMonthInMadrid(now).year;
  const yearOptions = [...new Set([
    ...Array.from({ length: 5 }, (_, i) => thisYear - i),
    ...clientOpenBatches.map((b) => b.periodYear),
    period.year,
  ])]
    .sort((a, b) => b - a)
    .map((y) => ({ value: String(y), label: String(y) }));

  const chooseClient = (nextClientId: string) => {
    setClientId(nextClientId);
    setPeriod(proposedPeriod(nextClientId, type));
    setPeriodTouched(false);
    // La tarjeta del taco y la línea «¿Era papel?» son de la subida de antes.
    setTacoPanels([]);
    setDigitalLines([]);
  };

  const chooseType = (nextType: UploadType) => {
    setType(nextType);
    if (mode === "single" && !periodTouched) setPeriod(proposedPeriod(clientId, nextType));
  };

  const chooseMode = (nextMode: "single" | "classify") => {
    setMode(nextMode);
    // El taco entero es de un solo cliente.
    if (nextMode === "classify" && scanMode === "WHOLE_PDF") setScanMode("PER_INVOICE");
    if (periodTouched) return;
    setPeriod(nextMode === "single" ? proposedPeriod(clientId, type) : unassignedPeriod());
  };

  const changePeriod = (patch: Partial<PeriodState>) => {
    setPeriod((p) => ({ ...p, ...patch }));
    setPeriodTouched(true);
  };

  /** «Añadir a este lote»: su periodo y, con un tipo elegido, tambien el suyo
   *  (pickBatchLabel lo dice en el boton). Con «Detectar automaticamente» el
   *  tipo se queda: cada factura va al lote de su tipo. */
  const pickBatch = (batch: OpenBatch) => {
    setPeriod(periodStateOf(batch));
    if (type !== "UNKNOWN") setType(batch.type);
    setPeriodTouched(true);
  };

  /** El aviso de solape: el periodo de ese lote, con el tipo elegido. */
  const pickPeriod = (batch: OpenBatch) => {
    setPeriod(periodStateOf(batch));
    setPeriodTouched(true);
  };

  // Empresas del grupo que este usuario puede ver/subir: un gestor puede no
  // tener asignadas todas las del grupo (que es de la firma). Filtramos el
  // desplegable y la preselección a lo accesible para no marcar empresas que
  // no salen en los checkboxes y que el backend rechazaría (403).
  const accessibleClientIds = new Set(clients.map((c) => c.id));
  const visibleGroups = groups.filter((g) => g.clientIds.some((cid) => accessibleClientIds.has(cid)));

  const showNotices = (notices: readonly string[]) => {
    for (const text of notices) {
      if (text === OFFICE_FILES_NOTICE) info(text);
      else warning(text);
    }
  };

  const addFiles = (incoming: FileList | File[]) => {
    showNotices(uploads.add(Array.from(incoming), listMode));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!isPending) addFiles(e.dataTransfer.files);
  };

  /** Lo que deja la subida: la tarjeta de cada taco y la línea «¿Era papel?»
   *  de cada tanda digital con algo subido. Un reintento suma a la suya. */
  const keepOutcomes = (outcomes: readonly BatchOutcome[]) => {
    setTacoPanels((prev) => {
      let next = [...prev];
      for (const outcome of outcomes) {
        if (outcome.kind === "digital") continue;
        const index = next.findIndex((panel) => panel.batchId === outcome.batchId);
        if (index < 0) {
          next = [...next, outcome];
        } else if (outcome.kind === "perInvoice") {
          const current = next[index];
          if (current.kind === "perInvoice") {
            next[index] = { ...current, uploaded: current.uploaded + outcome.uploaded, duplicates: current.duplicates + outcome.duplicates };
          }
        }
      }
      return next;
    });
    setDigitalLines((prev) => {
      const next = [...prev];
      for (const outcome of outcomes) {
        if (outcome.kind !== "digital") continue;
        const index = next.findIndex((line) => line.batchId === outcome.batchId);
        if (index < 0) next.push({ batchId: outcome.batchId, fileCount: outcome.fileCount, uploaded: outcome.uploaded });
        else next[index] = { ...next[index], uploaded: next[index].uploaded + outcome.uploaded };
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!list.items.length || isPending) return;
    if (mode === "single" && (!clientId || selectionClosed)) return;
    if (mode === "classify" && candidateIds.size === 0) return;

    const outcome = await uploads.upload(
      {
        clientId: mode === "single" ? clientId : null,
        candidateClientIds: mode === "classify" ? [...candidateIds] : [],
        periodType,
        periodMonth: effectivePeriodMonth,
        periodYear: period.year,
        type,
      },
      listMode,
    );
    if ("error" in outcome) {
      toastError(outcome.error);
      return;
    }

    keepOutcomes(outcome.batches);
    const { ok: okCount, duplicates: dupCount, errors: errCount } = outcome;
    const tacos = outcome.batches.filter((batch) => batch.kind !== "digital");
    for (const taco of tacos) {
      if (taco.kind === "wholePdf") {
        success(`${tacoLabel(taco.tacoNumber)}: PDF subido (${plural(taco.pageCount, "página", "páginas")}). Falta marcar dónde empieza cada factura.`);
      } else if (taco.uploaded > 0) {
        success(`${tacoLabel(taco.tacoNumber)}: ${plural(taco.uploaded, "página subida", "páginas subidas")}.`);
      }
    }
    if (okCount > 0 && tacos.length === 0) {
      success(`${okCount} factura${okCount !== 1 ? "s" : ""} subida${okCount !== 1 ? "s" : ""} correctamente`);
    }
    if (okCount > 0) {
      // Los lotes abiertos cambian (el de esta subida ya lo es): sin perder lo elegido.
      router.refresh();
      if (mode === "classify") setClassifyNotice(okCount);
    }
    if (dupCount > 0 && okCount === 0) {
      info(`${dupCount} duplicada${dupCount !== 1 ? "s" : ""} omitida${dupCount !== 1 ? "s" : ""}`);
    }
    if (errCount > 0) {
      toastError(`${errCount} archivo${errCount !== 1 ? "s" : ""} con error`);
    }

    // Auto-limpiar OK y duplicadas tras 1.5s. Los errores se quedan
    // para que el gestor vea que paso y pueda reintentar.
    setTimeout(uploads.clearFinished, 1500);
  };

  const waiting = list.items.filter((i) => i.status !== "ok" && i.status !== "duplicate");
  const pendingCount = waiting.length;
  // Filas que aún no tienen tanda: las que se ordenan y se mueven.
  const movableCount = list.items.filter((i) => !i.batchId && (i.status === "queued" || i.status === "error")).length;
  const pendingTaco = waiting.find((i) => i.tacoNumber != null)?.tacoNumber ?? null;
  const showPages = listMode === "perInvoice";

  const submitLabel = isPending
    ? "Subiendo..."
    : listMode === "wholePdf"
      ? "Subir el PDF del taco"
      : listMode === "perInvoice"
        ? pendingTaco != null && movableCount === 0
          ? `Subir ${plural(pendingCount, "página", "páginas")} del ${tacoLabel(pendingTaco)}`
          : `Subir el taco (${plural(pendingCount, "página", "páginas")})`
        : `Subir ${pendingCount > 0 ? `${pendingCount} archivo${pendingCount !== 1 ? "s" : ""}` : "archivos"}`;

  const drop = DROP_TEXT[listMode];

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {classifyNotice !== null && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-[13px] text-blue-800">
          <p>
            {classifyNotice === 1 ? "La factura se está leyendo" : `Las ${classifyNotice} facturas se están leyendo`} y{" "}
            {classifyNotice === 1 ? "irá sola a su empresa" : "irán solas a su empresa"} por el CIF.{" "}
            <Link href="/dashboard/worker/clasificar" className="font-semibold underline underline-offset-2 hover:text-blue-900">
              Ver el reparto
            </Link>
          </p>
          <button
            type="button"
            onClick={() => setClassifyNotice(null)}
            aria-label="Cerrar aviso"
            className="flex-shrink-0 text-blue-400 hover:text-blue-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-[14px] font-semibold text-slate-800">
          Configuración del lote
        </h2>
        {/* Modo: un cliente vs clasificar entre varios por CIF */}
        <div className="mb-4">
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Modo de subida
          </label>
          <div className="flex gap-2">
            {([["single", "Un cliente"], ["classify", "Clasificar entre varios"]] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => chooseMode(m)}
                disabled={(m === "classify" && clients.length < 2) || settingsLocked}
                className={`flex-1 rounded-lg border px-3 py-2 text-[12px] font-medium transition disabled:opacity-40 ${
                  mode === m ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {mode === "single" ? (
          <>
            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Cliente
              </label>
              <Select
                value={clientId}
                onChange={chooseClient}
                disabled={settingsLocked}
                options={clients.map((c) => ({ value: c.id, label: `${c.name} (${c.cif})` }))}
              />
            </div>

            {clientOpenBatches.length > 0 && (
              <div className="mb-4">
                <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Lotes abiertos de este cliente
                </label>
                <ul className="space-y-1.5">
                  {clientOpenBatches.map((b) => {
                    const chosen = matching.includes(b);
                    return (
                      <li
                        key={`${b.periodType}-${b.periodYear}-${b.periodMonth}-${b.type}`}
                        className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                          chosen ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white"
                        }`}
                      >
                        <span className="min-w-0 truncate text-[12px] text-slate-700">
                          <span className="font-medium">{batchLabel(b)}</span>
                          <span className="text-slate-500"> · {openBatchCounts(b)}</span>
                        </span>
                        {/* El mismo boton en los dos estados: al elegir, el foco
                            se queda en el (con un span en su lugar se perdia). */}
                        <button
                          type="button"
                          onClick={() => { if (!chosen) pickBatch(b); }}
                          disabled={settingsLocked}
                          aria-disabled={chosen}
                          className={`inline-flex flex-shrink-0 items-center gap-1 text-[11px] font-semibold text-blue-700 transition disabled:opacity-50 ${
                            chosen ? "cursor-default px-1 py-1" : "rounded-lg border border-blue-200 bg-white px-2.5 py-1 hover:bg-blue-50"
                          }`}
                        >
                          {chosen ? (
                            <>
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Elegido
                            </>
                          ) : pickBatchLabel(b.type, type)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* A donde van: el lote abierto que se ha elegido (lo que pidio el
                asesor), ninguno o un periodo cerrado, para que no se abra otro
                lote sin verlo. Se anuncia al cambiar. */}
            <div role="status">
              {clientId && (notice.tone === "closed" ? (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <p>{notice.text}</p>
                </div>
              ) : notice.tone === "open" ? (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[12px] text-blue-800">
                  <Layers className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <p>{notice.text}</p>
                </div>
              ) : (
                <p className="mb-4 text-[12px] text-slate-500">{notice.text}</p>
              ))}
            </div>

            {overlapping.map((b) => {
              const label = periodLabel(b.periodType, b.periodMonth, b.periodYear);
              return (
                <div
                  key={`solape-${b.periodType}-${b.periodYear}-${b.periodMonth}`}
                  className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800"
                >
                  <p className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    Ya hay un lote abierto de {label} para este cliente: ¿las añades a ese?
                  </p>
                  <button
                    type="button"
                    onClick={() => pickPeriod(b)}
                    disabled={settingsLocked}
                    className="rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-amber-700 disabled:opacity-50"
                  >
                    Añadir a {label}
                  </button>
                </div>
              );
            })}
          </>
        ) : (
          <div className="mb-4 space-y-2">
            {visibleGroups.length > 0 && (
              <div>
                <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Grupo guardado
                </label>
                <Select
                  value={groupId}
                  disabled={settingsLocked}
                  onChange={(v) => {
                    setGroupId(v);
                    const g = visibleGroups.find((x) => x.id === v);
                    // Solo las empresas del grupo que este usuario puede subir.
                    setCandidateIds(new Set(g ? g.clientIds.filter((cid) => accessibleClientIds.has(cid)) : []));
                  }}
                  options={[{ value: "", label: "— Selección manual —" }, ...visibleGroups.map((g) => ({ value: g.id, label: g.name }))]}
                />
              </div>
            )}
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Empresas candidatas ({candidateIds.size})
              </label>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {clients.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700">
                    <input
                      type="checkbox"
                      checked={candidateIds.has(c.id)}
                      disabled={settingsLocked}
                      onChange={() => {
                        setGroupId("");
                        setCandidateIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          return next;
                        });
                      }}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                    />
                    <span className="truncate" title={`${c.name} (${c.cif})`}>{c.name}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">
                Cada factura se asigna automáticamente a su empresa por el CIF —y si no, por el nombre— que aparezca en el documento (según el tipo de abajo); las que no casen con claridad quedan en «Reparto» para que elijas tú.
              </p>
            </div>
          </div>
        )}
        {/* Toggle mensual / trimestral */}
        <div className="mb-4">
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Agrupación del periodo
          </label>
          <div className="flex gap-2">
            {(["MONTHLY", "QUARTERLY"] as const).map((pt) => (
              <button
                key={pt}
                type="button"
                onClick={() => changePeriod({ periodType: pt })}
                disabled={settingsLocked}
                className={`flex-1 rounded-lg border px-3 py-2 text-[12px] font-medium transition disabled:opacity-40 ${
                  periodType === pt
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {pt === "MONTHLY" ? "Mensual" : "Trimestral"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {periodType === "MONTHLY" ? "Mes" : "Trimestre"}
            </label>
            {periodType === "MONTHLY" ? (
              <Select
                value={String(period.month)}
                onChange={(v) => changePeriod({ month: Number(v), quarter: quarterFromMonth(Number(v)) })}
                disabled={settingsLocked}
                options={MONTH_OPTIONS}
              />
            ) : (
              <Select
                value={String(quarter)}
                onChange={(v) => changePeriod({ quarter: Number(v), month: quarterStartMonth(Number(v)) })}
                disabled={settingsLocked}
                options={QUARTER_OPTIONS.map((q) => ({ value: String(q.value), label: q.label }))}
              />
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Año
            </label>
            <Select value={String(period.year)} onChange={(v) => changePeriod({ year: Number(v) })} disabled={settingsLocked} options={yearOptions} />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Tipo
            </label>
            <Select
              value={type}
              onChange={(v) => chooseType(v as UploadType)}
              disabled={settingsLocked}
              options={[
                { value: "PURCHASE", label: "Facturas recibidas" },
                { value: "SALE", label: "Facturas emitidas" },
                { value: "UNKNOWN", label: "Detectar automáticamente" },
              ]}
            />
          </div>
        </div>

        <PaperUploadOptions
          isPaper={isPaper}
          onPaperChange={setIsPaper}
          scanMode={scanMode}
          onScanModeChange={setScanMode}
          classify={mode === "classify"}
          boxMode={firmPaperBoxMode}
          disabled={settingsLocked}
        />

        {lockReason && (
          <p role="status" className="mt-3 flex items-start gap-1.5 text-[12px] text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {lockReason}
          </p>
        )}
      </div>

      <div
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onClick={() => !isPending && inputRef.current?.click()}
        className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors sm:px-8 sm:py-12 ${
          isPending ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        } ${
          isDragging
            ? "border-blue-400 bg-blue-50"
            : "border-slate-200 bg-white hover:border-blue-300 hover:bg-slate-50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT[listMode]}
          multiple={listMode !== "wholePdf"}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            // Para poder volver a elegir los mismos ficheros después de quitarlos.
            e.target.value = "";
          }}
        />
        <div className={`mb-4 flex h-14 w-14 items-center justify-center rounded-xl ${isDragging ? "bg-blue-100" : "bg-slate-100"}`}>
          <CloudUpload className={`h-7 w-7 ${isDragging ? "text-blue-500" : "text-slate-400"}`} />
        </div>
        <p className="text-[14px] font-semibold text-slate-700">
          {drop.title}{" "}
          <span className="text-blue-600">{drop.link}</span>
        </p>
        <p className="mt-1 text-[12px] text-slate-400">{drop.help}</p>
      </div>

      {list.items.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
            <p className="text-[13px] font-semibold text-slate-700">
              {list.items.length} archivo{list.items.length !== 1 ? "s" : ""}
            </p>
            {!isPending && list.items.some((i) => i.status === "queued" || i.status === "error") && (
              <button
                type="button"
                onClick={uploads.clearWaiting}
                className="text-[11px] font-medium text-slate-400 hover:text-slate-600"
              >
                Limpiar lista
              </button>
            )}
          </div>
          {showPages && movableCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-[12px] text-slate-600 sm:px-5">
              <p>
                {plural(movableCount, "fichero", "ficheros")} · el taco tendrá {plural(movableCount, "página", "páginas")} en este orden
                {list.manualOrder && <span className="block font-medium text-amber-700">Pon el papel en este mismo orden.</span>}
              </p>
              <p className="flex items-center gap-1.5">
                <span className="text-slate-500">Ordenar por:</span>
                {(["name", "time"] as const).map((sortBy, i) => (
                  <span key={sortBy} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-slate-300">·</span>}
                    <button
                      type="button"
                      onClick={() => uploads.resort(sortBy)}
                      disabled={isPending}
                      aria-pressed={list.sortBy === sortBy && !list.manualOrder}
                      className={`font-medium ${list.sortBy === sortBy && !list.manualOrder ? "text-slate-800" : "text-blue-700 hover:underline"}`}
                    >
                      {sortBy === "name" ? "nombre" : "hora del fichero"}
                    </button>
                  </span>
                ))}
              </p>
            </div>
          )}
          <ul className="divide-y divide-slate-50">
            {list.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                page={showPages || item.tacoNumber != null ? pageOf(list, item.id) : null}
                movable={showPages && !item.batchId && (item.status === "queued" || item.status === "error")}
                movableCount={movableCount}
                disabled={isPending}
                onRemove={() => uploads.remove(item.id)}
                onMoveBy={(delta) => uploads.moveBy(item.id, delta)}
                onMoveTo={(target) => uploads.moveTo(item.id, target)}
                onReplace={(file) => {
                  const text = uploads.replace(item.id, file);
                  if (text) warning(text);
                }}
              />
            ))}
          </ul>
        </div>
      )}

      {(tacoPanels.length > 0 || digitalLines.some((line) => line.uploaded > 0)) && (
        <div className="space-y-3">
          {tacoPanels.map((panel) => (
            <PaperBatchPanel
              key={panel.batchId}
              panel={panel}
              errors={list.items.filter((i) => i.batchId === panel.batchId && i.status === "error").length}
              onClose={() => setTacoPanels((prev) => prev.filter((p) => p.batchId !== panel.batchId))}
            />
          ))}
          {digitalLines.filter((line) => line.uploaded > 0).map((line) => (
            <DigitalBatchLine
              key={line.batchId}
              batchId={line.batchId}
              fileCount={line.fileCount}
              onClose={() => setDigitalLines((prev) => prev.filter((l) => l.batchId !== line.batchId))}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        {isPending ? (
          <p className="text-[12px] font-medium text-amber-700">No cierres esta pestaña hasta que termine la subida.</p>
        ) : (
          <p className="text-[12px] text-slate-400">
            Las facturas se suben directamente al almacenamiento y se analizan automáticamente con OCR.
          </p>
        )}
        <button
          type="submit"
          disabled={!list.items.length || isPending || pendingCount === 0 || (mode === "single" ? !clientId || selectionClosed : candidateIds.size === 0)}
          className="flex flex-shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function ItemRow({
  item,
  page,
  movable,
  movableCount,
  disabled,
  onRemove,
  onMoveBy,
  onMoveTo,
  onReplace,
}: {
  item: UploadListItem;
  /** «Pág. N» (la que tiene o tendrá en el taco), o null fuera de un taco. */
  page: number | null;
  /** Fila sin tanda en papel factura a factura: se puede mover. */
  movable: boolean;
  movableCount: number;
  disabled: boolean;
  onRemove: () => void;
  onMoveBy: (delta: -1 | 1) => void;
  onMoveTo: (page: number) => void;
  onReplace: (file: File) => void;
}) {
  const [target, setTarget] = useState("");
  const replaceRef = useRef<HTMLInputElement>(null);
  const ext = item.name.split(".").pop()?.toLowerCase();
  const Icon = ext === "xml" ? FileCode2
    : ["jpg", "jpeg", "png", "webp", "heic"].includes(ext ?? "") ? Image
    : FileText;
  const canMove = movable && !disabled;
  const moveTo = () => {
    const value = Number(target);
    if (Number.isInteger(value) && value >= 1 && value <= movableCount) onMoveTo(value);
    setTarget("");
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
      {page != null ? (
        <span className="flex h-8 min-w-[3.5rem] flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 px-2 text-[11px] font-semibold text-blue-700">
          Pág. {page}
        </span>
      ) : (
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
          <Icon className="h-4 w-4 text-slate-400" />
        </div>
      )}
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-[13px] font-medium text-slate-700" title={item.name}>{item.name}</p>
        <p className="text-[11px] text-slate-400">
          {formatSize(item.size)}
          {item.status === "duplicate" && item.duplicateOf && (
            <span className="ml-2 text-amber-600">· duplicado de {item.duplicateOf}</span>
          )}
          {item.status === "error" && item.errorMessage && (
            <span className="ml-2 text-red-600">· {item.errorMessage}</span>
          )}
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        {movable && (
          <>
            <button
              type="button"
              onClick={() => onMoveBy(-1)}
              disabled={!canMove || page === 1}
              aria-label="Subir una fila"
              title="Subir una fila"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onMoveBy(1)}
              disabled={!canMove || page === movableCount}
              aria-label="Bajar una fila"
              title="Bajar una fila"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
            <span className="flex items-center gap-1">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={movableCount}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    moveTo();
                  }
                }}
                disabled={!canMove || movableCount < 2}
                aria-label="Mover a otra página"
                placeholder="Pág."
                className="h-7 w-14 rounded-lg border border-slate-200 px-1.5 text-[12px] text-slate-700 disabled:opacity-40"
              />
              <button
                type="button"
                onClick={moveTo}
                disabled={!canMove || !target}
                className="h-7 rounded-lg border border-slate-200 px-2 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                Mover
              </button>
            </span>
          </>
        )}
        {item.status === "error" && item.batchId && !disabled && (
          <>
            <input
              ref={replaceRef}
              type="file"
              accept={item.tacoNumber != null ? ACCEPT.perInvoice : ACCEPT.digital}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onReplace(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => replaceRef.current?.click()}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 px-2 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              <Replace className="h-3.5 w-3.5" />
              Cambiar el fichero
            </button>
          </>
        )}
        <StatusBadge item={item} />
        {(item.status === "queued" || item.status === "error" || item.status === "duplicate") && !disabled && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Quitar de la lista"
            title="Quitar de la lista"
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-slate-300 transition hover:bg-slate-100 hover:text-slate-500"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </li>
  );
}

function StatusBadge({ item }: { item: UploadListItem }) {
  switch (item.status) {
    case "queued":
      return null;
    case "uploading":
      return (
        <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700">
          <Loader2 className="h-3 w-3 animate-spin" />
          Subiendo
        </span>
      );
    case "ok":
      return (
        <span className="flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 text-[11px] font-medium text-green-700">
          <CheckCircle2 className="h-3 w-3" />
          Subida
        </span>
      );
    case "duplicate":
      return (
        <span
          className="flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700"
          title={item.duplicateOf ? `Duplicado de: ${item.duplicateOf}` : "Ya existe en el sistema"}
        >
          <Copy className="h-3 w-3" />
          Duplicada
        </span>
      );
    case "error":
      return (
        <span
          className="flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-700"
          title={item.errorMessage ?? "Error"}
        >
          <AlertCircle className="h-3 w-3" />
          Error
        </span>
      );
  }
}
