# Seis Estrellas · Centro

Panel del canal Seis Estrellas (GTA 6 en español): YouTube, Instagram, Facebook y TikTok.

- `index.html`: la página (pide contraseña).
- `api/stats.js`: YouTube en vivo (con caché y respaldo al feed público si se acaba la cuota) + la foto de métricas.
- `api/_datos.json`: foto de métricas de las 4 redes. La actualiza Claude cada hora con un commit; Vercel despliega solo.
- Las llaves viven en las variables de entorno de Vercel (nunca en este repo).
