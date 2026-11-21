# Baja de un cliente (borrador para revisar con el asesor)

Estado: **borrador**. La app **no borra** los datos de un cliente: desde la
migración 12 (archivo de facturas), unos triggers en la base de datos impiden
borrar sus facturas, documentos y originales (solo se puede en la asesoría de
demostración). Una baja, por tanto, **exporta, entrega y bloquea**. Este
documento dice cómo se hace hoy y qué queda por decidir.

## Lo que ya se puede hacer desde la app

1. **Descargar el archivo de cada ejercicio: es lo que se entrega al
   cliente.** Ficha del cliente (admin) → pestaña «Archivo» → elegir el
   ejercicio → «Descargar el ejercicio (ZIP)». Un ZIP por ejercicio con:
   - los originales tal como llegaron (el PDF, el XML o la foto; un Word o un
     Excel adjunto, con su copia en PDF), por periodo de deducción y con su nº
     de registro del archivo en el nombre (`sin-registrar/` los que aún no se
     han exportado);
   - `indice.xlsx`, con una fila por factura en el orden del archivo: nº de
     registro, fechas, tercero, importes, electrónico o papel, «conservar
     hasta» y la huella SHA-256 de cada original;
   - un `LEEME.txt` que lo explica, y `ERRORES.txt` si falta algún original o
     no coincide con lo que se subió.

   No lleva la auditoría, notas internas ni nombres o correos del personal de
   la asesoría. Las rechazadas solo van si se marca «Incluir las rechazadas».
   Cada descarga queda en la auditoría de sus facturas («Descarga del archivo
   del ejercicio»: quién y cuándo). Tiene los mismos límites que la descarga de
   datos (5.000 facturas o 1 GB); si un ejercicio no cabe, la app lo dice y se
   descarga por trimestres.
2. **Descargar todos sus datos** (copia completa, para la asesoría). Ficha del
   cliente (admin) → «Descargar los datos del cliente». Un ZIP con:
   - las facturas con sus líneas de IVA (JSON y CSV);
   - los originales tal como se subieron, y los adjuntos en Word, Excel u
     OpenDocument;
   - la auditoría de sus facturas (con la cadena de hash);
   - los lotes exportados a contabilidad con lo que llevó cada factura;
   - un `LEEME.txt` que explica cada fichero.

   La descarga queda en la auditoría de cada factura («Descarga de datos del
   cliente»: quién y cuándo). Tiene un límite (5.000 facturas o 1 GB de
   originales); si se pasa, la app lo dice: se descarga el archivo de cada
   ejercicio o se pide a soporte. Lleva datos internos (ver abajo): no es lo
   que se entrega al cliente.
3. **Entregar al cliente el ZIP de cada ejercicio** (punto 1) por un canal
   seguro.
4. **Quitarle los gestores asignados** (Gestores → ficha de cada gestor →
   clientes asignados), para que deje de salir en sus pantallas.

## Lo que hoy no se puede hacer desde la app

- **Cortar el acceso al portal del cliente.** La ficha del cliente no deja
  desactivar su usuario: hoy es un cambio a mano en la BD
  (desvincular `Client.userId` o cambiar la contraseña de ese usuario) que
  tiene que hacer el equipo técnico.

## Lo que queda por decidir (con el asesor)

- **Si al cliente le basta con el ZIP de cada ejercicio.** Es lo que se le
  entrega: sus facturas y sus originales, sin datos internos. La descarga de
  todos sus datos es la copia completa, pensada para la asesoría, y lleva
  datos del personal de la asesoría y campos internos:
  - nombres y emails de los gestores y administradores en `auditoria.csv`
    (quién cambió cada cosa) y en `lotes_exportados.json` (quién exportó);
  - en `facturas.json`, campos de trabajo interno (motivos de rechazo,
    errores del OCR, candidatos de ruteo, estados intermedios).

  Si el cliente pidiera algo más que sus facturas (por ejemplo, el historial
  de cambios), habría que decidir qué se le da de esa copia y quitar antes
  esos datos (hoy la app no genera esa versión).

- **Cuánto tiempo se conservan los datos** tras la baja. Hay obligaciones
  de conservación de facturas y libros (fiscales y mercantiles) que fijan un
  mínimo. La pestaña «Archivo» ya enseña, por factura, «Conservar hasta»: 6
  años desde el cierre del ejercicio del cliente, o sin fecha si se marca
  «Conservar más» (inmovilizado, bases negativas, una inspección…). Es
  informativo: la app no borra nada al llegar esa fecha. El asesor tiene que
  confirmar el plazo que aplica a cada caso.
- **Quién decide el borrado** y cómo se registra (la auditoría actual es por
  factura y no se puede borrar: el trigger de inmutabilidad lo impide).
- **Qué se borra**: originales en Garage, facturas, auditoría, lotes
  exportados. Borrar la auditoría rompe la cadena de hash a propósito;
  habría que dejar constancia del borrado en otro sitio.
- **Copias de seguridad**: los datos borrados siguen en los backups hasta
  que caducan; hay que decir cuánto.

## Lo que hará falta en la app

- Un estado de cliente dado de baja (hoy no existe; necesita columna).
- El borrado (o la purga al pasar el «conservar hasta»), con su propio camino y
  su traza, cuando esté decidida la política. Hoy los triggers de la migración
  12 lo impiden a propósito, y no se esquivan: ver ARCHITECTURE.md → Archivo de
  facturas.
