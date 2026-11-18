import { neon } from "@neondatabase/serverless";

/* ───────────── utilidades ───────────── */
const HERR = ["A3", "A4", "5PQ"];
const TIPOS = ["Contención", "Contramedida", "Estandarización", "Yokoten"];
const PLANTAS = ["Suipacha", "25 de Mayo", "Ambas", "Sin planta"];
const MUDAS = ["Defectos", "Esperar", "Movimientos", "Traslados", "Sobreproducción", "Sobreproceso", "Inventario", "Ambiente", "Seguridad"];
const ROLES = ["Administrador", "Usuario"];

const HTTP = (status, msg) => Object.assign(new Error(msg), { status });
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isMail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function secret(v) {
  if (v && typeof v.get === "function") v = await v.get();
  return typeof v === "string" ? v : "";
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ───────────── autenticación ───────────── */
// Modo "pilot": clave compartida (X-App-Key) + email (X-User-Email). Solo para pruebas internas:
// quien tenga la clave puede hacerse pasar por otro usuario. En producción usar AUTH_MODE="entra".
// Modo "entra": token de Microsoft Entra ID (Authorization: Bearer …) validado contra las claves públicas de Microsoft.
let JWKS = { t: 0, keys: null };
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

async function verifyEntra(tok, env) {
  const parts = tok.split(".");
  if (parts.length !== 3) throw HTTP(401, "falta el token de Microsoft");
  const tenant = env.ENTRA_TENANT_ID;
  if (!tenant || !env.ENTRA_CLIENT_ID) throw HTTP(503, "Entra ID sin configurar en el Worker");
  const head = JSON.parse(new TextDecoder().decode(b64u(parts[0])));
  const pay = JSON.parse(new TextDecoder().decode(b64u(parts[1])));
  if (head.alg !== "RS256") throw HTTP(401, "algoritmo no soportado");
  if (!JWKS.keys || Date.now() - JWKS.t > 36e5) {
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`);
    JWKS = { t: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = JWKS.keys.find((k) => k.kid === head.kid);
  if (!jwk) throw HTTP(401, "clave de firma desconocida");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw HTTP(401, "firma inválida");
  const now = Date.now() / 1000;
  if (!pay.exp || pay.exp < now || (pay.nbf && pay.nbf > now + 60)) throw HTTP(401, "token vencido");
  if (pay.iss !== `https://login.microsoftonline.com/${tenant}/v2.0`) throw HTTP(401, "emisor inválido");
  if (![env.ENTRA_CLIENT_ID, "api://" + env.ENTRA_CLIENT_ID].includes(pay.aud)) throw HTTP(401, "audiencia inválida");
  return String(pay.preferred_username || pay.upn || pay.email || "").toLowerCase();
}

async function authenticate(req, env, sql) {
  let email = "";
  if ((env.AUTH_MODE || "pilot") === "entra") {
    email = await verifyEntra((req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""), env);
  } else {
    const key = await secret(env.RDPESC_APP_KEY);
    if (!key) throw HTTP(503, "RDPESC_APP_KEY no está configurada en el Worker");
    if (!safeEqual(req.headers.get("X-App-Key") || "", key)) throw HTTP(401, "clave de la app incorrecta");
    email = str(req.headers.get("X-User-Email"), 200).toLowerCase();
  }
  const [u] = await sql`SELECT email, nombre, apellido, area, rol, foto FROM rdp_usuarios WHERE email = ${email} AND activo`;
  if (!u) throw HTTP(403, "usuario no habilitado en la plataforma");
  return u;
}
const isAdmin = (u) => u.rol === "Administrador";
const needAdmin = (u) => { if (!isAdmin(u)) throw HTTP(403, "requiere rol Administrador"); };
const canEdit = (u, r) => isAdmin(u) || r.lider_email === u.email || r.creado_por === u.email;

/* ───────────── correo por Microsoft Graph ───────────── */
let GT = { t: 0, v: "" };
async function graphToken(env) {
  if (GT.v && Date.now() < GT.t) return GT.v;
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID || env.ENTRA_CLIENT_ID,
    client_secret: await secret(env.RDPESC_MS_SECRET),
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, { method: "POST", body });
  const j = await r.json();
  if (!j.access_token) throw new Error("token Graph: " + (j.error_description || j.error || r.status));
  GT = { v: j.access_token, t: Date.now() + (j.expires_in - 120) * 1000 };
  return GT.v;
}
async function despachar(env, sql, id, para, asunto, html) {
  try {
    const tk = await graphToken(env);
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/sendMail`, {
      method: "POST",
      headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { subject: asunto, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: para } }] }, saveToSentItems: false }),
    });
    if (r.status !== 202) throw new Error("Graph " + r.status + " " + (await r.text()).slice(0, 200));
    await sql`UPDATE rdp_correo SET estado = 'enviado', error = '', enviado_ts = ${Date.now()} WHERE id = ${id}`;
  } catch (e) {
    await sql`UPDATE rdp_correo SET estado = 'error', error = ${String(e.message).slice(0, 300)} WHERE id = ${id}`;
  }
}
// Siempre deja el mensaje en la bandeja de salida; lo envía solo si MAIL_ENABLED = "1".
async function correo(env, sql, para, asunto, html) {
  const [row] = await sql`INSERT INTO rdp_correo (para, asunto, cuerpo, ts) VALUES (${para}, ${asunto}, ${html}, ${Date.now()}) RETURNING id`;
  if (env.MAIL_ENABLED === "1" && env.MAIL_FROM) await despachar(env, sql, row.id, para, asunto, html);
}
const marco = (titulo, cuerpo, link, boton) => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#14213D;max-width:560px">
<div style="background:#0F5C8C;color:#fff;padding:10px 16px;border-radius:8px 8px 0 0;font-weight:700">RDP · Escorial Mejora Continua</div>
<div style="border:1px solid #D8E1EB;border-top:0;padding:16px;border-radius:0 0 8px 8px">
<h3 style="margin:0 0 10px;color:#0F5C8C">${esc(titulo)}</h3>${cuerpo}
<p><a href="${esc(link)}" style="background:#2E9BD6;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700">${esc(boton)}</a></p>
<p style="color:#667085;font-size:12px">Mensaje automático de la plataforma RDP.</p></div></div>`;

/* ───────────── router ───────────── */
export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Key, X-User-Email",
      Vary: "Origin",
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const M = req.method;
    const body = async () => { try { return await req.json(); } catch { throw HTTP(400, "JSON inválido"); } };
    const at = (re) => { const m = path.match(re); return m ? m.slice(1).map((x) => decodeURIComponent(x)) : null; };

    try {
      if (path === "/" && M === "GET") return json({ ok: true, name: "rdp-escorial-api", auth: env.AUTH_MODE || "pilot", mail: env.MAIL_ENABLED === "1" });

      const dbUrl = await secret(env.RDPESC_NEON_URL);
      if (!dbUrl.startsWith("postgres")) throw HTTP(500, "RDPESC_NEON_URL no contiene una cadena postgresql:// válida");
      const sql = neon(dbUrl);
      const u = await authenticate(req, env, sql);
      const log = (accion, entidad, detalle = {}) =>
        ctx.waitUntil((async () => { try { await sql`INSERT INTO rdp_log (ts, email, accion, entidad, detalle) VALUES (${Date.now()}, ${u.email}, ${accion}, ${entidad}, ${JSON.stringify(detalle)}::jsonb)`; } catch {} })());
      const getRdp = async (id) => {
        const [r] = await sql`SELECT * FROM rdp WHERE id = ${id}`;
        if (!r) throw HTTP(404, "RDP inexistente");
        return r;
      };
      const costoVigente = async (matrizId, fecha) => {
        const [v] = await sql`SELECT v.costo, v.desde, m.concepto, m.unidad FROM rdp_matriz m
          JOIN rdp_matriz_ver v ON v.matriz_id = m.id
          WHERE m.id = ${matrizId} AND m.activo AND v.desde <= ${fecha}::date ORDER BY v.desde DESC LIMIT 1`;
        if (!v) throw HTTP(400, "el concepto no tiene un costo vigente en la matriz");
        return v;
      };
      const insertarPerdida = (rdpId, p, v) => {
        // Devuelve la consulta lista para ejecutar (permite usarla dentro de una transacción)
        const modo = p.modo === "std" ? "std" : "libre";
        const cant = num(p.cant_antes ?? p.cant);
        if (!(cant >= 0)) throw HTTP(400, "cantidad inválida");
        if (modo === "std") {
          return sql`INSERT INTO rdp_perdida (rdp_id, modo, matriz_id, concepto, unidad, costo_unit, vigencia, cant_antes, fuente, por, ts)
            VALUES (${rdpId}, 'std', ${p.matriz_id}, ${str(v.concepto, 30)}, ${v.unidad}, ${v.costo}, ${v.desde}, ${cant}, 'Matriz de costos', ${u.email}, ${Date.now()})`;
        }
        const concepto = str(p.concepto, 30), unidad = str(p.unidad, 8) || "U", costo = num(p.costo_unit, -1);
        if (!concepto || costo < 0) throw HTTP(400, "concepto y pérdida unitaria son obligatorios en una pérdida libre");
        const fuente = str(p.fuente, 400);
        if (!fuente) throw HTTP(400, "indicá el criterio de cálculo de la pérdida libre");
        return sql`INSERT INTO rdp_perdida (rdp_id, modo, concepto, unidad, costo_unit, cant_antes, fuente, por, ts)
          VALUES (${rdpId}, 'libre', ${concepto}, ${unidad}, ${costo}, ${cant}, ${fuente}, ${u.email}, ${Date.now()})`;
      };
      const RDP_SQL = `SELECT r.id, r.titulo, r.gerencia, r.area, r.sector, r.planta, r.herramienta, r.paso, r.cerrado, r.origen, r.origen_detalle, r.muda,
          r.prioridad, r.justificacion, r.lider_email, r.indicador_unidad, r.linea_base, r.meta, r.actual,
          r.inicio::text AS inicio, r.cierre::text AS cierre, r.creado_por, r.ts,
          i.perdida_base, i.ahorro_proy, i.ahorro_real, i.inversion,
          (SELECT max(fecha)::text FROM rdp_medicion WHERE rdp_id = r.id) AS ultima_medicion,
          COALESCE((SELECT json_agg(row_to_json(p) ORDER BY p.id) FROM rdp_perdida p WHERE p.rdp_id = r.id), '[]'::json) AS perdidas,
          COALESCE((SELECT json_agg(row_to_json(a) ORDER BY a.n) FROM rdp_accion_v a WHERE a.rdp_id = r.id), '[]'::json) AS acciones
        FROM rdp r JOIN rdp_impacto_v i ON i.id = r.id`;
      const rdpFull = (id) => (id ? sql(RDP_SQL + " WHERE r.id = $1 ORDER BY r.id", [id]) : sql(RDP_SQL + " ORDER BY r.id"));

      /* ── sesión y catálogos ── */
      if (path === "/me" && M === "GET") return json(u);
      if (path === "/bootstrap" && M === "GET") {
        const [areas, estructura, matriz, usuarios] = await Promise.all([
          sql`SELECT nombre FROM rdp_areas ORDER BY nombre`,
          sql`SELECT gerencia, area, sector FROM rdp_estructura ORDER BY gerencia, area, sector`,
          sql`SELECT m.id, m.concepto, m.unidad, m.fuente, m.activo,
                COALESCE((SELECT json_agg(json_build_object('desde', v.desde, 'costo', v.costo) ORDER BY v.desde DESC)
                          FROM rdp_matriz_ver v WHERE v.matriz_id = m.id), '[]'::json) AS versiones
              FROM rdp_matriz m ORDER BY m.concepto`,
          sql`SELECT email, nombre, apellido, area, rol, activo, foto FROM rdp_usuarios ORDER BY apellido, nombre`,
        ]);
        return json({ me: u, areas: areas.map((a) => a.nombre), estructura, plantas: PLANTAS, matriz, usuarios, mudas: MUDAS });
      }

      /* ── RDP ── */
      if (path === "/rdp" && M === "GET") return json(await rdpFull());
      if (path === "/rdp" && M === "POST") {
        const b = await body();
        const titulo = str(b.titulo, 200), herramienta = b.herramienta;
        if (!titulo || !HERR.includes(herramienta)) throw HTTP(400, "título y herramienta (A3, A4 o 5PQ) son obligatorios");
        const gerencia = str(b.gerencia, 100), area = str(b.area, 100), sector = str(b.sector, 80), planta = str(b.planta, 20);
        if (!PLANTAS.includes(planta)) throw HTTP(400, "planta inválida (Suipacha, 25 de Mayo, Ambas o Sin planta)");
        const [ok] = await sql`SELECT 1 AS x FROM rdp_estructura WHERE gerencia = ${gerencia} AND area = ${area} AND sector = ${sector}`;
        if (!ok) throw HTTP(400, "gerencia / área / sector inexistente");
        const lider = str(b.lider_email || u.email, 200).toLowerCase();
        const [lu] = await sql`SELECT 1 AS x FROM rdp_usuarios WHERE email = ${lider} AND activo`;
        if (!lu) throw HTTP(400, "el líder no es un usuario habilitado");
        const muda = MUDAS.includes(b.muda) ? b.muda : "Defectos";
        const hoy = new Date().toISOString().slice(0, 10);
        const perdidas = Array.isArray(b.perdidas) ? b.perdidas.slice(0, 30) : [];
        const qs = [];
        const [{ id }] = await sql`SELECT 'RDP-' || lpad(nextval('rdp_seq')::text, 3, '0') AS id`;
        qs.push(sql`INSERT INTO rdp (id, titulo, gerencia, area, sector, planta, herramienta, paso, origen, origen_detalle, muda, prioridad, justificacion,
            lider_email, indicador_unidad, linea_base, meta, actual, inicio, creado_por, ts)
          VALUES (${id}, ${titulo}, ${gerencia}, ${area}, ${sector}, ${planta}, ${herramienta}, 1, ${str(b.origen, 60) || "Indicador"},
            ${JSON.stringify(b.origen_detalle || {})}::jsonb, ${muda}, ${JSON.stringify(b.prioridad || {})}::jsonb, ${str(b.justificacion, 600)},
            ${lider}, ${str(b.indicador_unidad, 60)}, ${num(b.linea_base)}, ${num(b.meta)}, ${num(b.linea_base)},
            ${isDate(b.inicio) ? b.inicio : hoy}, ${u.email}, ${Date.now()})`);
        for (const p of perdidas) {
          const v = p.modo === "std" ? await costoVigente(p.matriz_id, hoy) : null;
          qs.push(insertarPerdida(id, p, v));
        }
        await sql.transaction(qs);
        log("crear", "rdp", { id, herramienta });
        return json((await rdpFull(id))[0], 201);
      }
      let m;
      if ((m = at(/^\/rdp\/([^/]+)$/))) {
        const [id] = m;
        if (M === "GET") {
          const [r] = await rdpFull(id);
          if (!r) throw HTTP(404, "RDP inexistente");
          const [pasos, mediciones, evidencias] = await Promise.all([
            sql`SELECT paso, datos, por, ts FROM rdp_paso WHERE rdp_id = ${id} ORDER BY paso`,
            sql`SELECT id, fecha::text AS fecha, valor, nota FROM rdp_medicion WHERE rdp_id = ${id} ORDER BY fecha, id`,
            sql`SELECT id, accion_id, nombre, url, por, ts FROM rdp_evidencia WHERE rdp_id = ${id} ORDER BY id`,
          ]);
          return json({ ...r, pasos, mediciones, evidencias });
        }
        if (M === "PATCH") {
          const r = await getRdp(id);
          if (!canEdit(u, r)) throw HTTP(403, "solo el líder, quien lo creó o un administrador pueden modificarlo");
          const b = await body();
          const paso = b.paso === undefined ? r.paso : Math.round(num(b.paso, -1));
          if (paso < 0 || paso > 8) throw HTTP(400, "paso fuera de rango (0 a 8)");
          const herr = b.herramienta === undefined ? r.herramienta : b.herramienta;
          if (!HERR.includes(herr)) throw HTTP(400, "herramienta inválida");
          const lider = b.lider_email === undefined ? r.lider_email : str(b.lider_email, 200).toLowerCase();
          const cerrado = b.cerrado === undefined ? r.cerrado : !!b.cerrado;
          await sql`UPDATE rdp SET titulo = ${b.titulo === undefined ? r.titulo : str(b.titulo, 200) || r.titulo},
              paso = ${paso}, herramienta = ${herr}, lider_email = ${lider}, cerrado = ${cerrado},
              cierre = CASE WHEN ${cerrado}::boolean THEN COALESCE(cierre, CURRENT_DATE) ELSE NULL END,
              muda = ${MUDAS.includes(b.muda) ? b.muda : r.muda},
              indicador_unidad = ${b.indicador_unidad === undefined ? r.indicador_unidad : str(b.indicador_unidad, 60)},
              linea_base = ${b.linea_base === undefined ? r.linea_base : num(b.linea_base)},
              meta = ${b.meta === undefined ? r.meta : num(b.meta)},
              justificacion = ${b.justificacion === undefined ? r.justificacion : str(b.justificacion, 600)}
            WHERE id = ${id}`;
          log("modificar", "rdp", { id, paso, herramienta: herr, cerrado });
          return json((await rdpFull(id))[0]);
        }
        if (M === "DELETE") {
          needAdmin(u);
          await sql`DELETE FROM rdp WHERE id = ${id}`;
          log("eliminar", "rdp", { id });
          return json({ ok: true });
        }
      }
      // Contenido de un paso del formato (campos del A3 / A4 / 5PQ)
      if ((m = at(/^\/rdp\/([^/]+)\/paso\/(\d)$/)) && M === "PUT") {
        const [id, p] = m;
        const r = await getRdp(id);
        if (!canEdit(u, r)) throw HTTP(403, "sin permiso para editar este RDP");
        const b = await body();
        const datos = JSON.stringify(b.datos && typeof b.datos === "object" ? b.datos : {});
        if (datos.length > 200000) throw HTTP(413, "contenido demasiado grande");
        await sql`INSERT INTO rdp_paso (rdp_id, paso, datos, por, ts) VALUES (${id}, ${+p}, ${datos}::jsonb, ${u.email}, ${Date.now()})
          ON CONFLICT (rdp_id, paso) DO UPDATE SET datos = EXCLUDED.datos, por = EXCLUDED.por, ts = EXCLUDED.ts`;
        log("guardar", "paso", { id, paso: +p });
        return json({ ok: true });
      }
      // Mediciones del indicador
      if ((m = at(/^\/rdp\/([^/]+)\/mediciones$/)) && M === "POST") {
        const [id] = m;
        const r = await getRdp(id);
        if (!canEdit(u, r)) throw HTTP(403, "sin permiso para editar este RDP");
        const b = await body();
        if (!isDate(b.fecha) || !Number.isFinite(Number(b.valor))) throw HTTP(400, "fecha (AAAA-MM-DD) y valor son obligatorios");
        await sql.transaction([
          sql`INSERT INTO rdp_medicion (rdp_id, fecha, valor, nota, ts) VALUES (${id}, ${b.fecha}, ${num(b.valor)}, ${str(b.nota, 300)}, ${Date.now()})`,
          sql`UPDATE rdp SET actual = (SELECT valor FROM rdp_medicion WHERE rdp_id = ${id} ORDER BY fecha DESC, id DESC LIMIT 1) WHERE id = ${id}`,
        ]);
        log("medir", "rdp", { id, valor: num(b.valor) });
        return json((await rdpFull(id))[0], 201);
      }
      // Pérdidas (calculadora de impacto)
      if ((m = at(/^\/rdp\/([^/]+)\/perdidas$/)) && M === "POST") {
        const [id] = m;
        const r = await getRdp(id);
        if (!canEdit(u, r)) throw HTTP(403, "sin permiso para editar este RDP");
        const b = await body();
        const v = b.modo === "std" ? await costoVigente(b.matriz_id, new Date().toISOString().slice(0, 10)) : null;
        await insertarPerdida(id, b, v);
        log("crear", "perdida", { id, modo: b.modo });
        return json((await rdpFull(id))[0], 201);
      }
      if ((m = at(/^\/perdidas\/(\d+)$/))) {
        const [pid] = m;
        const [p] = await sql`SELECT p.*, r.lider_email, r.creado_por, r.cerrado FROM rdp_perdida p JOIN rdp r ON r.id = p.rdp_id WHERE p.id = ${pid}`;
        if (!p) throw HTTP(404, "pérdida inexistente");
        if (!canEdit(u, p)) throw HTTP(403, "sin permiso para editar este RDP");
        if (p.cerrado && !isAdmin(u)) throw HTTP(409, "el RDP está cerrado: solo un administrador puede modificar sus pérdidas");
        if (M === "PATCH") {
          // Se puede corregir en cualquier paso del RDP (p. ej. si la investigación descubre un costo asociado no previsto).
          const b = await body();
          const des = b.cant_despues === null ? null : b.cant_despues === undefined ? p.cant_despues : num(b.cant_despues, -1);
          if (des !== null && des < 0) throw HTTP(400, "cantidad inválida");
          const antes = b.cant_antes === undefined ? p.cant_antes : num(b.cant_antes, -1);
          if (antes < 0) throw HTTP(400, "cantidad inválida");
          let concepto = p.concepto, unidad = p.unidad, costo = p.costo_unit, vig = p.vigencia, fuente = p.fuente, matriz = p.matriz_id;
          if (p.modo === "libre") {
            if (b.concepto !== undefined) concepto = str(b.concepto, 30);
            if (b.unidad !== undefined) unidad = str(b.unidad, 8) || "U";
            if (b.costo_unit !== undefined) costo = num(b.costo_unit, -1);
            if (b.fuente !== undefined) fuente = str(b.fuente, 400);
            if (!concepto || !(costo >= 0)) throw HTTP(400, "concepto y pérdida unitaria son obligatorios");
            if (!fuente) throw HTTP(400, "indicá el criterio de cálculo de la pérdida libre");
          } else if (b.matriz_id !== undefined && +b.matriz_id !== p.matriz_id) {
            const v = await costoVigente(b.matriz_id, new Date().toISOString().slice(0, 10));
            matriz = +b.matriz_id; concepto = str(v.concepto, 30); unidad = v.unidad; costo = v.costo; vig = v.desde;
          }
          await sql`UPDATE rdp_perdida SET cant_antes = ${antes}, cant_despues = ${des}, concepto = ${concepto}, unidad = ${unidad},
            costo_unit = ${costo}, vigencia = ${vig}, fuente = ${fuente}, matriz_id = ${matriz} WHERE id = ${pid}`;
          log("modificar", "perdida", { id: +pid, rdp: p.rdp_id, motivo: str(b.motivo, 300),
            antes: { concepto: p.concepto, costo: +p.costo_unit, cant: +p.cant_antes, despues: p.cant_despues === null ? null : +p.cant_despues },
            ahora: { concepto, costo: +costo, cant: +antes, despues: des } });
        } else if (M === "DELETE") {
          await sql`DELETE FROM rdp_perdida WHERE id = ${pid}`;
          log("eliminar", "perdida", { id: +pid, rdp: p.rdp_id, motivo: str(url.searchParams.get("motivo"), 300), concepto: p.concepto, cant: +p.cant_antes, costo: +p.costo_unit });
        } else throw HTTP(405, "método no permitido");
        return json((await rdpFull(p.rdp_id))[0]);
      }

      /* ── acciones (sin aprobación; al asignar responsable le llega un correo) ── */
      if (path === "/acciones" && M === "GET") {
        const q = url.searchParams.get("resp");
        const cols = "id, rdp_id, n, codigo, tipo, texto, causa_raiz, resp_email, inicio::text AS inicio, compromiso::text AS compromiso, avance, inversion, estado";
        return json(q ? await sql(`SELECT ${cols} FROM rdp_accion_v WHERE resp_email = $1 ORDER BY compromiso`, [q.toLowerCase()])
                      : await sql(`SELECT ${cols} FROM rdp_accion_v ORDER BY rdp_id, n`));
      }
      if ((m = at(/^\/rdp\/([^/]+)\/acciones$/)) && M === "POST") {
        const [id] = m;
        const r = await getRdp(id);
        if (!canEdit(u, r)) throw HTTP(403, "sin permiso para editar este RDP");
        const b = await body();
        const texto = str(b.texto, 500), tipo = b.tipo, resp = str(b.resp_email, 200).toLowerCase();
        if (!texto || !TIPOS.includes(tipo) || !isDate(b.inicio) || !isDate(b.compromiso)) throw HTTP(400, "tipo, acción, inicio y compromiso son obligatorios");
        const [ru] = await sql`SELECT email, nombre, apellido FROM rdp_usuarios WHERE email = ${resp} AND activo`;
        if (!ru) throw HTTP(400, "el responsable no es un usuario habilitado");
        const [{ n }] = await sql`SELECT COALESCE(MAX(n), 0) + 1 AS n FROM rdp_accion WHERE rdp_id = ${id}`;
        const codigo = `A-${id.slice(4)}-${String(n).padStart(2, "0")}`;
        await sql`INSERT INTO rdp_accion (rdp_id, n, codigo, tipo, texto, causa_raiz, resp_email, inicio, compromiso, inversion, por, ts)
          VALUES (${id}, ${n}, ${codigo}, ${tipo}, ${texto}, ${str(b.causa_raiz, 20)}, ${resp}, ${b.inicio}, ${b.compromiso}, ${Math.max(0, num(b.inversion))}, ${u.email}, ${Date.now()})`;
        const link = (env.APP_URL || "") + "#rdp=" + id;
        ctx.waitUntil(correo(env, sql, resp, `[RDP Escorial] Te asignaron una acción: ${codigo}`,
          marco("Tenés una acción asignada",
            `<p>Hola ${esc(ru.nombre)},</p><p>${esc(u.nombre)} ${esc(u.apellido)} te asignó una acción en <b>${esc(id)} · ${esc(r.titulo)}</b>:</p>
             <p style="background:#F5F9FC;border:1px solid #D8E1EB;border-radius:8px;padding:8px 10px"><b>${esc(tipo)}:</b> ${esc(texto)}<br>
             <span style="color:#667085">Compromiso: ${esc(b.compromiso)}</span></p>`, link, "Abrir en la plataforma")).catch(() => {}));
        log("crear", "accion", { id, codigo, resp });
        return json((await rdpFull(id))[0], 201);
      }
      if ((m = at(/^\/acciones\/(\d+)$/))) {
        const [aid] = m;
        const [a] = await sql`SELECT a.*, r.lider_email, r.creado_por FROM rdp_accion a JOIN rdp r ON r.id = a.rdp_id WHERE a.id = ${aid}`;
        if (!a) throw HTTP(404, "acción inexistente");
        const esResp = a.resp_email === u.email;
        if (!canEdit(u, a) && !esResp) throw HTTP(403, "sin permiso sobre esta acción");
        if (M === "PATCH") {
          const b = await body();
          const avance = b.avance === undefined ? a.avance : Math.round(num(b.avance, -1));
          if (avance < 0 || avance > 100) throw HTTP(400, "avance entre 0 y 100");
          // El responsable solo puede informar avance; el resto lo edita quien puede editar el RDP
          if (canEdit(u, a)) {
            await sql`UPDATE rdp_accion SET avance = ${avance},
              texto = ${b.texto === undefined ? a.texto : str(b.texto, 500) || a.texto},
              compromiso = ${isDate(b.compromiso) ? b.compromiso : a.compromiso},
              inversion = ${b.inversion === undefined ? a.inversion : Math.max(0, num(b.inversion))} WHERE id = ${aid}`;
          } else {
            await sql`UPDATE rdp_accion SET avance = ${avance} WHERE id = ${aid}`;
          }
          log("modificar", "accion", { id: +aid, avance });
        } else if (M === "DELETE") {
          if (!canEdit(u, a)) throw HTTP(403, "sin permiso para eliminar");
          await sql`DELETE FROM rdp_accion WHERE id = ${aid}`;
          log("eliminar", "accion", { id: +aid });
        } else throw HTTP(405, "método no permitido");
        return json((await rdpFull(a.rdp_id))[0]);
      }

      /* ── evidencias (enlaces) ── */
      if ((m = at(/^\/rdp\/([^/]+)\/evidencias$/)) && M === "POST") {
        const [id] = m;
        const r = await getRdp(id);
        if (!canEdit(u, r)) throw HTTP(403, "sin permiso para editar este RDP");
        const b = await body();
        const link = str(b.url, 600);
        if (!/^https:\/\//i.test(link) || !str(b.nombre, 160)) throw HTTP(400, "nombre y enlace https son obligatorios");
        await sql`INSERT INTO rdp_evidencia (rdp_id, accion_id, nombre, url, por, ts) VALUES (${id}, ${b.accion_id || null}, ${str(b.nombre, 160)}, ${link}, ${u.email}, ${Date.now()})`;
        return json({ ok: true }, 201);
      }

      /* ── administración (solo rol Administrador) ── */
      if (path === "/usuarios" && M === "POST") {
        needAdmin(u);
        const b = await body();
        const email = str(b.email, 200).toLowerCase(), nombre = str(b.nombre, 80), apellido = str(b.apellido, 80);
        if (!isMail(email) || !nombre || !apellido) throw HTTP(400, "nombre, apellido y un email válido son obligatorios");
        const rol = ROLES.includes(b.rol) ? b.rol : "Usuario";
        await sql`INSERT INTO rdp_usuarios (email, nombre, apellido, area, rol, activo, ts) VALUES (${email}, ${nombre}, ${apellido}, ${str(b.area, 120)}, ${rol}, TRUE, ${Date.now()})
          ON CONFLICT (email) DO UPDATE SET nombre = EXCLUDED.nombre, apellido = EXCLUDED.apellido, area = EXCLUDED.area, rol = EXCLUDED.rol, activo = TRUE`;
        ctx.waitUntil(correo(env, sql, email, "[RDP Escorial] Ya tenés acceso a la plataforma de Resolución de Problemas",
          marco("Te dimos de alta", `<p>Hola ${esc(nombre)},</p><p>Ya podés ingresar a la plataforma RDP de Escorial con tu usuario de Microsoft. Tu rol es <b>${esc(rol)}</b>.</p>`,
            env.APP_URL || "", "Ingresar")).catch(() => {}));
        log("alta", "usuario", { email, rol });
        return json({ ok: true }, 201);
      }
      if ((m = at(/^\/usuarios\/([^/]+)\/foto$/)) && M === "PUT") {
        // La foto la puede cambiar el propio usuario o un administrador. Llega ya reducida (data URL, máx. ~60 KB).
        const email = m[0].toLowerCase();
        if (email !== u.email && !isAdmin(u)) throw HTTP(403, "solo podés cambiar tu propia foto");
        const b = await body();
        const foto = String(b.foto ?? "");
        if (foto && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(foto) || foto.length > 60000)) throw HTTP(400, "foto inválida o demasiado pesada (máx. 60 KB)");
        const r = await sql`UPDATE rdp_usuarios SET foto = ${foto} WHERE email = ${email} RETURNING email`;
        if (!r.length) throw HTTP(404, "usuario inexistente");
        log("foto", "usuario", { email, quita: !foto });
        return json({ ok: true });
      }
      if ((m = at(/^\/usuarios\/([^/]+)$/)) && M === "PATCH") {
        needAdmin(u);
        const [email] = m;
        const [x] = await sql`SELECT * FROM rdp_usuarios WHERE email = ${email.toLowerCase()}`;
        if (!x) throw HTTP(404, "usuario inexistente");
        const b = await body();
        const rol = b.rol === undefined ? x.rol : b.rol, activo = b.activo === undefined ? x.activo : !!b.activo;
        if (!ROLES.includes(rol)) throw HTTP(400, "rol inválido");
        if (x.rol === "Administrador" && (rol !== "Administrador" || !activo)) {
          const [{ c }] = await sql`SELECT COUNT(*)::int AS c FROM rdp_usuarios WHERE rol = 'Administrador' AND activo AND email <> ${x.email}`;
          if (c < 1) throw HTTP(409, "tiene que quedar al menos un administrador activo");
        }
        await sql`UPDATE rdp_usuarios SET rol = ${rol}, activo = ${activo},
          nombre = ${b.nombre === undefined ? x.nombre : str(b.nombre, 80) || x.nombre}, apellido = ${b.apellido === undefined ? x.apellido : str(b.apellido, 80) || x.apellido},
          area = ${b.area === undefined ? x.area : str(b.area, 120)} WHERE email = ${x.email}`;
        log("modificar", "usuario", { email: x.email, rol, activo });
        return json({ ok: true });
      }
      if (path === "/matriz" && M === "POST") {
        needAdmin(u);
        const b = await body();
        const concepto = str(b.concepto, 30), unidad = str(b.unidad, 8), costo = num(b.costo, -1);
        if (!concepto || !unidad || costo < 0 || !isDate(b.desde)) throw HTTP(400, "concepto, unidad, costo y fecha de vigencia son obligatorios");
        const [mm] = await sql`INSERT INTO rdp_matriz (concepto, unidad, fuente) VALUES (${concepto}, ${unidad}, ${str(b.fuente, 120)}) RETURNING id`;
        await sql`INSERT INTO rdp_matriz_ver (matriz_id, desde, costo, por, ts) VALUES (${mm.id}, ${b.desde}, ${costo}, ${u.email}, ${Date.now()})`;
        log("alta", "matriz", { concepto, costo });
        return json({ ok: true, id: mm.id }, 201);
      }
      // Nueva versión de costo: no pisa las anteriores
      if ((m = at(/^\/matriz\/(\d+)\/versiones$/)) && M === "POST") {
        needAdmin(u);
        const [mid] = m;
        const b = await body();
        const costo = num(b.costo, -1);
        if (costo < 0 || !isDate(b.desde)) throw HTTP(400, "costo y fecha de vigencia son obligatorios");
        await sql`INSERT INTO rdp_matriz_ver (matriz_id, desde, costo, por, ts) VALUES (${mid}, ${b.desde}, ${costo}, ${u.email}, ${Date.now()})
          ON CONFLICT (matriz_id, desde) DO UPDATE SET costo = EXCLUDED.costo, por = EXCLUDED.por, ts = EXCLUDED.ts`;
        if (b.fuente !== undefined) await sql`UPDATE rdp_matriz SET fuente = ${str(b.fuente, 120)} WHERE id = ${mid}`;
        log("version", "matriz", { id: +mid, costo, desde: b.desde });
        return json({ ok: true }, 201);
      }
      if ((m = at(/^\/matriz\/(\d+)$/)) && M === "PATCH") {
        needAdmin(u);
        const [mid] = m;
        const b = await body();
        await sql`UPDATE rdp_matriz SET activo = ${!!b.activo} WHERE id = ${mid}`;   // baja lógica: conserva el historial
        log("modificar", "matriz", { id: +mid, activo: !!b.activo });
        return json({ ok: true });
      }
      if (path === "/areas" && M === "POST") {
        needAdmin(u);
        const b = await body();
        const nombre = str(b.nombre, 120);
        if (!nombre) throw HTTP(400, "nombre obligatorio");
        await sql`INSERT INTO rdp_areas (nombre) VALUES (${nombre}) ON CONFLICT DO NOTHING`;
        return json({ ok: true }, 201);
      }
      if (path === "/estructura" && M === "POST") {
        needAdmin(u);
        const b = await body();
        const gerencia = str(b.gerencia, 100), area = str(b.area, 100), sector = str(b.sector, 80);
        if (!gerencia || !area) throw HTTP(400, "gerencia y área son obligatorias (el sector es opcional)");
        await sql`INSERT INTO rdp_estructura (gerencia, area, sector) VALUES (${gerencia}, ${area}, ${sector}) ON CONFLICT DO NOTHING`;
        return json({ ok: true }, 201);
      }
      if (path === "/admin/correo" && M === "GET") {
        needAdmin(u);
        return json(await sql`SELECT id, para, asunto, estado, error, ts, enviado_ts FROM rdp_correo ORDER BY id DESC LIMIT 100`);
      }
      // Reintenta los correos pendientes o con error (útil cuando IT habilita el envío)
      if (path === "/admin/correo/reintentar" && M === "POST") {
        needAdmin(u);
        if (env.MAIL_ENABLED !== "1" || !env.MAIL_FROM) throw HTTP(409, "el envío de correo está apagado (MAIL_ENABLED / MAIL_FROM)");
        const pend = await sql`SELECT id, para, asunto, cuerpo FROM rdp_correo WHERE estado <> 'enviado' ORDER BY id LIMIT 50`;
        for (const c of pend) await despachar(env, sql, c.id, c.para, c.asunto, c.cuerpo);
        return json({ ok: true, procesados: pend.length });
      }
      if (path === "/admin/log" && M === "GET") {
        needAdmin(u);
        return json(await sql`SELECT ts, email, accion, entidad, detalle FROM rdp_log ORDER BY id DESC LIMIT 200`);
      }

      throw HTTP(404, "not found");
    } catch (e) {
      const status = e.status || 500;
      return json({ error: status === 500 ? "server error" : e.message, detail: status === 500 ? String((e && e.message) || e).slice(0, 200) : undefined }, status);
    }
  },
};
