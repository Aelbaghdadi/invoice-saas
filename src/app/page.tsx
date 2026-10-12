import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Instrument_Serif } from "next/font/google";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarCheck,
  Check,
  History,
  Lock,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";
import { HeroDemo } from "@/components/landing/HeroDemo";
import { FlowSteps } from "@/components/landing/FlowSteps";
import { RevealObserver } from "@/components/landing/Reveal";
import "@/components/landing/landing.css";

const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-display",
});

// Destino de todos los "Pedir una demo". Cambiadlo aquí si pasa a ser un
// formulario o un calendario de reservas.
const DEMO_HREF =
  "mailto:hola@faktury.es?subject=Quiero%20ver%20una%20demo%20de%20Faktury";

export const metadata: Metadata = {
  title: { absolute: "Faktury — Las facturas de tus clientes, listas para A3" },
  description:
    "Faktury lee los PDF, fotos y XML de tus clientes, propone cada dato con criterio fiscal español y lo deja listo para importar en A3 Asesor. Tu gestor solo revisa y valida.",
};

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

const CASES = [
  "Intracomunitarias autorrepercutidas",
  "Recargo de equivalencia",
  "Retención de IRPF",
  "Rectificativas",
  "Inversión del sujeto pasivo",
  "Importaciones",
  "IVA no deducible",
  "Régimen agrario",
  "NIF con dígito de control",
  "VAT europeo",
  "Duplicados",
  "Huecos en la numeración",
  "Cuadre al céntimo",
  "XML FacturaE sin OCR",
];

const BEFORE_AFTER = [
  {
    label: "Recepción",
    before: "Correo, WhatsApp y una carpeta «escanear»",
    after: "Portal del cliente, directo a la cola de su gestor",
  },
  {
    label: "Lectura",
    before: "Teclear CIF, fecha, bases y cuotas a mano",
    after: "Campos leídos y marcados según confianza",
  },
  {
    label: "Comprobación",
    before: "La calculadora, si da tiempo",
    after: "Cuadre exacto, duplicados y huecos avisados",
  },
  {
    label: "Cuentas",
    before: "Buscar qué cuenta se usó la última vez",
    after: "Recordadas por proveedor y cliente",
  },
  {
    label: "A3",
    before: "Asientos uno a uno",
    after: "Un Excel con la plantilla oficial",
  },
];

const FAQ = [
  {
    q: "¿Faktury sustituye a A3?",
    a: "No. A3 sigue siendo vuestro programa contable. Faktury hace el trabajo de antes: recibir, leer, revisar y preparar el fichero que A3 importa con su plantilla oficial.",
  },
  {
    q: "¿Y si la lectura se equivoca?",
    a: "Para eso está la revisión. Ninguna factura se exporta sin que un gestor la valide. Los campos dudosos se destacan, el cuadre se comprueba al céntimo y lo que A3 rechazaría se bloquea antes de exportar.",
  },
  {
    q: "Con la factura electrónica obligatoria, ¿sigue teniendo sentido?",
    a: "Sí. Las facturas en XML FacturaE se leen tal cual, sin OCR. Y seguirán llegando tickets, facturas extranjeras y papel de emisores no obligados: todo entra por el mismo sitio y se revisa igual.",
  },
  {
    q: "¿Mis clientes tienen que instalar algo?",
    a: "No. Entran desde el navegador, también desde el móvil, y suben sus facturas en su portal. Solo ven las suyas.",
  },
  {
    q: "¿Quién ve qué dentro del despacho?",
    a: "Cada asesoría está aislada del resto. Dentro, cada gestor ve solo los clientes que tiene asignados y el administrador lo ve todo. Cada cambio queda en un registro de auditoría que no se puede modificar ni borrar.",
  },
  {
    q: "Trabajamos con otro programa contable, ¿nos sirve?",
    a: "Hoy exportamos a A3 Asesor. Si usáis otro programa, contadnos cuál en la demo: es lo primero que priorizamos.",
  },
  {
    q: "¿Cuánto cuesta?",
    a: "Depende del volumen de facturas y de cuántos gestores sois. Os lo explicamos en la demo, sin compromiso y con vuestros números delante.",
  },
];

export default function Home() {
  return (
    <div className={`lp ${display.variable} min-h-screen`}>
      <RevealObserver />
      <Nav />

      <main>
        <Hero />
        <CaseTicker />
        <Problem />

        <section
          id="como-funciona"
          className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pt-24 pb-16 sm:px-8 lg:pt-32"
        >
          <SectionHead
            kicker="Cómo funciona"
            title={
              <>
                Tres pasos. El tercero lo hace <em>A3</em>.
              </>
            }
          />
          <FlowSteps />
        </section>

        <Fiscal />
        <Learning />
        <Control />
        <Statement />
        <Faq />
        <FinalCta />
      </main>

      <Footer />
    </div>
  );
}

/* ─────────────────────────────── Bloques ─────────────────────────────── */

function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/faktury-icon.svg" alt="" className="h-8 w-8" />
      <span className="text-[17px] font-semibold tracking-tight text-[var(--ink)]">
        Faktury
      </span>
    </span>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-[rgb(224_219_208/0.7)] bg-[rgb(245_243_238/0.82)] backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-6 px-5 sm:px-8">
        <Link href="/" aria-label="Faktury, inicio">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-8 text-[14px] text-[var(--ink-soft)] md:flex">
          <a
            href="#como-funciona"
            className="transition-colors hover:text-[var(--ink)]"
          >
            Cómo funciona
          </a>
          <a
            href="#criterio-fiscal"
            className="transition-colors hover:text-[var(--ink)]"
          >
            Criterio fiscal
          </a>
          <a
            href="#control"
            className="transition-colors hover:text-[var(--ink)]"
          >
            Control
          </a>
          <a
            href="#preguntas"
            className="transition-colors hover:text-[var(--ink)]"
          >
            Preguntas
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="hidden rounded-full px-4 py-2 text-[14px] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-2)] sm:block"
          >
            Entrar
          </Link>
          <a
            href={DEMO_HREF}
            className="group inline-flex items-center gap-1.5 rounded-full bg-[var(--navy)] px-4 py-2 text-[14px] font-medium text-white transition-colors hover:bg-[#041c46]"
          >
            Pedir una demo
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="lp-grain relative">
      <div
        className="lp-ledger pointer-events-none absolute inset-0"
        aria-hidden
      />
      <div className="relative mx-auto max-w-[1200px] px-5 pt-16 pb-20 sm:px-8 sm:pt-24">
        <div className="mx-auto max-w-[900px] text-center">
          <p
            data-intro
            className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/70 px-3 py-1 text-[12.5px] text-[var(--ink-soft)]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--teal)]" />
            Para asesorías y despachos que trabajan con A3
          </p>
          <h1
            data-intro
            style={delay(80)}
            className="font-display mt-6 text-[46px] leading-[0.98] text-balance text-[var(--ink)] sm:text-[72px] lg:text-[86px]"
          >
            Tus gestores no estudiaron para{" "}
            <span className="lp-underline italic">
              teclear
              <svg viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden>
                <path
                  d="M3 14 C 40 6, 90 4, 130 8 S 185 14, 197 6"
                  fill="none"
                  stroke="#22d6d0"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
              </svg>
            </span>{" "}
            facturas.
          </h1>
          <p
            data-intro
            style={delay(160)}
            className="mx-auto mt-7 max-w-[60ch] text-[17px] leading-relaxed text-pretty text-[var(--ink-soft)] sm:text-[19px]"
          >
            Faktury lee los PDF, fotos y XML que suben tus clientes, propone
            cada dato con criterio fiscal español y te deja el Excel listo para
            importar en A3. Tu equipo pasa de teclear a revisar.
          </p>
          <div
            data-intro
            style={delay(240)}
            className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <a
              href={DEMO_HREF}
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-[var(--navy)] px-6 text-[15px] font-medium text-white shadow-[0_10px_30px_-10px_rgb(6_42_99/0.6)] transition-all hover:-translate-y-px hover:bg-[#041c46]"
            >
              Pedir una demo
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <a
              href="#como-funciona"
              className="inline-flex h-12 items-center gap-2 rounded-full border border-[var(--line)] bg-white/60 px-6 text-[15px] font-medium text-[var(--ink)] transition-colors hover:bg-white"
            >
              Ver cómo funciona
            </a>
          </div>
        </div>

        <div data-intro style={delay(360)} className="mt-16 sm:mt-20">
          <HeroDemo />
        </div>
      </div>
    </section>
  );
}

function CaseTicker() {
  const items = [...CASES, ...CASES];
  return (
    <div className="border-y border-[var(--line)] bg-[var(--paper-2)] py-4">
      <div className="lp-marquee overflow-hidden">
        <div className="lp-marquee-track">
          {items.map((item, i) => (
            <span
              key={i}
              className="flex items-center gap-6 pr-6 text-[14px] text-[var(--ink-soft)]"
              aria-hidden={i >= CASES.length}
            >
              <span className="whitespace-nowrap">{item}</span>
              <span className="text-[var(--teal-ink)]">✳</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionHead({
  kicker,
  title,
  intro,
  inverted = false,
}: {
  kicker: string;
  title: ReactNode;
  intro?: string;
  inverted?: boolean;
}) {
  return (
    <div data-reveal className="max-w-[760px]">
      <p
        className={`font-mono text-[12px] tracking-[0.16em] uppercase ${inverted ? "text-[var(--teal)]" : "text-[var(--teal-ink)]"}`}
      >
        {kicker}
      </p>
      <h2
        className={`font-display mt-4 text-[40px] leading-[1.02] sm:text-[58px] ${inverted ? "text-white" : "text-[var(--ink)]"}`}
      >
        {title}
      </h2>
      {intro ? (
        <p
          className={`mt-5 max-w-[58ch] text-[17px] leading-relaxed ${inverted ? "text-white/65" : "text-[var(--ink-soft)]"}`}
        >
          {intro}
        </p>
      ) : null}
    </div>
  );
}

function Problem() {
  return (
    <section className="mx-auto max-w-[1200px] px-5 pt-24 sm:px-8 lg:pt-32">
      <div className="grid gap-14 lg:grid-cols-[1.15fr_1fr] lg:gap-20">
        <div data-reveal>
          <p className="font-mono text-[12px] tracking-[0.16em] text-[var(--teal-ink)] uppercase">
            17 de octubre
          </p>
          <p className="font-display mt-5 text-[30px] leading-[1.18] text-[var(--ink)] sm:text-[40px]">
            El trimestre se presenta el día 20. Las facturas de tus clientes
            están repartidas entre{" "}
            <span className="rounded-sm bg-[#fde9c8] box-decoration-clone px-1">
              tres buzones
            </span>
            ,{" "}
            <span className="rounded-sm bg-[#fde9c8] box-decoration-clone px-1">
              dos grupos de WhatsApp
            </span>{" "}
            y una carpeta que se llama{" "}
            <span className="rounded-sm bg-[#fde9c8] box-decoration-clone px-1">
              «escanear»
            </span>
            . Alguien va a pasar el fin de semana tecleando CIFs.
          </p>
          <p className="mt-8 max-w-[52ch] text-[17px] leading-relaxed text-[var(--ink-soft)]">
            No es falta de oficio: es trabajo de copiar y pegar que se come el
            tiempo del criterio. Faktury se queda con la copia. El criterio
            sigue siendo vuestro.
          </p>
        </div>

        <div
          data-reveal
          style={delay(120)}
          className="self-end overflow-hidden rounded-2xl border border-[var(--line)] bg-white/70"
        >
          <div className="grid grid-cols-[0.8fr_1fr_1fr] gap-3 border-b border-[var(--line)] bg-[var(--paper-2)] px-5 py-3 text-[11.5px] font-medium tracking-wide text-[var(--ink-soft)] uppercase">
            <span />
            <span>Hoy</span>
            <span className="text-[var(--navy)]">Con Faktury</span>
          </div>
          {BEFORE_AFTER.map((row) => (
            <div
              key={row.label}
              className="grid grid-cols-[0.8fr_1fr_1fr] gap-3 border-b border-[var(--line)] px-5 py-4 text-[13.5px] leading-snug last:border-0"
            >
              <span className="font-medium text-[var(--ink)]">{row.label}</span>
              <span className="text-[var(--ink-soft)] line-through decoration-[rgb(70_82_106/0.35)]">
                {row.before}
              </span>
              <span className="text-[var(--ink)]">{row.after}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const EXTRA_CASES = [
  "Rectificativas con total negativo",
  "Inversión del sujeto pasivo",
  "Importaciones",
  "IVA no deducible",
  "Régimen agrario",
  "Varias líneas de IVA en una factura",
  "Bienes o servicios, recordado por proveedor",
  "NIF validado por dígito de control",
  "VAT europeo, Reino Unido y Suiza",
  "Periodos mensuales o trimestrales",
];

function Fiscal() {
  return (
    <section
      id="criterio-fiscal"
      className="relative scroll-mt-16 overflow-hidden bg-[var(--navy-deep)] text-white"
    >
      <div
        className="pointer-events-none absolute -top-40 -right-40 h-[520px] w-[520px] rounded-full opacity-25 blur-3xl"
        style={{
          background: "radial-gradient(circle, #22d6d0 0%, transparent 65%)",
        }}
        aria-hidden
      />
      <div className="relative mx-auto max-w-[1200px] px-5 py-24 sm:px-8 lg:py-32">
        <SectionHead
          inverted
          kicker="Criterio fiscal"
          title={
            <>
              Leer una factura es fácil.{" "}
              <em className="text-[var(--teal)]">Entenderla</em>, no.
            </>
          }
          intro="Un OCR genérico te da números. Faktury sabe qué hacer con ellos en España: qué IVA se autorrepercute, qué no suma al total y qué no debería llegar nunca a A3."
        />

        <div className="mt-14 grid gap-4 md:grid-cols-6">
          <FiscalCard
            className="md:col-span-4"
            ms={0}
            title="Intracomunitarias, autorrepercutidas al 21 %"
            note="Tipo de operación 8 · servicios. La cuota se declara y se deduce a la vez: no suma al total."
          >
            <div className="grid gap-x-8 gap-y-1.5 font-mono text-[13px] sm:grid-cols-2">
              <Row label="Base imponible" value="1.600,00" />
              <Row label="Proveedor" value="DE812345673" muted />
              <Row label="IVA soportado 21 %" value="336,00" accent />
              <Row label="IVA repercutido 21 %" value="−336,00" accent />
              <div className="col-span-full mt-2 flex justify-between border-t border-white/15 pt-2 text-white">
                <span>Total factura</span>
                <span>1.600,00 €</span>
              </div>
            </div>
          </FiscalCard>

          <FiscalCard
            className="md:col-span-2"
            ms={80}
            title="Cuadre al céntimo"
            note="Ni uno ni dos céntimos de tolerancia: lo que no cuadra no se exporta."
          >
            <div className="space-y-1.5 font-mono text-[13px]">
              <Row label="Base + IVA" value="1.500,40" />
              <Row label="Total leído" value="1.500,41" />
              <p className="mt-3 rounded-md bg-[#b91c1c]/20 px-2.5 py-1.5 text-[12px] text-[#fca5a5] ring-1 ring-[#f87171]/30">
                Descuadre de 0,01 €
              </p>
            </div>
          </FiscalCard>

          <FiscalCard
            className="md:col-span-2"
            ms={0}
            title="Recargo de equivalencia"
            note="Para clientes en recargo: se desglosa y viaja a A3 en su columna."
          >
            <div className="space-y-1.5 font-mono text-[13px]">
              <Row label="Base" value="500,00" />
              <Row label="IVA 21 %" value="105,00" />
              <Row label="Recargo 5,2 %" value="26,00" accent />
              <Total label="Total" value="631,00" />
            </div>
          </FiscalCard>

          <FiscalCard
            className="md:col-span-2"
            ms={80}
            title="Retención de IRPF"
            note="Profesionales y alquileres: la retención resta del total y se declara aparte."
          >
            <div className="space-y-1.5 font-mono text-[13px]">
              <Row label="Base" value="1.000,00" />
              <Row label="IVA 21 %" value="210,00" />
              <Row label="IRPF 15 %" value="−150,00" accent />
              <Total label="A pagar" value="1.060,00" />
            </div>
          </FiscalCard>

          <FiscalCard
            className="md:col-span-2"
            ms={160}
            title="Duplicados y huecos"
            note="La misma factura subida dos veces, o un número que falta en la serie del proveedor."
          >
            <ul className="space-y-1.5 font-mono text-[13px]">
              <li className="flex justify-between">
                <span>F-0411</span>
                <Check className="h-4 w-4 text-[var(--teal)]" />
              </li>
              <li className="flex justify-between text-[#fcd34d]">
                <span>F-0412</span>
                <span className="text-[12px]">falta</span>
              </li>
              <li className="flex justify-between">
                <span>F-0413</span>
                <Check className="h-4 w-4 text-[var(--teal)]" />
              </li>
              <li className="flex justify-between text-[#fcd34d]">
                <span>F-0413</span>
                <span className="text-[12px]">duplicada</span>
              </li>
            </ul>
          </FiscalCard>

          <FiscalCard
            className="md:col-span-6"
            ms={0}
            title="Y lo que no suele salir en las demos"
          >
            <div className="flex flex-wrap gap-2">
              {EXTRA_CASES.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[13px] text-white/80"
                >
                  {tag}
                </span>
              ))}
            </div>
          </FiscalCard>
        </div>
      </div>
    </section>
  );
}

function FiscalCard({
  title,
  note,
  children,
  className = "",
  ms,
}: {
  title: string;
  note?: string;
  children: ReactNode;
  className?: string;
  ms: number;
}) {
  return (
    <div
      data-reveal
      style={delay(ms)}
      className={`rounded-2xl border border-white/10 bg-white/[0.035] p-6 transition-colors hover:border-[rgb(34_214_208/0.35)] hover:bg-white/[0.055] ${className}`}
    >
      <h3 className="text-[16px] font-semibold tracking-tight">{title}</h3>
      <div className="mt-5">{children}</div>
      {note ? (
        <p className="mt-5 text-[13px] leading-relaxed text-white/55">{note}</p>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  accent = false,
  muted = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-white/55">{label}</span>
      <span
        className={
          accent
            ? "text-[var(--teal)]"
            : muted
              ? "text-white/55"
              : "text-white/90"
        }
      >
        {value}
      </span>
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-t border-white/15 pt-1.5 text-white">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const LEARN_ROWS = [
  {
    number: "GJ-1185",
    date: "04/08",
    note: "Escrita por M. Ortega",
    learned: false,
  },
  { number: "GJ-1186", date: "02/09", note: "Recordada", learned: true },
  { number: "GJ-1187", date: "06/10", note: "Recordada", learned: true },
];

function Learning() {
  return (
    <section className="mx-auto max-w-[1200px] px-5 py-24 sm:px-8 lg:py-32">
      <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
        <SectionHead
          kicker="Plan de cuentas"
          title={
            <>
              La segunda factura de un proveedor ya no se <em>piensa</em>.
            </>
          }
          intro="Cuando un gestor valida una factura, Faktury recuerda qué cuenta de proveedor y de gasto se usó para ese NIF en ese cliente. La siguiente llega con las cuentas puestas. Y si ya tenéis el plan de cuentas en Excel, se importa el primer día."
        />

        <div
          data-reveal
          style={delay(120)}
          className="rounded-2xl border border-[var(--line)] bg-white p-2 shadow-[0_40px_80px_-50px_rgb(6_42_99/0.45)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div>
              <p className="text-[14px] font-semibold">
                Gasóleos del Jalón, S.L.
              </p>
              <p className="font-mono text-[12px] text-[var(--ink-soft)]">
                B50998877 · cliente: Talleres Moncayo
              </p>
            </div>
            <span className="rounded-full bg-[#effcfb] px-2.5 py-1 text-[11.5px] font-medium text-[var(--teal-ink)] ring-1 ring-[rgb(15_134_131/0.25)]">
              3 facturas validadas
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border border-[var(--line)]">
            <div className="grid grid-cols-[1fr_0.7fr_1fr_1fr] bg-[var(--paper)] px-4 py-2 text-[11px] font-medium tracking-wide text-[var(--ink-soft)] uppercase">
              <span>Factura</span>
              <span>Fecha</span>
              <span>Proveedor</span>
              <span>Gasto</span>
            </div>
            {LEARN_ROWS.map((row) => (
              <div
                key={row.number}
                className="grid grid-cols-[1fr_0.7fr_1fr_1fr] items-center border-t border-[var(--line)] px-4 py-3 font-mono text-[12.5px] sm:text-[13px]"
              >
                <span>{row.number}</span>
                <span className="text-[var(--ink-soft)]">{row.date}</span>
                <span
                  className={`mr-2 rounded px-1.5 py-0.5 ${row.learned ? "lp-shimmer bg-[#effcfb]" : ""}`}
                >
                  400.0087
                </span>
                <span
                  className={`mr-2 rounded px-1.5 py-0.5 ${row.learned ? "lp-shimmer bg-[#effcfb]" : ""}`}
                >
                  628.0000
                </span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 px-2 pt-3 pb-2 text-[12px]">
            {LEARN_ROWS.map((row) => (
              <p
                key={row.number}
                className={`rounded-lg px-3 py-2 ${row.learned ? "bg-[#effcfb] text-[var(--teal-ink)]" : "bg-[var(--paper)] text-[var(--ink-soft)]"}`}
              >
                <span className="font-mono">{row.number}</span>
                <br />
                {row.note}
              </p>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const AUDIT = [
  {
    time: "10:42",
    who: "M. Ortega",
    what: "Base imponible",
    from: "1.204,00",
    to: "1.240,00",
  },
  {
    time: "10:43",
    who: "M. Ortega",
    what: "Estado",
    from: "Por revisar",
    to: "Validada",
  },
  {
    time: "11:05",
    who: "L. Sanz",
    what: "Cuenta gasto",
    from: "629.0000",
    to: "602.0000",
  },
  {
    time: "12:30",
    who: "Admin",
    what: "Periodo 3T 2026",
    from: "Abierto",
    to: "Cerrado",
  },
];

const CONTROLS = [
  {
    icon: Users,
    title: "Cada gestor, su cartera",
    body: "Asignas clientes a gestores. Cada uno ve su cola y nada más; el administrador lo ve todo.",
  },
  {
    icon: CalendarCheck,
    title: "Cierres de periodo",
    body: "Un periodo cerrado no se toca. El día 5 sale un recordatorio a quien tenga el mes anterior sin cerrar.",
  },
  {
    icon: History,
    title: "Auditoría que no se borra",
    body: "Quién cambió qué campo, de qué valor a cuál y cuándo. El registro rechaza cualquier edición o borrado.",
  },
  {
    icon: Lock,
    title: "Cada despacho, aislado",
    body: "Los datos de una asesoría no se cruzan nunca con los de otra. Los clientes solo ven sus propias facturas.",
  },
];

function Control() {
  return (
    <section
      id="control"
      className="scroll-mt-16 border-t border-[var(--line)] bg-[var(--paper-2)]"
    >
      <div className="mx-auto max-w-[1200px] px-5 py-24 sm:px-8 lg:py-32">
        <SectionHead
          kicker="Control"
          title={
            <>Para quien firma el modelo 303, no solo para quien lo prepara.</>
          }
          intro="Si dentro de dos años alguien pregunta por una factura, la respuesta está a tres clics: el original, quién la revisó, qué cambió y en qué lote salió hacia A3."
        />

        <div className="mt-14 grid gap-5 lg:grid-cols-[1fr_1.1fr]">
          <div className="grid gap-5 sm:grid-cols-2">
            {CONTROLS.map((item, i) => (
              <div
                key={item.title}
                data-reveal
                style={delay(i * 70)}
                className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-6"
              >
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--navy)] text-white">
                  <item.icon className="h-[18px] w-[18px]" />
                </span>
                <h3 className="mt-5 text-[16px] font-semibold tracking-tight">
                  {item.title}
                </h3>
                <p className="mt-2 text-[14px] leading-relaxed text-[var(--ink-soft)]">
                  {item.body}
                </p>
              </div>
            ))}
          </div>

          <div
            data-reveal
            style={delay(150)}
            className="flex flex-col overflow-hidden rounded-2xl border border-[#1e2a44] bg-[#0b1426] text-white"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
              <p className="flex items-center gap-2 text-[13px] font-medium">
                <ShieldCheck className="h-4 w-4 text-[var(--teal)]" /> Auditoría
                · F-2026/0412
              </p>
              <span className="font-mono text-[11px] text-white/45">
                solo añadir
              </span>
            </div>
            <ul className="flex-1 divide-y divide-white/[0.07] font-mono text-[12.5px]">
              {AUDIT.map((row, i) => (
                <li
                  key={row.time}
                  className="lp-log-row grid grid-cols-[3.2rem_1fr] gap-3 px-5 py-4"
                  style={delay(i * 600)}
                >
                  <span className="text-white/40">{row.time}</span>
                  <span className="min-w-0">
                    <span className="text-[var(--teal)]">{row.who}</span>
                    <span className="text-white/60"> cambió </span>
                    <span className="text-white">{row.what}</span>
                    <br />
                    <span className="text-white/40 line-through">
                      {row.from}
                    </span>
                    <span className="text-white/40"> → </span>
                    <span className="text-white/90">{row.to}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-white/10 px-5 py-3 font-mono text-[11.5px] text-[#fca5a5]/80">
              UPDATE &quot;AuditLog&quot; … → rechazado: el registro es de solo
              añadir
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Statement() {
  return (
    <section className="lp-grain border-y border-[var(--line)]">
      <div className="mx-auto max-w-[1000px] px-5 py-24 text-center sm:px-8 lg:py-32">
        <p
          data-reveal
          className="font-display text-[44px] leading-[1.02] sm:text-[76px]"
        >
          Faktury propone.
          <br />
          <em className="text-[var(--navy)]">Tu gestor decide.</em>
        </p>
        <p
          data-reveal
          style={delay(120)}
          className="mx-auto mt-8 max-w-[56ch] text-[17px] leading-relaxed text-[var(--ink-soft)]"
        >
          Ninguna factura llega a A3 sin que una persona del despacho la haya
          validado. No es una limitación de la máquina: es como creemos que se
          tiene que llevar una contabilidad.
        </p>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section
      id="preguntas"
      className="mx-auto max-w-[1200px] scroll-mt-16 px-5 py-24 sm:px-8 lg:py-32"
    >
      <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
        <SectionHead
          kicker="Preguntas"
          title={<>Lo que nos preguntan en todas las demos.</>}
        />
        <div
          data-reveal
          className="divide-y divide-[var(--line)] border-y border-[var(--line)]"
        >
          {FAQ.map((item) => (
            <details key={item.q}>
              <summary className="flex cursor-pointer items-center justify-between gap-6 py-5 text-[17px] font-medium transition-colors hover:text-[var(--navy)]">
                {item.q}
                <span className="lp-plus grid h-8 w-8 shrink-0 place-items-center rounded-full border border-[var(--line)] bg-white">
                  <Plus className="h-4 w-4" />
                </span>
              </summary>
              <p className="lp-faq-body max-w-[62ch] pr-12 pb-6 text-[15.5px] leading-relaxed text-[var(--ink-soft)]">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="px-3 pb-3 sm:px-5 sm:pb-5">
      <div className="relative mx-auto max-w-[1400px] overflow-hidden rounded-[28px] bg-[var(--navy)] px-6 py-20 text-center text-white sm:py-28">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage:
              "radial-gradient(ellipse 60% 70% at 50% 50%, #000 20%, transparent 75%)",
          }}
          aria-hidden
        />
        <div className="relative">
          <h2
            data-reveal
            className="font-display mx-auto max-w-[16ch] text-[44px] leading-[1] sm:text-[80px]"
          >
            El próximo trimestre, que lo{" "}
            <em className="text-[var(--teal)]">teclee</em> otro.
          </h2>
          <p
            data-reveal
            style={delay(100)}
            className="mx-auto mt-6 max-w-[48ch] text-[17px] leading-relaxed text-white/70"
          >
            Veinte minutos con vuestras propias facturas. Si no os ahorra
            tiempo, os lo diremos nosotros.
          </p>
          <div
            data-reveal
            style={delay(180)}
            className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <a
              href={DEMO_HREF}
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-white px-7 text-[15px] font-semibold text-[var(--navy)] transition-transform hover:-translate-y-px"
            >
              Pedir una demo
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <Link
              href="/login"
              className="inline-flex h-12 items-center gap-1.5 rounded-full px-6 text-[15px] font-medium text-white/80 transition-colors hover:text-white"
            >
              Ya soy cliente
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-6 px-5 py-10 text-[13px] text-[var(--ink-soft)] sm:flex-row sm:items-center sm:px-8">
      <div className="flex items-center gap-4">
        <Logo />
        <span className="hidden sm:inline">
          Facturas de clientes, listas para A3.
        </span>
      </div>
      <div className="flex items-center gap-6">
        <Link
          href="/legal"
          className="transition-colors hover:text-[var(--ink)]"
        >
          Aviso legal
        </Link>
        <Link
          href="/login"
          className="transition-colors hover:text-[var(--ink)]"
        >
          Entrar
        </Link>
        <span>© 2026 Faktury</span>
      </div>
    </footer>
  );
}
