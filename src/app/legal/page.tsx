export default function LegalPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-bold text-slate-800">Aviso legal</h1>

      <div className="mt-6 space-y-6 text-[14px] leading-relaxed text-slate-600">
        <section>
          <h2 className="text-lg font-semibold text-slate-700">Naturaleza del servicio</h2>
          <p className="mt-2">
            FacturOCR es una herramienta de <strong>asistencia a la productividad</strong> para
            despachos de asesoria fiscal y contable. El sistema utiliza tecnologia de reconocimiento
            optico de caracteres (OCR) basada en inteligencia artificial para extraer datos de
            facturas y facilitar su gestion.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-700">Limitacion de responsabilidad</h2>
          <p className="mt-2">
            Los datos extraidos automaticamente por el motor OCR son <strong>orientativos</strong> y
            deben ser siempre revisados y validados por un profesional cualificado antes de su uso
            contable o fiscal. FacturOCR no sustituye el criterio profesional del asesor.
          </p>
          <p className="mt-2">
            El usuario es el unico responsable de verificar la exactitud de los datos antes de
            exportarlos o utilizarlos en cualquier declaracion fiscal, registro contable u otro
            documento oficial.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-700">Precision del OCR</h2>
          <p className="mt-2">
            El sistema muestra indicadores de confianza para cada campo extraido. Un indicador
            alto no garantiza la correccion del dato. Campos con baja confianza requieren
            especial atencion por parte del revisor.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-700">Proteccion de datos</h2>
          <p className="mt-2">
            Los documentos subidos y los datos extraidos se almacenan de forma segura y se
            procesan exclusivamente para la finalidad descrita. El acceso a los datos esta
            restringido a los usuarios autorizados de la asesoria correspondiente.
          </p>
        </section>
      </div>
    </div>
  );
}
