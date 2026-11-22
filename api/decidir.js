// 22-nov (becario bb01297) · El CEO: «aquí debería de poder decidir también con una palomita o tache».
// 22-nov (becario b43600f) · El CEO: «que tambien tenga decisiones, es socio» (Carlo decide también, con SU código).
// Contestar una decisión pendiente desde el panel: ✓ = la opción recomendada, ✗ = otra opción.
//
// QUIÉN: dos personas, y el SERVIDOR decide quién es por la contraseña y el código (nunca por algo que mande el navegador):
//   · Rodrigo (CEO): x-panel-key = PANEL_PASSWORD        y x-decidir-codigo = PANEL_DECIDIR_CODIGO
//   · Carlo (socio): x-panel-key = PANEL_PASSWORD_CARLO  y x-decidir-codigo = PANEL_DECIDIR_CODIGO_CARLO
//   La contraseña dice quién es; el código tiene que ser EL DE ESA PERSONA (el de la otra no sirve).
//   Sin la variable del código de esa persona no puede decidir (503, botones apagados); la de la otra persona sigue igual.
//   Mismo freno que api/stats.js: 1.5 s por intento malo y 429 tras 8 fallos en 10 min por IP.
//   Nunca se registra (console), se guarda ni se devuelve una contraseña o un código.
// REGLA (decisión del CEO «carlo_socio_decide»): vale la PRIMERA respuesta, PERO si Rodrigo contesta algo que ya había contestado
//   Carlo, gana Rodrigo (la de Carlo queda en el historial). Carlo no puede cambiar lo que contestó Rodrigo, y nadie contesta dos
//   veces lo suyo (409).
// DÓNDE SE GUARDA: el proyecto no tiene almacenamiento en Vercel (ni Blob, ni KV, ni Edge Config) y no se creó uno.
//   La respuesta {id, opcion, boton, quien, f} va FIRMADA (HMAC-SHA256) a un tema privado de ntfy.sh, el mismo servicio gratis de
//   los avisos al celular; ntfy la guarda 12 h. canal/decisiones_panel.py la lee en cada foto del panel (revisión de cada hora),
//   revisa la firma y la escribe en decisiones_ceo.json igual que una respuesta de la Oficina (con "quien" y, si Rodrigo cambió
//   la de Carlo, "respuestas_previas").
//   La llave de la firma y el nombre del tema salen de YT_CLIENT_SECRET (ya está en Vercel y en el sistema): no hay que mover
//   ningún secreto nuevo. Sin la llave nadie puede leer el tema ni falsificar una respuesta (ni cambiar el "quien": va firmado).
//   Mensajes v1 (antes del 22-nov 04:10Z, solo podía Rodrigo) se siguen aceptando como de Rodrigo.
//
// GET  /api/decidir?huella=1            → {huella, listo, listo_carlo}   (sin contraseña: huella = 12 hex que no revelan la llave)
// GET  /api/decidir   (x-panel-key)     → {listo, quien, puede, contestadas:[{id, opcion, boton, quien, f, previas}]}
// POST /api/decidir   (x-panel-key + x-decidir-codigo, body {id, opcion}) → {ok, id, opcion, boton, quien, f, cambio}

const crypto = require("crypto");

let SNAP = null;
try { SNAP = require("./_datos.json"); } catch (e) { SNAP = null; }

const NTFY = "https://ntfy.sh";
const VENTANA_NTFY = "12h";          // ntfy.sh guarda los mensajes 12 h
const FALLOS = new Map();            // ip -> [ms de cada fallo]
const FALLOS_VENTANA_MS = 10 * 60 * 1000;
const FALLOS_MAX = 8;
const ESPERA_FALLO_MS = 1500;
const YA = new Map();                // id -> estado ya guardado en esta instancia (además del tema)
// quién puede decidir: contraseña del panel + código para decidir, cada uno con SU variable de Vercel
const PERSONAS = [
  { quien: "Rodrigo", clave: "PANEL_PASSWORD", codigo: "PANEL_DECIDIR_CODIGO" },
  { quien: "Carlo", clave: "PANEL_PASSWORD_CARLO", codigo: "PANEL_DECIDIR_CODIGO_CARLO" },
];
const QUIENES = PERSONAS.map((p) => p.quien);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function ipDe(req) {
  const xf = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  return xf || String((req.headers && req.headers["x-real-ip"]) || "") || (req.socket && req.socket.remoteAddress) || "sin-ip";
}
function fallosRecientes(ip, ahora) {
  const lista = (FALLOS.get(ip) || []).filter((t) => ahora - t < FALLOS_VENTANA_MS);
  if (lista.length) FALLOS.set(ip, lista); else FALLOS.delete(ip);
  return lista;
}
function anotarFallo(ip, ahora) {
  const lista = fallosRecientes(ip, ahora);
  lista.push(ahora);
  FALLOS.set(ip, lista);
  if (FALLOS.size > 2000) for (const k of Array.from(FALLOS.keys())) fallosRecientes(k, ahora);
}

// comparación en tiempo constante (las dos se pasan por sha256 para que midan lo mismo)
function igual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}
function codigoListo(env, p) { const c = env[p.codigo]; return !!(c && String(c).length >= 4); }

// llave de firma y tema: derivadas de YT_CLIENT_SECRET (mismo cálculo en canal/decisiones_panel.py)
function llaves(env) {
  const raiz = (env || process.env).YT_CLIENT_SECRET;
  if (!raiz) return null;
  const K = crypto.createHmac("sha256", raiz).update("seis-estrellas/decidir/v1").digest();
  const h = (txt) => crypto.createHmac("sha256", K).update(txt).digest("hex");
  return { K, tema: "se6dec" + h("tema").slice(0, 32), huella: h("huella").slice(0, 12), firmar: (m) => h("firma\n" + canon(m)) };
}
// v1 (solo Rodrigo) · v2 (22-nov b43600f): el "quien" entra a la firma
function canon(m) {
  const campos = m.v === 2 ? ["v2", m.id, m.opcion, m.boton, m.quien, m.f, m.n] : ["v1", m.id, m.opcion, m.boton, m.f, m.n];
  return campos.map((s) => String(s == null ? "" : s)).join("\n");
}
function firmaValida(L, m) {
  if (!m || typeof m !== "object" || (m.v !== 1 && m.v !== 2) || typeof m.firma !== "string" || !/^[0-9a-f]{64}$/.test(m.firma)) return false;
  if (m.v === 2 && QUIENES.indexOf(m.quien) < 0) return false;
  const bien = L.firmar(m);
  return crypto.timingSafeEqual(Buffer.from(bien, "hex"), Buffer.from(m.firma, "hex"));
}
const quienDe = (m) => (m.v === 2 ? m.quien : "Rodrigo");

// La regla, de una lista de respuestas de UNA decisión: la primera vale; una de Rodrigo después de una de Carlo la reemplaza
// (la de Carlo pasa a "previas"); cualquier otra que llegue después se ignora. Mismo cálculo en decisiones_panel.py.
function resolver(lista) {
  const vistos = new Set();
  const xs = lista.filter((r) => r && r.f && r.opcion != null).filter((r) => {
    const k = [r.quien, r.f, r.opcion].join("\n");
    if (vistos.has(k)) return false;
    vistos.add(k); return true;
  }).sort((a, b) => (Date.parse(a.f) || 0) - (Date.parse(b.f) || 0));   // "…T04:10Z" (foto) y "…T04:10:05.123Z" (tema) por igual
  let cur = null;
  const previas = [];
  for (const r of xs) {
    if (!cur) cur = r;
    else if (cur.quien === "Carlo" && r.quien === "Rodrigo") { previas.push({ opcion: cur.opcion, quien: cur.quien, f: cur.f }); cur = r; }
  }
  return cur ? { id: cur.id, opcion: cur.opcion, boton: cur.boton, quien: cur.quien, f: cur.f, previas } : null;
}
// junta varios estados (tema, esta instancia, la foto) y vuelve a aplicar la regla
function combinar(id, estados) {
  const todas = [];
  estados.forEach((e) => { if (!e) return; (e.previas || []).forEach((p) => todas.push(Object.assign({ id }, p))); todas.push(Object.assign({}, e, { id })); });
  return resolver(todas);
}

// la decisión en la foto: pendiente, o contestada por Carlo (Rodrigo todavía puede cambiarla)
function decisionDe(snap, id) {
  const x = ((snap && snap.decisiones_pendientes) || []).find((d) => d && d.id === id);
  if (!x || !x.pregunta || !Array.isArray(x.opciones) || x.opciones.length < 2) return null;
  if (x.respuesta && x.quien !== "Carlo") return null;   // contestada por el CEO (Oficina, chat o panel): ya no se toca aquí
  return x;
}
function estadoFoto(x) {
  return x && x.respuesta && x.quien === "Carlo"
    ? { id: x.id, opcion: x.respuesta, boton: x.respuesta === x.recomendacion ? "si" : "no", quien: "Carlo", f: x.t_respuesta || "0", previas: [] }
    : null;
}

async function conTiempo(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); } finally { clearTimeout(t); }
}

// respuestas firmadas que ya están en el tema → {id: estado según la regla}
async function leerTema(L) {
  const r = await conTiempo(NTFY + "/" + L.tema + "/json?poll=1&since=" + VENTANA_NTFY, { headers: { Accept: "application/x-ndjson" } }, 6000);
  if (!r.ok) throw new Error("ntfy " + r.status);
  const txt = await r.text();
  const por = {};
  txt.split("\n").forEach((l) => {
    if (!l.trim()) return;
    let ev, m;
    try { ev = JSON.parse(l); } catch (e) { return; }
    if (!ev || ev.event !== "message" || typeof ev.message !== "string") return;
    try { m = JSON.parse(ev.message); } catch (e) { return; }
    if (!firmaValida(L, m)) return;
    (por[m.id] = por[m.id] || []).push({ id: m.id, opcion: m.opcion, boton: m.boton, quien: quienDe(m), f: m.f });
  });
  const out = {};
  Object.keys(por).forEach((id) => { out[id] = resolver(por[id]); });
  return out;
}

async function cuerpo(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  let raw = "";
  if (typeof req.body === "string") raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString("utf8");
  else {
    raw = await new Promise((ok, mal) => {
      let s = "";
      req.on("data", (c) => { s += c; if (s.length > 4096) { mal(new Error("grande")); req.destroy(); } });
      req.on("end", () => ok(s));
      req.on("error", mal);
    });
  }
  if (raw.length > 4096) throw new Error("grande");
  return raw ? JSON.parse(raw) : {};
}

function crearHandler(deps) {
  const D = Object.assign({ env: process.env, snap: SNAP, fetch: null, esperar }, deps || {});
  if (D.fetch) global.fetch = D.fetch;   // solo en las pruebas locales
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const fin = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
    const env = D.env;
    const L = llaves(env);
    const url = new URL(req.url || "/", "http://x");

    if (req.method === "GET" && url.searchParams.get("huella")) {
      return fin(200, { huella: L ? L.huella : null, listo: !!L && codigoListo(env, PERSONAS[0]), listo_carlo: !!L && codigoListo(env, PERSONAS[1]) });
    }
    if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return fin(405, { error: "Método no permitido" }); }

    const ip = ipDe(req);
    const recientes = fallosRecientes(ip, Date.now());
    if (recientes.length >= FALLOS_MAX) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((recientes[0] + FALLOS_VENTANA_MS - Date.now()) / 1000))));
      return fin(429, { error: "Demasiados intentos, espera 10 minutos" });
    }
    // 1) la contraseña del panel dice QUIÉN es (Rodrigo primero: si alguien pusiera la misma en las dos, cuenta como Rodrigo)
    const clave = String(req.headers["x-panel-key"] || "");
    const P = clave ? PERSONAS.find((p) => env[p.clave] && igual(clave, String(env[p.clave]))) : null;
    if (!P) { anotarFallo(ip, Date.now()); await D.esperar(ESPERA_FALLO_MS); return fin(401, { error: "Contraseña incorrecta" }); }
    const quien = P.quien;
    const listo = !!L && codigoListo(env, P);

    if (req.method === "GET") {
      let contestadas = {};
      let aviso = null;
      if (L) {
        try { contestadas = await leerTema(L); } catch (e) { aviso = "No pude revisar las respuestas guardadas (" + String(e.message || e).slice(0, 40) + ")"; }
      }
      for (const [id, v] of YA) contestadas[id] = combinar(id, [contestadas[id], v]);
      return fin(200, { listo, quien, puede: true, contestadas: Object.values(contestadas).filter(Boolean), aviso });
    }

    // POST: decidir. 2) el código tiene que ser el de ESA persona
    if (!listo) {
      return fin(503, { error: "Falta activar el código para decidir de " + quien + " (variable " + P.codigo + " en Vercel)", listo: false });
    }
    const codigo = String(req.headers["x-decidir-codigo"] || "");
    if (!igual(codigo, String(env[P.codigo]))) {
      anotarFallo(ip, Date.now()); await D.esperar(ESPERA_FALLO_MS);
      return fin(401, { error: "Código para decidir incorrecto", codigo: false });
    }
    let b;
    try { b = await cuerpo(req); } catch (e) { return fin(400, { error: "Cuerpo inválido" }); }
    const id = String((b && b.id) || "");
    const opcion = typeof (b && b.opcion) === "string" ? b.opcion : "";
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id) || !opcion || opcion.length > 400) return fin(400, { error: "Falta la decisión o la opción" });
    const dec = decisionDe(D.snap, id);
    if (!dec) return fin(404, { error: "Esa decisión ya no está pendiente en el panel" });
    if (dec.opciones.indexOf(opcion) < 0) return fin(400, { error: "Esa opción no es de esta decisión" });

    // 3) la regla: ¿ya hay respuesta? (tema de ntfy + esta instancia + la foto)
    let tema = null;
    try { tema = (await leerTema(L))[id] || null; } catch (e) { tema = null; /* sin poder revisar: se guarda; decisiones_panel.py aplica la misma regla */ }
    const ya = combinar(id, [tema, YA.get(id), estadoFoto(dec)]);
    if (ya) {
      YA.set(id, ya);
      if (ya.quien === "Rodrigo") return fin(409, { error: quien === "Rodrigo" ? "Ya la habías contestado" : "Ya la contestó Rodrigo: su respuesta manda", ya });
      if (quien === "Carlo") return fin(409, { error: "Ya estaba contestada por Carlo", ya });
      // Rodrigo cambia la de Carlo: se guarda la suya (gana) y la de Carlo queda en el historial
    }

    const m = { v: 2, id, opcion, boton: opcion === dec.recomendacion ? "si" : "no", quien, f: new Date().toISOString(), n: crypto.randomBytes(8).toString("hex") };
    m.firma = L.firmar(m);
    try {
      const r = await conTiempo(NTFY + "/" + L.tema, { method: "POST", body: JSON.stringify(m), headers: { "Content-Type": "text/plain; charset=utf-8", Title: "decision", Priority: "1", Firebase: "no", Tags: "panel" } }, 8000);
      if (!r.ok) throw new Error("ntfy " + r.status);
    } catch (e) {
      return fin(502, { error: "No se pudo guardar ahora (" + String(e.message || e).slice(0, 40) + "). Toca otra vez en un minuto." });
    }
    const nuevo = { id, opcion, boton: m.boton, quien, f: m.f };
    const v = combinar(id, [ya, Object.assign({ previas: [] }, nuevo)]);
    YA.set(id, v);
    return fin(200, Object.assign({ ok: true }, nuevo, { previas: v.previas, cambio: ya ? { opcion: ya.opcion, quien: ya.quien, f: ya.f } : null }));
  };
}

module.exports = crearHandler();
module.exports.crearHandler = crearHandler;
module.exports._llaves = llaves;
module.exports._resolver = resolver;
