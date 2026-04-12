import Link from "next/link";

export function LegalDisclaimer() {
  return (
    <div className="text-center text-[11px] text-slate-400 py-2">
      FacturOCR es un asistente de productividad. Los datos OCR deben ser revisados por un profesional.{" "}
      <Link href="/legal" className="underline hover:text-slate-600">
        Aviso legal
      </Link>
    </div>
  );
}
