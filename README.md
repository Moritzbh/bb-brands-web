# bb-brands-web

Website von **BB Brands** — AI-native Growth Infrastructure für DTC-Brands.

Live: [bb-brands.de](https://bb-brands.de) (nach Deploy)

---

## Stack

Statisches HTML/CSS. Kein Build-Step. Kein JS-Framework. Bewusst minimalistisch — schnelles Iterieren > Architektur-Overhead.

- HTML5 + Vanilla CSS (keine Pre-Processoren)
- Shared CSS-Tokens unter `assets/css/shared.css`
- Page-spezifisches CSS inline pro Page (während die Site noch volatil ist)
- Deploy: Vercel · static hosting

---

## Struktur

```
/                       Home — One-Pager, Premium-Anker
/cases/                 Case-Übersicht (Hearo, Bachgold, …)
/cases/[brand]/         Detail pro Case (kommt nach erstem Push)
/audit/                 Strategy-Audit-Apply (Conversion-Page)
/ueber/                 Founder + Spezialisten-Netzwerk
/wissen/                Wissen-Hub · SEO Top-of-Funnel (Migration läuft)
/founder-os/            Kurs-Sales-Page (Subdomain folgt)
/impressum/             Legal
/datenschutz/           Legal

/assets/css/shared.css  Color-Tokens, Base, Nav, Footer
/assets/images/         Logos, Cases, OG
/assets/js/             (noch leer)
```

---

## Conventions

- **Voice:** Direkt, klar, "so ist es". Kein Corporate-Deutsch. Source: `01-agentur/_strategy/REPOSITIONING.md` §13.
- **Color-Token:** `--accent: #ff6b3d` ist Brand-Anker. Nicht ändern ohne Reposition-Update.
- **Apply-CTA:** Immer "Audit anfragen" / "Strategy Audit anfragen" — identisch beschriftet auf jeder Page. Single Funnel-Ziel: `/audit/`.
- **Pricing:** Keine Preise auf der Site. Pricing-Diskussion im Strategy-Audit-Call.
- **Email:** Form-Submissions gehen an `info@bb-brands.de`.

---

## Iteration

1. Iteration 1 (heute): Home + Stubs für /cases /audit /ueber /wissen /founder-os.
2. Iteration 2: Echte Hearo + Bachgold Mockups, Case-Detail-Pages, Founder-Foto.
3. Iteration 3: Wissen-Hub-Migration (Categories, Featured, Newsletter-Form).
4. Iteration 4: Founder-OS Sales-Landingpage (Subdomain).

---

## Deploy

Vercel. Static hosting via `vercel.json`. Auto-Deploy bei Push auf `main`.

```bash
# Lokal previewen:
open index.html

# Push:
git add .
git commit -m "..."
git push
```
