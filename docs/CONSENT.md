# Consentimiento y retiro

Se activa por encuesta en el constructor (*Consentimiento y retiro*): nivel (`anonymous` / `personal` /
`sensitive`), ID del ítem de consentimiento y contacto responsable. Código en `js/consent.js`.

**Idea central: un comprobante en vez de una identidad.** No sabemos quién responde y no queremos pedir
documentos solo para esto. Al enviar, la persona recibe un código de 16 caracteres (QR, enlace, descarga):

- `proof = sha256("samplux-consent-v1:" + código)`, `consentId = sha256(proof)`.
- Firestore guarda solo `consentId` (`consents/<consentId>`) con: encuesta, texto exacto aceptado + su hash,
  nivel, fecha, ítems de audio, y luego el retiro. El código nunca sale del dispositivo de la persona.
- Retirar = mandar el `proof`; las reglas comprueban `sha256(proof) == consentId`. Nadie puede retirar (ni
  siquiera consultar) el consentimiento de otra persona sin su código.
- Al retirar se **borran** respuestas, paradata y audio; queda un registro mínimo (encuesta, fecha de
  consentimiento y de retiro) como prueba de cumplimiento. Una respuesta encolada sin conexión que llegue
  después del retiro es rechazada.
- Sin código: `retirar.html` ofrece una solicitud manual; el equipo la resuelve en `retiros.html`
  (busca el correo en las respuestas, pide confirmación a ese correo y luego borra).

Probar: `docs/ENCUESTADOR.md` (sección *Probar*) y `npm test` / `npm run test:rules`.
Marco legal (Ley 21.719): revisar con asesoría jurídica — ver `docs/DATA-POLICY.md`.
