import Link from "next/link";

export function LegalDisclaimer() {
  return (
    <div className="border-t border-slate-200/60 bg-white px-4 py-2.5 text-center text-[11px] text-slate-400">
      Faktury es un asistente de productividad. Los datos OCR deben ser revisados por un profesional.{" "}
      <Link href="/legal" className="underline decoration-slate-300 underline-offset-2 transition-colors hover:text-slate-600">
        Aviso legal
      </Link>
    </div>
  );
}
