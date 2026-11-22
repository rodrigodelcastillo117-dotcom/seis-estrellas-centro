// Estado del panel sin datos del canal (para revisar que está arriba sin contraseña): solo fechas y banderas de la última foto.
// 22-nov (b8bd47b): antes devolvía ok:true siempre (aunque la foto tuviera días), con la misma fecha repetida por red y sin TikTok ni la oficina.
let SNAP = null;
try { SNAP = require("./_datos.json"); } catch (e) { SNAP = null; }

const min = (iso, ahora) => { const t = Date.parse(iso && iso.length === 17 ? iso.replace("Z", ":00Z") : iso); return isNaN(t) ? null : Math.max(0, Math.round((ahora - t) / 60000)); };

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const ahora = Date.now();
  const S = SNAP || {};
  const f = (k) => (S[k] && S[k].act) || null;
  const edadFoto = min(S.act, ahora);
  const of = S.oficina_vivo && S.oficina_vivo.t || null;
  const edadOf = min(of, ahora);
  // sano = la foto existe y tiene menos de 3 h (se toma cada hora); la oficina en vivo viene en la misma foto
  const sano = edadFoto !== null && edadFoto < 180 && edadOf !== null && edadOf < 180;
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: sano, ahora: new Date(ahora).toISOString(), foto: S.act || null, edad_foto_min: edadFoto,
    oficina: of, edad_oficina_min: edadOf,
    plataformas: { youtube: f("yt"), instagram: f("ig"), facebook: f("fb"), tiktok: f("tt") },
    faltan: S.faltan ? S.faltan.length : null,
    youtube_fuente: (S.yt && S.yt.fuente) || null,
    avisos: [edadFoto === null ? "sin foto" : null, edadFoto !== null && edadFoto >= 180 ? "foto de hace más de 3 h" : null, edadOf === null ? "sin oficina en vivo" : null].filter(Boolean),
  }));
};
