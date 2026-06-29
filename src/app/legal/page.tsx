export default function LegalPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-bold text-slate-800">Aviso legal</h1>

      <div className="mt-6 space-y-6 text-[14px] leading-relaxed text-slate-600">
        <section>
          <h2 className="text-lg font-semibold text-slate-700">Naturaleza del servicio</h2>
          <p className="mt-2">
            Faktury es una herramienta de <strong>asistencia a la productividad</strong> para
            despachos de asesoría fiscal y contable. El sistema utiliza tecnología de reconocimiento
            óptico de caracteres (OCR) basada en inteligencia artificial para extraer datos de
            facturas y facilitar su gestión.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-700">Limitación de responsabilidad</h2>
          <p className="mt-2">
            Los datos extraídos automáticamente por el motor OCR son <strong>orientativos</strong> y
            deben ser siempre revisados y validados por un profesional cualificado antes de su uso
            contable o fiscal. Faktury no sustituye el criterio profesional del asesor.
          </p>
          <p className="mt-2">
            El usuario es el único responsable de verificar la exactitud de los datos antes de
            exportarlos o utilizarlos en cualquier declaración fiscal, registro contable u otro
            documento oficial.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-700">Precisión del OCR</h2>
          <p className="mt-2">
            El sistema muestra indicadores de confianza para cada campo extraído. Un indicador
            alto no garantiza la corrección del dato. Campos con baja confianza requieren
            especial atención por parte del revisor.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-700">Protección de datos</h2>
          <p className="mt-2">
            Los documentos subidos y los datos extraídos se almacenan de forma segura y se
            procesan exclusivamente para la finalidad descrita. El acceso a los datos está
            restringido a los usuarios autorizados de la asesoría correspondiente.
          </p>
        </section>
      </div>
    </div>
  );
}
