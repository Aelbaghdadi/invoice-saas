"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// react-pdf (pdf.js) solo funciona en el navegador; `ssr: false` no vale en un
// componente de servidor, por eso este envoltorio, como PdfViewerDynamic.
const TacoSplitPicker = dynamic(() => import("./TacoSplitPicker"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-slate-500">
      <Loader2 className="h-5 w-5 animate-spin" /> Cargando el PDF del taco…
    </div>
  ),
});

export default TacoSplitPicker;
