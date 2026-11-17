-- RDP · Escorial — esquema Neon (Postgres). Idempotente: se puede correr más de una vez.

-- ───────── Catálogos ─────────
CREATE TABLE IF NOT EXISTS rdp_areas (
  nombre TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS rdp_estructura (            -- Planta > UET > Sector (segmentadores del dashboard)
  planta TEXT NOT NULL, uet TEXT NOT NULL, sector TEXT NOT NULL,
  PRIMARY KEY (planta, uet, sector)
);

-- ───────── Usuarios (dos roles) ─────────
CREATE TABLE IF NOT EXISTS rdp_usuarios (
  email    TEXT PRIMARY KEY CHECK (email = lower(email)),
  nombre   TEXT NOT NULL,
  apellido TEXT NOT NULL,
  area     TEXT NOT NULL DEFAULT '',
  rol      TEXT NOT NULL DEFAULT 'Usuario' CHECK (rol IN ('Administrador','Usuario')),
  activo   BOOLEAN NOT NULL DEFAULT TRUE,
  ts       BIGINT NOT NULL
);

-- ───────── Matriz de costos (versionada) ─────────
CREATE TABLE IF NOT EXISTS rdp_matriz (
  id       SERIAL PRIMARY KEY,
  concepto TEXT NOT NULL UNIQUE,
  unidad   TEXT NOT NULL,
  fuente   TEXT NOT NULL DEFAULT '',
  activo   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS rdp_matriz_ver (
  id        SERIAL PRIMARY KEY,
  matriz_id INTEGER NOT NULL REFERENCES rdp_matriz(id) ON DELETE CASCADE,
  desde     DATE NOT NULL,
  costo     NUMERIC(16,2) NOT NULL CHECK (costo >= 0),
  por       TEXT NOT NULL DEFAULT '',
  ts        BIGINT NOT NULL,
  UNIQUE (matriz_id, desde)
);

-- ───────── RDP ─────────
CREATE SEQUENCE IF NOT EXISTS rdp_seq;
CREATE TABLE IF NOT EXISTS rdp (
  id               TEXT PRIMARY KEY,                  -- RDP-001
  titulo           TEXT NOT NULL,
  planta           TEXT NOT NULL,
  uet              TEXT NOT NULL,
  sector           TEXT NOT NULL,
  herramienta      TEXT NOT NULL CHECK (herramienta IN ('A3','A4','5PQ')),
  paso             SMALLINT NOT NULL DEFAULT 1 CHECK (paso BETWEEN 0 AND 8),   -- 0-5 = P · 6 = D · 7 = C · 8 = A
  cerrado          BOOLEAN NOT NULL DEFAULT FALSE,
  origen           TEXT NOT NULL DEFAULT 'Indicador',  -- Indicador | Pareto | Impacto | Genba | Reclamo de cliente
  origen_detalle   JSONB NOT NULL DEFAULT '{}'::jsonb,
  muda             TEXT NOT NULL DEFAULT 'Defectos',
  prioridad        JSONB NOT NULL DEFAULT '{}'::jsonb, -- puntajes de seguridad / severidad / cantidad / recurrencia
  justificacion    TEXT NOT NULL DEFAULT '',           -- por qué eligió una herramienta distinta de la recomendada
  lider_email      TEXT NOT NULL REFERENCES rdp_usuarios(email),
  indicador_unidad TEXT NOT NULL DEFAULT '',
  linea_base       NUMERIC(16,4) NOT NULL DEFAULT 0,
  meta             NUMERIC(16,4) NOT NULL DEFAULT 0,
  actual           NUMERIC(16,4) NOT NULL DEFAULT 0,
  inicio           DATE NOT NULL DEFAULT CURRENT_DATE,
  cierre           DATE,
  creado_por       TEXT NOT NULL,
  ts               BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rdp_loc_idx ON rdp (planta, uet, sector);
CREATE INDEX IF NOT EXISTS rdp_paso_idx ON rdp (paso);

-- Contenido de cada paso/subpaso del A3, A4 o 5PQ (los campos del formato FR-MCO) como JSON
CREATE TABLE IF NOT EXISTS rdp_paso (
  rdp_id TEXT NOT NULL REFERENCES rdp(id) ON DELETE CASCADE,
  paso   SMALLINT NOT NULL CHECK (paso BETWEEN 0 AND 8),
  datos  JSONB NOT NULL DEFAULT '{}'::jsonb,
  por    TEXT NOT NULL DEFAULT '',
  ts     BIGINT NOT NULL,
  PRIMARY KEY (rdp_id, paso)
);

-- Evolución del indicador (paso 7: monitorear)
CREATE TABLE IF NOT EXISTS rdp_medicion (
  id     BIGSERIAL PRIMARY KEY,
  rdp_id TEXT NOT NULL REFERENCES rdp(id) ON DELETE CASCADE,
  fecha  DATE NOT NULL,
  valor  NUMERIC(16,4) NOT NULL,
  nota   TEXT NOT NULL DEFAULT '',
  ts     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rdp_medicion_idx ON rdp_medicion (rdp_id, fecha);

-- Pérdidas: estándar (matriz de costos) o libres (p. ej. costos indirectos). Cantidades anuales.
CREATE TABLE IF NOT EXISTS rdp_perdida (
  id           BIGSERIAL PRIMARY KEY,
  rdp_id       TEXT NOT NULL REFERENCES rdp(id) ON DELETE CASCADE,
  modo         TEXT NOT NULL CHECK (modo IN ('std','libre')),
  matriz_id    INTEGER REFERENCES rdp_matriz(id),
  concepto     VARCHAR(30) NOT NULL,
  unidad       TEXT NOT NULL,
  costo_unit   NUMERIC(16,2) NOT NULL CHECK (costo_unit >= 0),   -- costo vigente al cargar (queda fijo)
  vigencia     DATE,                                             -- desde cuándo regía ese costo (solo std)
  cant_antes   NUMERIC(16,2) NOT NULL CHECK (cant_antes >= 0),
  cant_despues NUMERIC(16,2) CHECK (cant_despues >= 0),          -- medido al cierre; si es NULL se deriva del indicador
  fuente       TEXT NOT NULL DEFAULT '',                         -- criterio de cálculo (obligatorio en libres)
  por          TEXT NOT NULL DEFAULT '',
  ts           BIGINT NOT NULL,
  CHECK (modo = 'std' AND matriz_id IS NOT NULL OR modo = 'libre')
);
CREATE INDEX IF NOT EXISTS rdp_perdida_idx ON rdp_perdida (rdp_id);

-- Acciones (contención, contramedida, estandarización, yokoten). Sin flujo de aprobación.
CREATE TABLE IF NOT EXISTS rdp_accion (
  id          BIGSERIAL PRIMARY KEY,
  rdp_id      TEXT NOT NULL REFERENCES rdp(id) ON DELETE CASCADE,
  n           INTEGER NOT NULL,
  codigo      TEXT NOT NULL,                                     -- A-001-01
  tipo        TEXT NOT NULL CHECK (tipo IN ('Contención','Contramedida','Estandarización','Yokoten')),
  texto       TEXT NOT NULL,
  causa_raiz  TEXT NOT NULL DEFAULT '',                          -- CR1, CR2…
  resp_email  TEXT NOT NULL REFERENCES rdp_usuarios(email),
  inicio      DATE NOT NULL,
  compromiso  DATE NOT NULL,
  avance      SMALLINT NOT NULL DEFAULT 0 CHECK (avance BETWEEN 0 AND 100),
  inversion   NUMERIC(16,2) NOT NULL DEFAULT 0,
  por         TEXT NOT NULL DEFAULT '',
  ts          BIGINT NOT NULL,
  UNIQUE (rdp_id, n)
);
CREATE INDEX IF NOT EXISTS rdp_accion_resp_idx ON rdp_accion (resp_email);

-- Enlaces a evidencias (SharePoint, fotos, planillas)
CREATE TABLE IF NOT EXISTS rdp_evidencia (
  id        BIGSERIAL PRIMARY KEY,
  rdp_id    TEXT NOT NULL REFERENCES rdp(id) ON DELETE CASCADE,
  accion_id BIGINT REFERENCES rdp_accion(id) ON DELETE SET NULL,
  nombre    TEXT NOT NULL,
  url       TEXT NOT NULL,
  por       TEXT NOT NULL DEFAULT '',
  ts        BIGINT NOT NULL
);

-- Bandeja de salida de correos: queda registro aunque el envío esté apagado o falle
CREATE TABLE IF NOT EXISTS rdp_correo (
  id         BIGSERIAL PRIMARY KEY,
  para       TEXT NOT NULL,
  asunto     TEXT NOT NULL,
  cuerpo     TEXT NOT NULL,
  estado     TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviado','error')),
  error      TEXT NOT NULL DEFAULT '',
  ts         BIGINT NOT NULL,
  enviado_ts BIGINT
);

-- Auditoría
CREATE TABLE IF NOT EXISTS rdp_log (
  id      BIGSERIAL PRIMARY KEY,
  ts      BIGINT NOT NULL,
  email   TEXT NOT NULL,
  accion  TEXT NOT NULL,
  entidad TEXT NOT NULL,
  detalle JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ───────── Vistas ─────────
-- Estado de la acción (misma regla que el dashboard)
CREATE OR REPLACE VIEW rdp_accion_v AS
SELECT a.*,
  CASE WHEN a.avance >= 100 THEN 'Cerrada'
       WHEN a.inicio > CURRENT_DATE AND a.avance = 0 THEN 'Planificada'
       WHEN a.compromiso < CURRENT_DATE THEN 'Vencida'
       ELSE 'En curso' END AS estado
FROM rdp_accion a;

-- Impacto: pérdida base, ahorro proyectado, ahorro realizado (desde el paso 7) e inversión.
-- Ahorro realizado: si todas las pérdidas tienen cantidad "después" medida se usa esa;
-- si no, se deriva de la variación del indicador físico (actual / línea base).
CREATE OR REPLACE VIEW rdp_impacto_v AS
SELECT r.id,
  COALESCE(p.base, 0) AS perdida_base,
  COALESCE(p.base, 0) * (1 - r.meta / NULLIF(r.linea_base, 0)) AS ahorro_proy,
  CASE WHEN r.paso >= 7 THEN
    CASE WHEN p.todas_med THEN p.base - p.despues
         ELSE COALESCE(p.base, 0) * (1 - r.actual / NULLIF(r.linea_base, 0)) END
  ELSE 0 END AS ahorro_real,
  COALESCE(i.inv, 0) AS inversion
FROM rdp r
LEFT JOIN (SELECT rdp_id, SUM(cant_antes * costo_unit) AS base,
                  SUM(COALESCE(cant_despues, 0) * costo_unit) AS despues,
                  bool_and(cant_despues IS NOT NULL) AS todas_med
           FROM rdp_perdida GROUP BY rdp_id) p ON p.rdp_id = r.id
LEFT JOIN (SELECT rdp_id, SUM(inversion) AS inv FROM rdp_accion WHERE tipo = 'Contramedida' GROUP BY rdp_id) i ON i.rdp_id = r.id;
