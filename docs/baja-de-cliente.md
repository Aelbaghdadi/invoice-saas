# Baja de un cliente (borrador para revisar con el asesor)

Estado: **borrador**. La app todavía **no borra** los datos de un cliente: el
borrado y la política de retención necesitan una decisión (legal y de
negocio) y una migración. Este documento dice cómo se hace hoy una baja y
qué queda por decidir.

## Lo que ya se puede hacer desde la app

1. **Descargar sus datos.** Ficha del cliente (admin) → «Descargar los datos
   del cliente». Un ZIP con:
   - las facturas con sus líneas de IVA (JSON y CSV);
   - los originales tal como se subieron;
   - la auditoría de sus facturas (con la cadena de hash);
   - los lotes exportados a contabilidad con lo que llevó cada factura;
   - un `LEEME.txt` que explica cada fichero.

   La descarga queda en la auditoría de cada factura («Descarga de datos del
   cliente»: quién y cuándo). Tiene un límite (5.000 facturas o 1 GB de
   originales); si se pasa, la app lo dice y hay que pedirla a soporte.
2. **Entregársela al cliente** si la pide (portabilidad), por un canal seguro.
3. **Quitarle los gestores asignados** (Gestores → ficha de cada gestor →
   clientes asignados), para que deje de salir en sus pantallas.

## Lo que hoy no se puede hacer desde la app

- **Cortar el acceso al portal del cliente.** No hay pantalla para editar el
  cliente ni para desactivar su usuario: hoy es un cambio a mano en la BD
  (desvincular `Client.userId` o cambiar la contraseña de ese usuario) que
  tiene que hacer el equipo técnico.

## Lo que queda por decidir (con el asesor)

- **Qué se le entrega al cliente tal cual y qué se quita.** El ZIP es la
  copia completa, pensada para la asesoría. Lleva datos del personal de la
  asesoría y campos internos:
  - nombres y emails de los gestores y administradores en `auditoria.csv`
    (quién cambió cada cosa) y en `lotes_exportados.json` (quién exportó);
  - en `facturas.json`, campos de trabajo interno (motivos de rechazo,
    errores del OCR, candidatos de ruteo, estados intermedios).

  Si se entrega al cliente por portabilidad, hay que decidir si va así o
  una versión sin esos datos (que hoy la app no genera).

- **Cuánto tiempo se conservan los datos** tras la baja. Hay obligaciones
  de conservación de facturas y libros (fiscales y mercantiles) que fijan un
  mínimo; el asesor tiene que confirmar el plazo que aplica a cada caso.
- **Quién decide el borrado** y cómo se registra (la auditoría actual es por
  factura y no se puede borrar: el trigger de inmutabilidad lo impide).
- **Qué se borra**: originales en Garage, facturas, auditoría, lotes
  exportados. Borrar la auditoría rompe la cadena de hash a propósito;
  habría que dejar constancia del borrado en otro sitio.
- **Copias de seguridad**: los datos borrados siguen en los backups hasta
  que caducan; hay que decir cuánto.

## Lo que hará falta en la app

- Un estado de cliente dado de baja (hoy no existe; necesita columna).
- El borrado, con su propia traza, cuando esté decidida la política.
