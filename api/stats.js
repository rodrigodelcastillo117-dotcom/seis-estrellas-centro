// Seis Estrellas · centro de control
// YouTube en vivo (API, solo lectura) con respaldo que no se cae: si no hay cuota, usa el feed público de YouTube
// (vistas y likes de los publicados, sin cuota) y la última foto (_datos.json). Instagram y Facebook vienen de la foto,
// que se genera cada hora con panel_snapshot.py y se publica con el despliegue.
// Variables de entorno (Vercel): YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN, PANEL_PASSWORD

let SNAP = null;
try { SNAP = require("./_datos.json"); } catch (e) { SNAP = null; }

const CANAL_ID = "UCoj0-9kNTw_ueI3TUP2vr4w";
let CACHE = { at: 0, data: null };
const CACHE_MS = 10 * 60 * 1000; // 3 unidades de cuota por lectura: máximo una lectura cada 10 min por instancia
let RSS = { at: 0, data: null };
const RSS_MS = 5 * 60 * 1000;
let SIN_CUOTA_HASTA = 0; // si YouTube dice "quota", no volvemos a preguntar hasta que se reinicie

function proximoReinicio() {
  // la cuota diaria se reinicia a medianoche hora del Pacífico (08:00 UTC en invierno); usamos 08:05 UTC
  const d = new Date();
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 5));
  if (r <= d) r.setUTCDate(r.getUTCDate() + 1);
  return r.getTime();
}

async function accessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.YT_CLIENT_ID,
      client_secret: process.env.YT_CLIENT_SECRET,
      refresh_token: process.env.YT_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("No se pudo renovar el permiso de YouTube: " + (j.error_description || j.error || r.status));
  return j.access_token;
}

async function yt(path, token) {
  const r = await fetch("https://www.googleapis.com/youtube/v3/" + path, { headers: { Authorization: "Bearer " + token } });
  const j = await r.json();
  if (!r.ok) throw new Error("YouTube " + r.status + ": " + ((j.error && j.error.message) || "error"));
  return j;
}

function origen(desc) {
  const d = (desc || "").toLowerCase();
  if (d.includes("gameplay real")) return "Gameplay real";
  if (d.includes("creadas con ia")) return "IA";
  return "Otro";
}

function isoDur(s) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || "");
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

async function leerCanal() {
  const token = await accessToken();
  const chs = await yt("channels?part=snippet,statistics,contentDetails&mine=true", token);
  const ch = chs.items && chs.items[0];
  if (!ch) throw new Error("El permiso no tiene canal");
  const uploads = ch.contentDetails.relatedPlaylists.uploads;
  const ids = [];
  let page = "";
  do {
    const pl = await yt("playlistItems?part=contentDetails&maxResults=50&playlistId=" + uploads + (page ? "&pageToken=" + page : ""), token);
    (pl.items || []).forEach((i) => ids.push(i.contentDetails.videoId));
    page = pl.nextPageToken || "";
  } while (page && ids.length < 500);
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt("videos?part=snippet,status,statistics,contentDetails&id=" + ids.slice(i, i + 50).join(","), token);
    (r.items || []).forEach((v) => {
      const s = v.status || {}, st = v.statistics || {}, sn = v.snippet || {};
      videos.push({
        id: v.id, t: sn.title, o: origen(sn.description), priv: s.privacyStatus, prog: s.publishAt || null,
        pub: s.privacyStatus === "public" ? sn.publishedAt : null, proc: s.uploadStatus,
        v: Number(st.viewCount || 0), l: Number(st.likeCount || 0), c: Number(st.commentCount || 0),
        dur: isoDur((v.contentDetails || {}).duration),
      });
    });
  }
  const cs = ch.statistics || {};
  return {
    fuente: "vivo", act: new Date().toISOString(),
    canal: { t: ch.snippet.title, h: ch.snippet.customUrl || "", subs: Number(cs.subscriberCount || 0), v: Number(cs.viewCount || 0), n: Number(cs.videoCount || 0) },
    videos,
  };
}

function desEscapa(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function leerRSS() {
  if (RSS.data && Date.now() - RSS.at < RSS_MS) return RSS.data;
  const r = await fetch("https://www.youtube.com/feeds/videos.xml?channel_id=" + CANAL_ID, { headers: { "User-Agent": "Mozilla/5.0 panel" } });
  if (!r.ok) throw new Error("feed " + r.status);
  const x = await r.text();
  const out = {};
  (x.match(/<entry>[\s\S]*?<\/entry>/g) || []).forEach((e) => {
    const g = (re) => { const m = re.exec(e); return m ? m[1] : null; };
    const id = g(/<yt:videoId>([^<]+)/);
    if (!id) return;
    out[id] = { t: desEscapa(g(/<title>([^<]*)/)), pub: (g(/<published>([^<]+)/) || "").replace("+00:00", "Z"),
      v: Number(g(/<media:statistics views="(\d+)"/) || 0), l: Number(g(/<media:starRating count="(\d+)"/) || 0) };
  });
  RSS = { at: Date.now(), data: out };
  return out;
}

// Respaldo: última foto + feed público encima (vistas y likes al momento de los publicados)
async function respaldo(motivo) {
  const base = (SNAP && SNAP.yt) || { canal: { t: "Seis Estrellas", h: "@seisestrellasmx", subs: null }, videos: [] };
  const vids = {};
  (base.videos || []).forEach((v) => { vids[v.id] = Object.assign({}, v); });
  let fuente = "foto", act = base.act || (SNAP && SNAP.act) || null;
  try {
    const feed = await leerRSS();
    Object.keys(feed).forEach((id) => {
      const x = vids[id] || (vids[id] = { id, priv: "public", prog: null, proc: "processed", c: null, dur: null, o: "Otro" });
      Object.assign(x, feed[id], { priv: "public" });
    });
    fuente = "rss"; act = new Date().toISOString();
  } catch (e) { /* sin feed: queda la foto */ }
  const aviso = (motivo === "cuota"
    ? "Se acabó la cuota diaria de la API de YouTube (se comparte con las subidas; se reinicia a las 02:05 CDMX). "
    : "La API de YouTube no respondió. ") +
    (fuente === "rss" ? "Las vistas y likes de los publicados vienen del feed público de YouTube (al momento); suscriptores, comentarios y programados son de la última lectura buena."
      : "Se muestran los datos de la última foto.");
  return { fuente, act, aviso, canal: base.canal, videos: Object.values(vids), canal_act: base.act || null };
}

function conRetencion(y) {
  const an = (SNAP && SNAP.yt && SNAP.yt.an) || {};
  const pv = an.video || {};
  y.videos = (y.videos || []).map((v) => pv[v.id] ? Object.assign({}, v, { pct: pv[v.id].pct, avd: pv[v.id].avd, ev: pv[v.id].ev }) : v);
  y.an = { act: an.act || null, dias: an.dias || [], nota: an.nota || null };
  return y;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!process.env.PANEL_PASSWORD || (req.headers["x-panel-key"] || "") !== process.env.PANEL_PASSWORD) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Contraseña incorrecta" }));
    return;
  }
  let y;
  const sinCuota = Date.now() < SIN_CUOTA_HASTA;
  try {
    if (sinCuota) throw new Error("quota");
    if (!CACHE.data || Date.now() - CACHE.at > CACHE_MS) CACHE = { at: Date.now(), data: await leerCanal() };
    y = CACHE.data;
  } catch (e) {
    const msg = String((e && e.message) || e);
    const cuota = /quota/i.test(msg);
    if (cuota) SIN_CUOTA_HASTA = proximoReinicio();
    if (CACHE.data && !cuota && Date.now() - CACHE.at < 3 * 3600e3) {
      y = Object.assign({}, CACHE.data, { fuente: "cache", aviso: "La API de YouTube no respondió; datos de la última lectura en vivo." });
    } else {
      try { y = await respaldo(cuota ? "cuota" : "error"); } catch (e2) { y = { fuente: "nada", aviso: "Sin datos de YouTube por ahora.", canal: {}, videos: [] }; }
    }
    if (cuota) y.reintento = new Date(SIN_CUOTA_HASTA).toISOString();
  }
  const out = {
    ahora: new Date().toISOString(),
    yt: conRetencion(Object.assign({}, y)),
    ig: (SNAP && SNAP.ig) || null,
    fb: (SNAP && SNAP.fb) || null,
    tt: (SNAP && SNAP.tt) || null,
    oficina: (SNAP && SNAP.oficina) || null,
    foto: (SNAP && SNAP.act) || null,
    faltan: (SNAP && SNAP.faltan) || [],
  };
  res.statusCode = 200;
  res.end(JSON.stringify(out));
};
