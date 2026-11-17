# RDP · Escorial · API

Cloudflare Worker + Neon (Postgres) para la plataforma de Resolución de Problemas de Escorial
([RDP-Escorial](https://github.com/diegortizdao-collab/RDP-Escorial)): A3 · A4 · 5 Porqués, impacto económico, registro de acciones y administración.
Mismo patrón que `Evaluacion-RDP-API` y `PlanillasdeControlAPI`.

## Qué resuelve
- **RDP** con herramienta elegida (A3 / A4 / 5 Porqués), paso actual (0–8) y fase PDCA (0–5 = P · 6 = D · 7 = C · 8 = A).
- **Contenido de cada paso** del formato FR-MCO como JSON (`rdp_paso`), mediciones del indicador y evidencias (enlaces).
- **Impacto**: pérdidas *estándar* (matriz de costos versionada) o *libres* (costos indirectos, con criterio de cálculo).
  Cada pérdida guarda el costo vigente al cargarla. Ahorro = pérdida antes − después (vista `rdp_impacto_v`):
  con cantidades «después» medidas si existen, o derivado de la variación del indicador físico.
- **Acciones** (contención, contramedida, estandarización, yokoten) **sin flujo de aprobación**: al asignar un responsable le llega un correo.
- **Dos roles**: `Administrador` (usuarios, matriz de costos, áreas, estructura, correo, auditoría) y `Usuario`.
  El responsable de una acción puede informar su avance aunque no edite el RDP.
- **Auditoría** (`rdp_log`) y **bandeja de salida de correos** (`rdp_correo`).

## Endpoints (JSON)
| Método y ruta | Quién | Para qué |
|---|---|---|
| `GET /` | público | estado del Worker |
| `GET /me`, `GET /bootstrap` | usuario | sesión, áreas, estructura Planta·UET·Sector, matriz, usuarios |
| `GET /rdp`, `GET /rdp/:id` | usuario | listado con impacto, pérdidas y acciones / detalle con pasos, mediciones y evidencias |
| `POST /rdp` | usuario | crear RDP (con pérdidas del Paso 0) |
| `PATCH /rdp/:id` | líder, creador o admin | paso, herramienta, indicador, cierre |
| `PUT /rdp/:id/paso/:n` | líder, creador o admin | guardar los campos del paso n |
| `POST /rdp/:id/mediciones` | líder, creador o admin | evolución del indicador |
| `POST /rdp/:id/perdidas`, `PATCH`/`DELETE /perdidas/:id` | líder, creador o admin | calculadora de impacto |
| `POST /rdp/:id/acciones` | líder, creador o admin | nueva acción + correo al responsable |
| `PATCH /acciones/:id` | responsable (avance) o editor | avance, texto, compromiso, inversión |
| `POST /rdp/:id/evidencias` | líder, creador o admin | enlace https (SharePoint, fotos…) |
| `POST /usuarios`, `PATCH /usuarios/:email` | admin | alta (con correo de invitación), rol, baja |
| `POST /matriz`, `POST /matriz/:id/versiones`, `PATCH /matriz/:id` | admin | conceptos y costos con vigencia (no pisa versiones) |
| `POST /areas`, `POST /estructura` | admin | catálogos |
| `GET /admin/correo`, `POST /admin/correo/reintentar`, `GET /admin/log` | admin | bandeja de salida y auditoría |

## Puesta en marcha
1. **Neon**: crear el proyecto *RDP Escorial* y correr `schema.sql` y después `seed.sql` (son idempotentes).
   El seed carga las 29 áreas, la estructura de plantas, el primer administrador (`dortiz@escorial.com.ar`) y la matriz de costos
   migrada de Kaizenio — **reemplazar con la matriz oficial de Escorial**.
2. **Cloudflare** (Workers & Pages → Import a repository → `RDP-Escorial-API`): nombre `rdp-escorial-api`.
3. Secretos (Settings → Variables and secrets): `NEON_URL` y `APP_KEY` (modo piloto).
4. Copiar la URL del Worker a `config.js` → `API_URL` en el repo `RDP-Escorial`.

## Autenticación
- `AUTH_MODE="pilot"` (por defecto): clave compartida `X-App-Key` + `X-User-Email`. **Solo para pruebas internas**:
  quien conozca la clave puede hacerse pasar por otro usuario.
- `AUTH_MODE="entra"` (producción): la app obtiene un token de Microsoft Entra ID (MSAL) y el Worker lo valida contra las
  claves públicas de Microsoft (firma, emisor, audiencia, vencimiento); el usuario se identifica por su correo de Escorial
  y debe estar dado de alta y activo en `rdp_usuarios`. Variables: `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`.

## Correo con Microsoft 365 (pendiente de IT)
Se envía con Microsoft Graph (`sendMail`) desde un buzón de Escorial. Hasta que IT lo habilite, `MAIL_ENABLED="0"` y todos los
mensajes quedan en `rdp_correo` como *pendiente* (nada se pierde). Pedido a IT:
1. Buzón remitente (`MAIL_FROM`, ej. `rdp@escorial.com.ar`).
2. App registrada en Entra ID con permiso de aplicación `Mail.Send` **restringido a ese buzón** (Application Access Policy);
   pasar `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` y el secreto → `MS_CLIENT_SECRET`.
3. La misma app sirve para el inicio de sesión (`AUTH_MODE="entra"`, redirect URI = la URL de GitHub Pages).

Con eso: `MAIL_ENABLED="1"` y, desde un administrador, `POST /admin/correo/reintentar` envía lo acumulado.

## Probado
Esquema + Worker se probaron de punta a punta sobre Postgres (31 verificaciones: permisos por rol, matriz versionada, cálculo de ahorro
por indicador y por cantidades medidas, correos en bandeja, último administrador, etc.).

---
Desarrollado por Mgter. Diego Ortiz — Líder de Mejora Continua | Consultor ISO
