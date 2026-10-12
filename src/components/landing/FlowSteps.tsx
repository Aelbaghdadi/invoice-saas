"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  Check,
  Code2,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Upload,
} from "lucide-react";

type Step = { kicker: string; title: string; body: string; points: string[] };

const STEPS: Step[] = [
  {
    kicker: "01 · Recibir",
    title: "Tus clientes suben. Nadie reenvía correos.",
    body: "Cada cliente tiene su portal. Arrastra PDFs, fotos del móvil o el XML de FacturaE y la factura entra directa en la cola de su gestor. Si subís un montón mezclado de varias empresas de un grupo, Faktury lo reparte por CIF.",
    points: [
      "PDF, JPG, PNG, WEBP, HEIC y XML FacturaE",
      "Duplicados detectados al subir",
      "Reparto automático por CIF del receptor",
    ],
  },
  {
    kicker: "02 · Revisar",
    title: "El gestor revisa con el original al lado. Sin ratón.",
    body: "Pantalla partida: el PDF a la izquierda, los datos a la derecha. Los campos leídos con mucha confianza quedan en gris y el tabulador se los salta: solo te paras en lo dudoso. Intro valida y pasa a la siguiente.",
    points: [
      "Cuadre al céntimo en tiempo real",
      "Avisos de duplicado y saltos de numeración",
      "Intro valida · R rechaza · D duplicada",
    ],
  },
  {
    kicker: "03 · Exportar",
    title: "Un Excel que A3 importa a la primera.",
    body: "Eliges cliente y periodo, mensual o trimestral, y descargas el fichero con cuentas, tipos de operación y desglose de IVA. Antes de exportar se bloquea lo que A3 rechazaría, y si corriges algo ya exportado te lo avisa.",
    points: [
      "Plantilla oficial de A3 Asesor",
      "Lotes con instantánea de lo exportado",
      "Aviso de reexportación tras una corrección",
    ],
  },
];

export function FlowSteps() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting)
            setActive(Number((entry.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" }
    );
    refs.current.forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
      <div className="min-w-0">
        {STEPS.map((step, i) => (
          <div
            key={step.kicker}
            ref={(node) => {
              refs.current[i] = node;
            }}
            data-index={i}
            className="flex flex-col justify-center py-10 lg:min-h-[78vh] lg:py-0"
          >
            <p
              className={`font-mono text-[12px] tracking-wide transition-colors duration-500 ${active === i ? "text-[var(--teal-ink)]" : "text-[var(--ink-soft)]"}`}
            >
              {step.kicker}
            </p>
            <h3
              className={`font-display mt-3 text-[34px] leading-[1.05] transition-opacity duration-500 sm:text-[44px] ${active === i ? "opacity-100" : "lg:opacity-35"}`}
            >
              {step.title}
            </h3>
            <p className="mt-5 max-w-[46ch] text-[16px] leading-relaxed text-[var(--ink-soft)]">
              {step.body}
            </p>
            <ul className="mt-6 space-y-2.5">
              {step.points.map((point) => (
                <li
                  key={point}
                  className="flex items-start gap-2.5 text-[14.5px]"
                >
                  <span className="mt-[3px] grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[var(--navy)] text-white">
                    <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                  </span>
                  {point}
                </li>
              ))}
            </ul>
            {/* En móvil cada paso lleva su maqueta debajo; en escritorio van en el panel fijo. */}
            <div className="mt-8 lg:hidden">{renderPanel(i)}</div>
          </div>
        ))}
      </div>

      <div className="relative hidden lg:block">
        <div className="sticky top-[14vh] h-[72vh]">
          {STEPS.map((step, i) => (
            <div
              key={step.kicker}
              className="lp-panel absolute inset-0 flex items-center"
              data-active={active === i}
            >
              {/* La key reinicia las animaciones de entrada al volver a un paso. */}
              <div key={active === i ? "on" : "off"} className="w-full">
                {renderPanel(i)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function renderPanel(index: number) {
  if (index === 0) return <UploadPanel />;
  if (index === 1) return <ReviewPanel />;
  return <ExportPanel />;
}

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#d9d3c6] bg-[#fbfaf7] shadow-[0_40px_80px_-40px_rgb(6_42_99/0.4)]">
      <div className="flex items-center gap-2 border-b border-[#e7e2d8] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#e0dbd0]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#e0dbd0]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#e0dbd0]" />
        <span className="ml-2 truncate text-[12px] font-medium text-[var(--ink-soft)]">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

const UPLOADS = [
  {
    name: "factura_luz_septiembre.pdf",
    icon: FileText,
    meta: "PDF · 182 KB",
    duplicate: false,
  },
  {
    name: "IMG_4471.HEIC",
    icon: ImageIcon,
    meta: "Foto · ticket de gasolinera",
    duplicate: false,
  },
  {
    name: "FAC-000318.xml",
    icon: Code2,
    meta: "FacturaE · se lee sin OCR",
    duplicate: false,
  },
  {
    name: "F-2026-0412.pdf",
    icon: FileText,
    meta: "Ya subida el 02/10 por Talleres Moncayo",
    duplicate: true,
  },
  {
    name: "alquiler_nave_oct.pdf",
    icon: FileText,
    meta: "PDF · 96 KB",
    duplicate: false,
  },
];

function UploadPanel() {
  return (
    <Frame title="Portal del cliente · Subir facturas">
      <div className="p-5">
        <div className="grid place-items-center rounded-xl border-2 border-dashed border-[#cfc8b8] bg-white px-6 py-7 text-center">
          <Upload className="h-6 w-6 text-[var(--navy)]" />
          <p className="mt-2 text-[14px] font-medium">
            Arrastra aquí tus facturas
          </p>
          <p className="text-[12px] text-[var(--ink-soft)]">
            o hazles una foto con el móvil
          </p>
        </div>
        <ul className="mt-4 space-y-2">
          {UPLOADS.map((file, i) => (
            <li
              key={file.name}
              className={`lp-drop-file flex items-center gap-3 rounded-lg border px-3 py-2.5 text-[13px] ${
                file.duplicate
                  ? "border-amber-200 bg-amber-50"
                  : "border-[#e7e2d8] bg-white"
              }`}
              style={delay(200 + i * 260)}
            >
              <file.icon
                className={`h-4 w-4 shrink-0 ${file.duplicate ? "text-amber-600" : "text-[var(--ink-soft)]"}`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{file.name}</p>
                <p
                  className={`truncate text-[11.5px] ${file.duplicate ? "text-amber-700" : "text-[var(--ink-soft)]"}`}
                >
                  {file.meta}
                </p>
              </div>
              {file.duplicate ? (
                <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                  Duplicada
                </span>
              ) : (
                <Check
                  className="h-4 w-4 shrink-0 text-emerald-600"
                  strokeWidth={3}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    </Frame>
  );
}

const REVIEW_FIELDS = [
  { label: "Proveedor", value: "Gasóleos del Jalón, S.L.", safe: true },
  { label: "CIF", value: "B50998877", safe: true },
  { label: "Nº factura", value: "GJ-1187", safe: false },
  { label: "Base imponible", value: "84,30 €", safe: true },
];

const REVIEW_KEYS = [
  { key: "Tab", label: "siguiente campo dudoso", ms: 0 },
  { key: "Intro", label: "validar", ms: 800 },
  { key: "Alt →", label: "siguiente factura", ms: 1600 },
];

function ReviewPanel() {
  return (
    <Frame title="Revisión · Talleres Moncayo · Octubre 2026">
      <div className="flex items-center gap-3 border-b border-[#e7e2d8] px-4 py-2 text-[11.5px] text-[var(--ink-soft)]">
        <span className="shrink-0">Lote de octubre</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#ebe7de]">
          <div className="lp-progress h-full rounded-full bg-emerald-500" />
        </div>
        <span className="shrink-0 font-mono">23 / 41</span>
      </div>
      <div className="grid grid-cols-[0.85fr_1fr]">
        <div className="border-r border-[#e7e2d8] bg-[#2a2f3a] p-4">
          <div className="space-y-2 rounded bg-white p-3">
            <div className="h-2.5 w-2/3 rounded bg-[#14532d]/80" />
            <div className="h-1.5 w-1/2 rounded bg-slate-200" />
            <div className="h-1.5 w-2/5 rounded bg-slate-200" />
            <div className="mt-3 h-4 rounded bg-[#14532d]/70" />
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="h-1.5 rounded bg-slate-100" />
            ))}
            <div className="mt-3 ml-auto w-1/2 space-y-1.5">
              <div className="h-1.5 rounded bg-slate-200" />
              <div className="h-1.5 rounded bg-slate-200" />
              <div className="h-2 rounded bg-slate-400" />
            </div>
          </div>
        </div>
        <div className="space-y-2.5 p-4 text-[12px]">
          {REVIEW_FIELDS.map((field) => (
            <div key={field.label}>
              <p className="mb-0.5 flex items-center gap-1 text-[10.5px] text-[var(--ink-soft)]">
                {field.label}
                {field.safe ? (
                  <Check className="h-3 w-3 text-emerald-600" strokeWidth={3} />
                ) : null}
              </p>
              <div
                className={`flex h-8 items-center truncate rounded-md border px-2.5 font-mono ${
                  field.safe
                    ? "border-[#ebe7de] bg-[#f3f1ec] text-[var(--ink-soft)]"
                    : "border-[var(--teal-ink)] bg-white ring-2 ring-[rgb(34_214_208/0.25)]"
                }`}
              >
                {field.value}
              </div>
            </div>
          ))}
          <div className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-800 ring-1 ring-amber-200">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            Falta la GJ-1186 de este proveedor en la numeración
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#e7e2d8] px-4 py-3 text-[11.5px] text-[var(--ink-soft)]">
        {REVIEW_KEYS.map((item) => (
          <span key={item.key} className="flex items-center gap-1.5">
            <kbd
              className="lp-key lp-key-press rounded-md border border-[#d9d3c6] bg-white px-1.5 py-0.5 font-mono text-[11px] text-[var(--ink)]"
              style={delay(item.ms)}
            >
              {item.key}
            </kbd>
            {item.label}
          </span>
        ))}
      </div>
    </Frame>
  );
}

const EXPORT_COUNTS = [
  { label: "Recibidas", count: 128 },
  { label: "Emitidas", count: 46 },
  { label: "De ellas, intracomunitarias", count: 7 },
];

function ExportPanel() {
  return (
    <Frame title="Exportar · A3 Asesor">
      <div className="grid gap-4 p-5 sm:grid-cols-[1fr_0.9fr]">
        <div className="min-w-0 space-y-3 text-[12.5px]">
          <div>
            <p className="mb-1 text-[10.5px] tracking-wide text-[var(--ink-soft)]">
              CLIENTE
            </p>
            <div className="truncate rounded-lg border border-[#e2ddd2] bg-white px-3 py-2">
              Talleres Moncayo, S.L. — B99887766
            </div>
          </div>
          <div>
            <p className="mb-1 text-[10.5px] tracking-wide text-[var(--ink-soft)]">
              PERIODO
            </p>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-[#efece5] p-1">
              <span className="rounded-md px-3 py-1.5 text-center text-[var(--ink-soft)]">
                Mensual
              </span>
              <span className="rounded-md bg-white px-3 py-1.5 text-center font-medium shadow-sm">
                3T 2026
              </span>
            </div>
          </div>
          <div className="space-y-1.5 rounded-lg border border-[#e2ddd2] bg-white p-3">
            {EXPORT_COUNTS.map((row) => (
              <div key={row.label} className="flex justify-between gap-2">
                <span className="text-[var(--ink-soft)]">{row.label}</span>
                <span className="font-mono">{row.count}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-[#ebe7de] pt-1.5 font-medium">
              <span>Listas para exportar</span>
              <span className="font-mono">174</span>
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-[12px] text-emerald-800 ring-1 ring-emerald-200">
            <Check className="mt-px h-4 w-4 shrink-0" strokeWidth={3} />
            Sin bloqueos: todas cuadran y tienen cuenta asignada
          </div>
          <div
            className="lp-drop-file flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--navy)] text-[13px] font-semibold text-white"
            style={delay(300)}
          >
            <ArrowDownToLine className="h-4 w-4" /> Descargar Excel
          </div>
          <div
            className="lp-drop-file mt-auto flex items-center gap-3 rounded-xl border border-[#e2ddd2] bg-white p-3"
            style={delay(900)}
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-emerald-600 text-white">
              <FileSpreadsheet className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-mono text-[11.5px]">
                facturas_Talleres_Moncayo,_S.L._2026-T3_a3excel.xlsx
              </p>
              <p className="text-[11px] text-[var(--ink-soft)]">
                174 facturas · lote nº 14
              </p>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
