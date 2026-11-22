// 22-nov (becario bb01297) · El CEO: «aquí debería de poder decidir también con una palomita o tache».
// Contestar una decisión pendiente desde el panel: ✓ = la opción recomendada, ✗ = otra opción.
//
// QUIÉN: solo el CEO. Hacen falta las dos cosas: su contraseña del panel (x-panel-key = PANEL_PASSWORD; la de Carlo no sirve)
//   y su código para decidir (x-decidir-codigo = PANEL_DECIDIR_CODIGO, variable de entorno de Vercel que pone el CEO).
//   Sin PANEL_DECIDIR_CODIGO no se puede decidir (responde 503). Mismo freno que api/stats.js: 1.5 s por intento malo y
//   429 tras 8 fallos en 10 min por IP. Nunca se registra (console), se guarda ni se devuelve una contraseña o un código.
// DÓNDE SE GUARDA: el proyecto no tiene almacenamiento en Vercel (ni Blob, ni KV, ni Edge Config) y no se creó uno.
//   La respuesta {id, opcion, f} va FIRMADA (HMAC-SHA256) a un tema privado de ntfy.sh, el mismo servicio gratis de los
//   avisos al celular; ntfy la guarda 12 h. canal/decisiones_panel.py la lee en cada foto del panel (revisión de cada hora),
//   revisa la firma y la escribe en decisiones_ceo.json igual que una respuesta de la Oficina.
//   La llave de la firma y el nombre del tema salen de YT_CLIENT_SECRET (ya está en Vercel y en el sistema): no hay que mover
//   ningún secreto nuevo. Sin la llave nadie puede leer el tema ni falsificar una respuesta.
// NO SE CONTESTA DOS VECES: antes de guardar se revisa el tema; si ya hay una respuesta firmada de esa decisión → 409.
//   Además decisiones_panel.py se queda con la PRIMERA y no toca una decisión que ya tenga respuesta.
//
// GET  /api/decidir?huella=1            → {huella, listo}   (sin contraseña: huella = 12 hex que no revelan la llave)
// GET  /api/decidir   (x-panel-key)     → {listo, puede, contestadas:[{id, opcion, boton, f}]}
// POST /api/decidir   (x-panel-key + x-decidir-codigo, body {id, opcion}) → {ok, id, opcion, boton, f}

const crypto = require("crypto");

let SNAP = null;
try { SNAP = require("./_datos.json"); } catch (e) { SNAP = null; }

const NTFY = "https://ntfy.sh";
const VENTANA_NTFY = "12h";          // ntfy.sh guarda los mensajes 12 h
const FALLOS = new Map();            // ip -> [ms de cada fallo]
const FALLOS_VENTANA_MS = 10 * 60 * 1000;
const FALLOS_MAX = 8;
const ESPERA_FALLO_MS = 1500;
const YA = new Map();                // id -> respuesta ya guardada en esta instancia (además del tema)

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

// llave de firma y tema: derivadas de YT_CLIENT_SECRET (mismo cálculo en canal/decisiones_panel.py)
function llaves(env) {
  const raiz = (env || process.env).YT_CLIENT_SECRET;
  if (!raiz) return null;
  const K = crypto.createHmac("sha256", raiz).update("seis-estrellas/decidir/v1").digest();
  const h = (txt) => crypto.createHmac("sha256", K).update(txt).digest("hex");
  return { K, tema: "se6dec" + h("tema").slice(0, 32), huella: h("huella").slice(0, 12), firmar: (m) => h("firma\n" + canon(m)) };
}
function canon(m) {
  return ["v1", m.id, m.opcion, m.boton, m.f, m.n].map((s) => String(s == null ? "" : s)).join("\n");
}
function firmaValida(L, m) {
  if (!m || typeof m !== "object" || m.v !== 1 || typeof m.firma !== "string" || !/^[0-9a-f]{64}$/.test(m.firma)) return false;
  const bien = L.firmar(m);
  return crypto.timingSafeEqual(Buffer.from(bien, "hex"), Buffer.from(m.firma, "hex"));
}

function pendientes(snap) {
  return ((snap && snap.decisiones_pendientes) || []).filter((x) => x && x.id && x.pregunta && !x.respuesta && Array.isArray(x.opciones) && x.opciones.length >= 2);
}

async function conTiempo(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); } finally { clearTimeout(t); }
}

// respuestas firmadas que ya están en el tema (la primera de cada decisión)
async function leerTema(L) {
  const r = await conTiempo(NTFY + "/" + L.tema + "/json?poll=1&since=" + VENTANA_NTFY, { headers: { Accept: "application/x-ndjson" } }, 6000);
  if (!r.ok) throw new Error("ntfy " + r.status);
  const txt = await r.text();
  const out = {};
  txt.split("\n").forEach((l) => {
    if (!l.trim()) return;
    let ev, m;
    try { ev = JSON.parse(l); } catch (e) { return; }
    if (!ev || ev.event !== "message" || typeof ev.message !== "string") return;
    try { m = JSON.parse(ev.message); } catch (e) { return; }
    if (!firmaValida(L, m)) return;
    if (!out[m.id] || String(m.f) < String(out[m.id].f)) out[m.id] = { id: m.id, opcion: m.opcion, boton: m.boton, f: m.f };
  });
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
    const codigoListo = !!(env.PANEL_DECIDIR_CODIGO && String(env.PANEL_DECIDIR_CODIGO).length >= 4);
    const url = new URL(req.url || "/", "http://x");

    if (req.method === "GET" && url.searchParams.get("huella")) return fin(200, { huella: L ? L.huella : null, listo: !!L && codigoListo });
    if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return fin(405, { error: "Método no permitido" }); }

    const ip = ipDe(req);
    const recientes = fallosRecientes(ip, Date.now());
    if (recientes.length >= FALLOS_MAX) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((recientes[0] + FALLOS_VENTANA_MS - Date.now()) / 1000))));
      return fin(429, { error: "Demasiados intentos, espera 10 minutos" });
    }
    const clave = String(req.headers["x-panel-key"] || "");
    const USUARIOS = [["Rodrigo", env.PANEL_PASSWORD], ["Carlo", env.PANEL_PASSWORD_CARLO]];
    const quien = clave ? USUARIOS.find(([, c]) => c && igual(clave, c)) : null;
    if (!quien) { anotarFallo(ip, Date.now()); await D.esperar(ESPERA_FALLO_MS); return fin(401, { error: "Contraseña incorrecta" }); }
    const esCEO = quien[0] === "Rodrigo";

    if (req.method === "GET") {
      let contestadas = [];
      let aviso = null;
      if (L) {
        try { contestadas = Object.values(await leerTema(L)); } catch (e) { aviso = "No pude revisar las respuestas guardadas (" + String(e.message || e).slice(0, 40) + ")"; }
      }
      for (const [id, v] of YA) if (!contestadas.some((c) => c.id === id)) contestadas.push(v);
      return fin(200, { listo: !!L && codigoListo, puede: esCEO, contestadas, aviso });
    }

    // POST: decidir
    if (!esCEO) return fin(403, { error: "Solo el CEO puede decidir desde el panel" });
    if (!L || !codigoListo) return fin(503, { error: "Falta activar el código para decidir (variable PANEL_DECIDIR_CODIGO en Vercel)", listo: false });
    const codigo = String(req.headers["x-decidir-codigo"] || "");
    if (!igual(codigo, String(env.PANEL_DECIDIR_CODIGO))) {
      anotarFallo(ip, Date.now()); await D.esperar(ESPERA_FALLO_MS);
      return fin(401, { error: "Código para decidir incorrecto", codigo: false });
    }
    let b;
    try { b = await cuerpo(req); } catch (e) { return fin(400, { error: "Cuerpo inválido" }); }
    const id = String((b && b.id) || "");
    const opcion = typeof (b && b.opcion) === "string" ? b.opcion : "";
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(id) || !opcion || opcion.length > 400) return fin(400, { error: "Falta la decisión o la opción" });
    const dec = pendientes(D.snap).find((x) => x.id === id);
    if (!dec) return fin(404, { error: "Esa decisión ya no está pendiente en el panel" });
    if (dec.opciones.indexOf(opcion) < 0) return fin(400, { error: "Esa opción no es de esta decisión" });

    let ya = YA.get(id) || null;
    if (!ya) { try { ya = (await leerTema(L))[id] || null; } catch (e) { ya = null; /* sin poder revisar: se guarda; decisiones_panel.py se queda con la primera */ } }
    if (ya) { YA.set(id, ya); return fin(409, { error: "Ya estaba contestada", ya }); }

    const m = { v: 1, id, opcion, boton: opcion === dec.recomendacion ? "si" : "no", f: new Date().toISOString(), n: crypto.randomBytes(8).toString("hex") };
    m.firma = L.firmar(m);
    try {
      const r = await conTiempo(NTFY + "/" + L.tema, { method: "POST", body: JSON.stringify(m), headers: { "Content-Type": "text/plain; charset=utf-8", Title: "decision", Priority: "1", Firebase: "no", Tags: "panel" } }, 8000);
      if (!r.ok) throw new Error("ntfy " + r.status);
    } catch (e) {
      return fin(502, { error: "No se pudo guardar ahora (" + String(e.message || e).slice(0, 40) + "). Toca otra vez en un minuto." });
    }
    const v = { id, opcion, boton: m.boton, f: m.f };
    YA.set(id, v);
    return fin(200, Object.assign({ ok: true }, v));
  };
}

module.exports = crearHandler();
module.exports.crearHandler = crearHandler;
module.exports._llaves = llaves;
