// Estado del panel sin datos del canal (para revisar que está arriba sin contraseña): solo fechas de la última foto.
let SNAP = null;
try { SNAP = require("./_datos.json"); } catch (e) { SNAP = null; }

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const f = (k) => (SNAP && SNAP[k] && SNAP[k].act) || null;
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, ahora: new Date().toISOString(), foto: (SNAP && SNAP.act) || null,
    plataformas: { youtube: f("yt"), instagram: f("ig"), facebook: f("fb") }, faltan: SNAP && SNAP.faltan ? SNAP.faltan.length : null }));
};
