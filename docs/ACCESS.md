# Acceso, roles y paradata

## Roles

| Rol | Quién | Qué puede |
|---|---|---|
| **Super admin** | `hermanelgueta@gmail.com`, `herman.elgueta@umag.cl` (lista fija en `firestore.rules` → `isAdmin()` y `js/access.js`) | Todo: todas las encuestas, la paradata, `super.html`, permisos de cuentas, borrar encuestas. |
| **Staff** | Cuenta de Google verificada `@umag.cl`, o una dirección con excepción (`access/<email>.exempt`) | Crear encuestas (queda como *responsable*), editar las suyas, ver las **respuestas** de las suyas y de las que le compartieron, dar acceso a colegas `@umag.cl`. |
| **Colega** | Documento `collab/<surveyId>__<email>` con rol `viewer` (ve respuestas) o `editor` (además edita la encuesta) | Solo esa encuesta. |
| **Visor heredado** | `surveys/<id>.adminEmails` | Ve respuestas de esa encuesta. Solo la administración edita esta lista. |
| Cualquier otra cuenta | — | Nada, salvo responder encuestas publicadas. |

Todo se aplica en `firestore.rules` (servidor); las páginas solo reflejan lo que las reglas permiten.
Para contar como cuenta válida el token debe ser de Google (`sign_in_provider == google.com`) y tener
`email_verified`; el dominio se compara con `^…@umag\.cl$` (no sirven `x@umag.cl.evil.com` ni `x@xumag.cl`).

## Paradata separada de las respuestas

Cada respuesta se guarda como **dos documentos**, escritos juntos en un batch atómico:

- `responses/<survey>/entries/<id>` — `answers`, `audio` (metadatos), `consentId`, `presentationOrder`, `createdAt`.
- `responses/<survey>/paradata/<id>` — todo lo demás: tiempos, dispositivo/navegador, `interviewer`, `events`
  (registro de interacción), `missTapCount`, `geo`, `serverCode`, etc. (`js/paradata.js`).

Solo lo lee quien tenga **ambas** cosas: acceso a la encuesta y `access/<email>.paradata == true`
(se concede en `super.html`; los super admins siempre). Sin ese permiso, `admin.html` muestra las respuestas,
avisa que faltan los datos técnicos y oculta los exports técnicos.

**Limitación honesta:** las respuestas guardadas *antes* de esta separación traen la paradata dentro del
mismo documento. Ahí el ocultamiento es solo de la interfaz (`stripParadata`); un visor técnico podría leerla
directo de Firestore. Para cerrarlo hay que migrar esas respuestas (mover los campos a `paradata/` y borrarlos
de `entries/`), algo que solo un super admin debería hacer. Pendiente.

## Colegas y excepciones

- La persona responsable agrega colegas desde el constructor, **solo `@umag.cl`** (las reglas validan el
  correo con el id del documento, no se puede saltar desde el navegador).
- Una cuenta que no es `@umag.cl` entra por una de dos vías, ambas solo de la administración: excepción global
  (`access.exempt`, puede crear encuestas) o acceso puntual a una encuesta (`collab` creado desde `super.html`).

## Seguridad: lo que hay que tener presente

1. **El contenido de una encuesta es código ajeno.** Ahora lo escribe cualquier staff y se muestra en el mismo
   origen que el admin. Por eso el texto pasa por una lista blanca de HTML (`js/sanitize.js`) y las páginas de
   participantes llevan una CSP que impide scripts propios o inline. No quites ninguna de las dos.
2. **Publicar es poder recolectar datos a nombre del laboratorio.** Hoy cualquier staff publica sin revisión.
   Si se quiere un filtro, el siguiente paso es un campo `approved` que solo la administración puede marcar y
   que las reglas exijan para aceptar respuestas.
3. **Borrar encuestas es solo de la administración** (las respuestas cuelgan de ella). El staff despublica.
4. **Los IDs de encuesta son globales.** Si alguien elige uno ya usado, el guardado falla (mensaje en el constructor).
5. **Cuotas:** las reglas hacen `get()`/`exists()` por operación; el uso de Firestore crece con el número de
   encuestas y personas. Conviene un presupuesto/alerta en Firebase y, antes de campo masivo, App Check.
6. **Las listas de super admins están en dos sitios** (`firestore.rules` y `js/access.js`); cámbialas juntas.
