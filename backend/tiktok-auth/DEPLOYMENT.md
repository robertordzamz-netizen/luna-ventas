# Despliegue verificado — 28 de octubre de 2026

Estado: backend desplegado y validado por HTTPS. Listo para registrar el callback Web. Pendiente registrar la URI en TikTok Developers y completar consentimiento/canje con una cuenta real autorizada. No se ha publicado contenido.

## Identidad del despliegue

- Proyecto: `luna-cloud-510719` (`852600734493`).
- Región: `us-central1`.
- Servicio existente: `luna-ventas-tiktok-auth`, UID `181aec82-ed89-4093-8f2a-323529d16fe4`.
- Revisión: `luna-ventas-tiktok-auth-oauth-e526eab2`, 100 % del tráfico, Ready=True.
- Commit de código ejecutado: `e526eab2558fb9de7f5fe7db06077f2ba47bbd91`.
- Imagen: `us-central1-docker.pkg.dev/luna-cloud-510719/luna-ventas-tiktok-auth/oauth@sha256:1502d82a617a042b213b2041afcdd3e4b73bd7c1c636e43186869d7e3b9aecba`.
- Cloud Build exitoso: `166b225b-24f4-4432-98c7-84e534716fa4`.
- Identidad de ejecución: `luna-ventas-tiktok-auth@luna-cloud-510719.iam.gserviceaccount.com`.
- Secretos: `luna-ventas-tiktok-client-key:1`, `luna-ventas-tiktok-client-secret:1`, `luna-ventas-tiktok-token-encryption:1`. Sin valores en el repositorio ni en esta evidencia.
- Depósito: `gs://luna-ventas-tiktok-auth-852600734493`, us-central1, acceso uniforme y prevención de acceso público enforced.
- Recursos de ejecución: máximo dos instancias, mínimo cero, concurrencia 20, timeout 30 segundos, proceso Node.js 22 sin privilegios.

## URL exacta para Login Kit Web

`https://luna-ventas-tiktok-auth-852600734493.us-central1.run.app/auth/tiktok/callback`

Es estática, HTTPS, sin parámetros ni fragmentos. Abrirla directamente devuelve 400 `invalid_state`: es el rechazo esperado de un callback sin una autorización iniciada en el mismo navegador.

Inicio después de registrar la URI:

`https://luna-ventas-tiktok-auth-852600734493.us-central1.run.app/auth/tiktok/start`

Salud pública:

`https://luna-ventas-tiktok-auth-852600734493.us-central1.run.app/health`

## Evidencia

Smoke test en la URL definitiva ejecutado el **28-10-2026 a las 13:57:58, America/Mexico_City** (`2026-10-28T19:57:58.913Z`):

| Comprobación | Resultado |
| --- | --- |
| HTTPS real y salud `/health` | 200, JSON del backend |
| Inicio OAuth | 302 al endpoint oficial TikTok |
| URI de callback enviada | Coincide exactamente con la URI anterior |
| Scope | Solamente `user.info.basic` |
| Callback sin state | 400 `invalid_state` |
| Callback con state y sin cookie | 400 `invalid_state` |
| Override de redirección | 400 `invalid_request` |
| Denegación simulada con estado válido | 400 `authorization_denied`, estado consumido |
| Repetición del mismo estado | 400 `invalid_state` |
| Cookie | `__Host-`, HttpOnly, Secure, SameSite=Lax |

Validaciones adicionales:

- **13/13 pruebas** en Node.js 22; chequeo de sintaxis correcto; `npm audit --omit=dev`: cero vulnerabilidades reportadas para las dependencias.
- Adaptador real de Cloud Storage: dos adaptadores y ocho consumidores concurrentes, **un solo consumo exitoso**; vínculo de navegador incorrecto rechazado; escritura y lectura cifrada verificadas; escritura con generación obsoleta rechazada. Solo se usaron datos sintéticos bajo un espacio de verificación aleatorio; sus objetos activos se retiraron al terminar.
- Verificación desde la identidad de ejecución de Cloud Run: creación, lectura y consumo de estado real en el depósito, denegación simulada y rechazo de repetición.
- Acceso anónimo al listado del depósito rechazado con 401.
- Identidad de ejecución sin roles de proyecto; acceso `roles/storage.objectUser` solamente en su depósito y `roles/secretmanager.secretAccessor` solamente en sus tres secretos.
- Exclusión `luna-ventas-tiktok-oauth-request-privacy` verificada en el sink `_Default`, limitada a registros automáticos de solicitudes de este servicio en `/auth/tiktok/`. Consulta posterior no encontró registros de esas solicitudes desde la activación. No cambia registros de otros servicios, eventos de aplicación ni auditoría.

## Servicios preservados

Se compararon UID, generación y última revisión lista antes y después:

| Servicio | Generación | Revisión preservada |
| --- | --- | --- |
| `luna-syscom-gateway` | 7 | `luna-syscom-gateway-00007-j4k` |
| `systemeets-web` | 2 | `systemeets-web-00002-fdv` |

El servicio OAuth existía y aparecía listo, pero usaba `gcr.io/cloudrun/placeholder`; no había backend OAuth desplegado. Se sustituyó únicamente ese servicio.

## Operación

1. Registrar la URI anterior en **Login Kit Web** de la misma aplicación y entorno TikTok al que pertenecen los secretos.
2. Iniciar autorización desde `/auth/tiktok/start` en el mismo navegador que recibirá el callback. No abrir el callback directamente para probar un login.
3. Conceder solo los scopes aprobados. La implementación no solicita permisos de publicación.
4. Confirmar respuesta `connected` y evento de aplicación `tiktok_authorization_stored`, sin consultar ni copiar valores de tokens. Esta validación real queda pendiente del registro y consentimiento de TikTok.
5. No integrar estos tokens con el panel local sin autorización de usuario propia del panel, desconexión/revocación y política de retención. El refresh interno está implementado y probado con simulaciones, pero aún no existe un consumidor de API ni una tarea periódica.

Para verificar nuevamente las rutas públicas: `node scripts/smoke.js` desde este directorio. Consume un inicio del presupuesto global de 20/hora y simula una denegación sin contactar el endpoint de tokens.

La ruta pública de salud es `/health`; `/healthz` fue interceptada por la infraestructura de Google en las pruebas y no se usa para validación pública.

Para volver temporalmente a la revisión provisional previa (no ofrece OAuth), ejecutar en una sesión autorizada:

```powershell
gcloud run services update-traffic luna-ventas-tiktok-auth --project=luna-cloud-510719 --region=us-central1 --to-revisions=luna-ventas-tiktok-auth-00001-xqf=100
```

Mantener el PR sin fusionar hasta la revisión del código. El despliegue del backend no cambia el sitio de GitHub Pages.

