# Recolección ética de datos en samplux — marco técnico y de políticas

Objetivo: poder recoger **mucha** información cuando un estudio la necesita (comportamiento, dispositivo,
ubicación, sensores, incluso datos que las plataformas ya acumulan sobre las personas), pero **solo con
consentimiento específico, con una finalidad declarada y con salida fácil**. Esto es una guía técnica para
discutir con asesoría jurídica y el comité de ética; no es asesoría legal.

## 1. Principios

1. **Mínimo por defecto, más solo por diseño de estudio.** Cada dato extra se activa por encuesta, apagado de
   fábrica, y se justifica en el protocolo.
2. **Declarado antes de recoger.** Lo que se recoge se deriva de la definición de la encuesta
   (`js/manifest.js`), no de lo que alguien recuerde escribir en el texto de consentimiento.
3. **Consentimiento específico y graduado**: no basta un "acepto" general para ubicación precisa, voz o sensores;
   cada categoría sensible debería tener su propio permiso (el navegador ya exige el suyo).
4. **Retiro tan fácil como el consentimiento** (ya implementado: `docs/CONSENT.md`).
5. **Separación**: respuestas, paradata y identificadores viven en documentos distintos con permisos distintos
   (`docs/ACCESS.md`).
6. **Retención limitada**: cada estudio define cuánto se guarda cada categoría y qué pasa después.

## 2. Qué recogemos hoy

| Categoría | Datos | Dónde | Activación |
|---|---|---|---|
| Respuestas | ítems, tareas cognitivas, audio | `entries/`, `audio/` | siempre (el estudio) |
| Paradata de uso | tiempos, retrocesos, cambios de respuesta, cambios de pestaña | `paradata/` | siempre |
| Interacción | toques fuera de botones, entrada a ítems, rotación | `paradata.events` | `settings.paradata` (por defecto sí) |
| Dispositivo | UA, pantalla, idioma, zona horaria, conexión, hardware | `paradata` | `settings.collect.deviceInfo` (por defecto sí) |
| Ubicación | GPS aproximado (~1 km) o preciso, con permiso del navegador | `paradata.geo` | `settings.collect.geolocation` (por defecto no) |
| Modo encuestador | código, lugar, caso, vista | `paradata.interviewer` | solo en `encuestador.html` |
| Consentimiento | texto aceptado, nivel, fechas | `consents/` | `settings.consent` |

La IP del participante **no** se registra (un sitio estático no la ve).

## 3. Ideas que caben en la arquitectura actual (estático + Firestore)

- **Ubicación por IP:** exige llamar a un servicio de terceros (el servicio ve la IP del participante).
  Alternativa sin terceros: zona horaria + idioma (ya se recogen) dan una región gruesa. Si se hace, debe
  declararse como transferencia a un tercero. No implementado a propósito.
- **Sensores de movimiento/orientación** (`DeviceMotionEvent`, `DeviceOrientationEvent`): se leen desde JS con un
  permiso explícito en iOS. Una sesión corta (segundos, ≤ 60 Hz) cabe en Firestore comprimida y troceada en
  una subcolección; sesiones largas o de alta frecuencia **no**: el límite de 1 MiB por documento y el costo por
  escritura lo impiden. Para eso hay que pasar a almacenamiento de archivos (Cloud Storage) con subida por
  trozos, o a una app. No hace falta una app nativa para acelerómetro/giroscopio en el navegador del
  teléfono; sí para sensores que el navegador no expone (frecuencia alta estable, fondo, salud, BLE).
- **Dinámica de toque** (presión, radio de contacto, tiempo entre toques): disponible en `PointerEvent`; es
  biométrica en la práctica → tratar como dato sensible y recoger solo con consentimiento específico.
- **Escritura** (ritmo de teclas): muy sensible; solo tiempos agregados, nunca el contenido de las teclas.
- **Cámara/micrófono continuos, reconocimiento facial, huella del navegador (fingerprinting):** no recomendados;
  el fingerprinting además contradice la idea de consentimiento informado.
- **Donación de datos ("data donation")** — la vía ética para tener lo que las redes sociales guardan sobre las
  personas: la persona descarga *su propio* archivo desde la plataforma (Google Takeout, Instagram/Facebook
  "Descargar tu información", TikTok, Spotify…) y lo entrega al estudio. Con consentimiento específico,
  filtrado en su navegador (se suben solo los campos acordados, sin terceros) y con retiro. Se puede construir
  como un ítem `donation` que lee un ZIP/JSON local, aplica un filtro declarado y muestra una **vista previa**
  de lo que se enviará. Es el modelo de proyectos como OSD2F / Data Donation Module. No requiere acceder a la
  cuenta de nadie ni usar APIs de las plataformas.
- **Entorno de laboratorio:** ahí conviene una app local (o estación fija) que escriba a almacenamiento del
  laboratorio, con consentimiento presencial firmado; el navegador queda para campo.

## 4. Políticas y documentos que hay que tener

1. **Registro de actividades de tratamiento** (una fila por estudio): responsable, finalidad, base de licitud,
   categorías de datos, ¿datos sensibles?, destinatarios, transferencias, plazo de retención, medidas de
   seguridad, quién accede (`super.html` ya muestra una parte: responsable, administradores, consentimiento).
2. **Aviso de privacidad / ficha de recolección** por estudio, generada desde `collectionManifest()` +
   texto del protocolo: qué se recoge (lenguaje claro), para qué, quién lo ve, cuánto se guarda, cómo retirar.
3. **Términos de uso de la plataforma** para quienes crean encuestas (staff): solo fines de investigación
   aprobados; datos sensibles exigen consentimiento registrado y nivel `sensitive`; prohibido recoger lo no
   declarado; obligación de respetar los retiros; confidencialidad de la paradata; reporte de incidentes.
4. **Política de retención y eliminación**: plazos por categoría (p. ej. audio hasta transcribir; paradata N
   años; respuestas según protocolo) y un procedimiento de borrado verificable.
5. **Procedimiento de derechos** (acceso, rectificación, supresión, oposición, portabilidad): hoy retiro con
   código + solicitud manual; falta el flujo de acceso/portabilidad.
6. **Gestión de incidentes** (brecha): quién decide, plazo de aviso, plantilla.
7. **Evaluación de impacto** para estudios con datos sensibles, ubicación precisa o sensores.

## 5. Siguiente trabajo sugerido

1. Generar la **ficha de recolección** (HTML/PDF) por estudio desde el manifiesto y mostrarla en la pantalla de
   consentimiento, con casillas separadas para cada categoría opcional.
2. **Migrar** las respuestas antiguas al esquema con paradata separada.
3. Campo `approved` (revisión de la administración antes de aceptar respuestas) para estudios con datos sensibles.
4. Módulo de **sensores** para sesiones cortas, con subida troceada.
5. Ítem de **donación de datos** con filtrado y vista previa en el navegador.
6. Retención automática (borrado/anonimización programada) y exportación de derechos de acceso.
