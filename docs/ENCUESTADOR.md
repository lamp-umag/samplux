# Modo encuestador (`encuestador.html`)

Para aplicar una encuesta cara a cara en tablet o computador. Usa el mismo motor que `encuesta.html`.

- **Carrusel** de tarjetas, horizontal o vertical. Borde claro y punteado = aún no vista; punteado grueso =
  vista y sin responder; sólido grueso = respondida; recuadro grueso = la actual. Un contador "N sin responder"
  lleva a la primera pendiente; la pantalla de envío lista lo que falta y bloquea si faltan obligatorias.
- **Traspaso**: ítems marcados "Privada" y todas las tareas cognitivas pasan a una pantalla solo para la persona
  encuestada y se ocultan después a quien encuesta.
- **Sin conexión**: la app se guarda en el dispositivo (service worker `sw.js`) y cada caso se guarda primero
  en IndexedDB (`js/outbox.js`); se sube al volver internet. "Respaldo (.json)" exporta lo pendiente.
- **Datos**: cada respuesta lleva `interviewer` (código, lugar, sesión, n.º de caso, vista, saltos, ítems en
  traspaso) en su paradata → columnas `interviewer_*` del CSV; `null`/0 si fue autoadministrada.
- **Tarjetas**: *compactas* (título de las vecinas) o *superpuestas* (las vecinas son tarjetas completas, con sus
  opciones y lo respondido, que se tapan en parte; tocas una y pasa al centro), en horizontal o vertical.
- **Laboratorio** (`encuestador-lab.html`): una encuesta de mentira para ajustar ancho, solapamiento, escala,
  opacidad, borde, texto… Puedes dejar los valores en ese dispositivo o **descargar un zip** (`preferencias.json`,
  `notas.md`, `snapshot.html`) para compartirlos y fijarlos como valores por defecto.
- **Replay** (`viewer.html`, administración): si la respuesta trae el registro de eventos, la línea de tiempo se
  reconstruye desde él, así que los saltos y las vueltas del modo encuestador se reproducen tal como ocurrieron
  ("visita 2" de una pregunta, 🤝 en los traspasos) y los toques fuera de botones aparecen como puntos.
- Teclado: 1–9 opción, Enter sigue, ← → cambian de pregunta.

## Probar

```bash
npx firebase-tools emulators:start --only firestore --project samplux-lamp   # terminal 1
npm start                                                                     # terminal 2
npm run seed                                                                  # terminal 3 (puerto 8080)
# abrir: http://localhost:5175/encuestador.html?survey=piloto&emulator=8080
#        http://localhost:5175/?survey=piloto&emulator=8080         (flujo del participante + comprobante)
#        http://localhost:5175/retirar.html?emulator=8080            (retiro con el código)
npm test && npm run test:rules
```
