/* ============================================================
   BB Brands — Tracking-Konfiguration
   Diese EINE Datei füllst du (bzw. Claude) mit den echten IDs.
   Alle IDs hier sind ÖFFENTLICH (stehen ohnehin im Browser).
   Das geheime CAPI-Token gehört NICHT hierher — das liegt als
   Env-Var META_CAPI_TOKEN in Vercel.

   Solange pixelId/ga4Id leer sind, lädt bb-tracking.js NICHTS
   (kompletter No-Op). Erst ausfüllen, wenn die IDs vorliegen.
   ============================================================ */
window.BB_TRACKING = {
  pixelId: '',            // ← Schritt 1: Meta Pixel-/Datensatz-ID (z.B. '1234567890123456')
  ga4Id: '',              // ← Schritt 4: GA4 Mess-ID (z.B. 'G-XXXXXXXXXX')
  debug: false,           // true = Konsolen-Logs zum Debuggen
};
