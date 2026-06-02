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
  pixelId: '990096973809534',  // ← Meta Pixel-/Datensatz-ID (BB Brands Web)
  ga4Id: 'G-C8SDVBEGPK',  // ← GA4 Mess-ID (BB Brands)
  debug: false,           // true = Konsolen-Logs zum Debuggen
  // 'auto' = Interim: GA4 lädt sofort, Meta-Pixel wartet auf CMP-Opt-in.
  // Sobald die CMP (Cookiebot/Usercentrics) steht → auf 'cmp' umstellen.
  consentMode: 'auto',
};
