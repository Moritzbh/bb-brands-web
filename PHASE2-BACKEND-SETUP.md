# Phase 2 — Backend-Setup-Dokumentation

> **Status:** Phase 1 ist live. Phase 2 (Lead-API + Admin-Dashboard + Customer-Auth + Customer-Portal) wartet auf Backend-Setup. Diese Datei beschreibt, was du als User einmalig konfigurieren musst, bevor ich Phase 2 baue.

## Was Phase 2 enthält

1. **`/api/leads`** — Vercel Function: speichert Lead-Submissions in Upstash Redis, schickt formatierte E-Mail via Resend an `info@bb-brands.de`, schickt Push-Notification via ntfy.sh aufs Handy.
2. **`/admin/`** — internes Dashboard: alle Leads sehen, filtern (Erstgespräch / WhatsApp / Referenz-OK), Status-Updates inline.
3. **`/api/preview-auth`** — Customer-Auth-Backend: Slug + Passwort → JWT-Token (HMAC-signed), Rate-Limiting (5 Versuche/Minute), 14-Tage-Token-Validität.
4. **`/api/onboarding-submit`** — separater Endpoint für Customer-Portal-Form-Submissions.
5. **`/kunden/{slug}/...`** — Customer-Portal-Pages (Onboarding, Scope-Brief, Vertrag, Konzept-Subordner). Templates pro Kunde befüllbar.

## ENV-Variablen die du in Vercel setzen musst

Geh in dein Vercel-Dashboard → `bb-brands-web` Project → Settings → Environment Variables. Setz für **Production + Preview + Development**:

### Upstash Redis (Lead-Storage + Customer-Auth)

```
KV_REST_API_URL=https://...upstash.io
KV_REST_API_TOKEN=AX...
```

**So bekommst du sie:**
1. Konto auf [upstash.com](https://upstash.com) anlegen (kostenlos bis 10k Requests/Tag — reicht easy)
2. Neue Redis-Datenbank → Region **eu-central-1 (Frankfurt)** wählen (DSGVO-konform, in der Datenschutz-Page so dokumentiert)
3. Tab "REST API" → kopiere `UPSTASH_REDIS_REST_URL` und `UPSTASH_REDIS_REST_TOKEN`
4. In Vercel als `KV_REST_API_URL` und `KV_REST_API_TOKEN` einsetzen (das sind die Aliase, die der alte Code erwartet)

### Resend (E-Mail-Versand für Leads)

```
RESEND_API_KEY=re_...
NOTIFY_EMAIL=info@bb-brands.de
NOTIFY_FROM=BB Brands Lead <leads@bb-brands.de>
```

**So bekommst du sie:**
1. Konto auf [resend.com](https://resend.com) anlegen
2. Domain `bb-brands.de` verifizieren (DNS-Records eintragen — DKIM, SPF)
3. API Keys → Erstellen → kopieren
4. `NOTIFY_FROM` muss eine Adresse auf der verifizierten Domain sein (z.B. `leads@bb-brands.de`)

### ntfy.sh (Push-Notifications aufs Handy)

```
NTFY_TOPIC=bb-brands-leads-randomstring123
NTFY_SERVER=https://ntfy.sh
```

**So bekommst du sie:**
1. App "ntfy" aufs Handy installieren (iOS + Android)
2. App öffnen → "Add Subscription" → eindeutigen Topic-Namen (z.B. `bb-brands-leads-RANDOMSTRING`)
3. Diesen Topic als `NTFY_TOPIC` in Vercel eintragen
4. Bei jedem Lead bekommst du Push-Notification mit Vorschau

### Admin-Token (Lead-Dashboard)

```
ADMIN_TOKEN=ein-zufaelliger-string-mit-32-plus-zeichen-XYZ123abc
```

**So machst du den:**
- Random-String generieren: `openssl rand -base64 32`
- In Vercel als `ADMIN_TOKEN` einsetzen
- Du brauchst diesen Token, um dich in `/admin/` einzuloggen

### Preview-Auth-Secret (Customer-Login)

```
BB_PREVIEW_SECRET=ein-zufaelliger-string-mit-32-plus-zeichen-ABC987xyz
```

**So machst du den:**
- Wieder `openssl rand -base64 32`
- In Vercel als `BB_PREVIEW_SECRET` einsetzen
- Wird für HMAC-Signatur der JWT-Tokens verwendet

## Checkliste

- [ ] Upstash Redis (eu-central-1) angelegt
- [ ] `KV_REST_API_URL` + `KV_REST_API_TOKEN` in Vercel
- [ ] Resend-Account + Domain verifiziert (DNS-Records)
- [ ] `RESEND_API_KEY` + `NOTIFY_EMAIL` + `NOTIFY_FROM` in Vercel
- [ ] ntfy-App installiert + Topic abonniert
- [ ] `NTFY_TOPIC` + `NTFY_SERVER` in Vercel
- [ ] `ADMIN_TOKEN` generiert + in Vercel
- [ ] `BB_PREVIEW_SECRET` generiert + in Vercel
- [ ] Im Vercel-Dashboard: Project Settings → Functions → Region: **fra1 (Frankfurt)** wählen

## Wenn alles steht — sag mir Bescheid

Sobald alle 7 ENV-Vars in Vercel stehen, sag mir hier im Chat:
> "Phase 2 backend ist setup, baue Lead-API + Admin-Dashboard + Customer-Auth + Portal-Templates"

Dann lege ich los — Aufwand ca. 8–14 Tage Code-Volumen, wird in mehreren Commits ausgerollt.

## Was erstmal noch nicht geht (Phase 1-Status)

- **`/audit/` Form** schickt aktuell `mailto:` (öffnet dein E-Mail-Programm). Funktioniert, ist aber suboptimal — User braucht installierten Mail-Client.
- **`/kunden/`** zeigt aktuell eine Coming-Soon-Stub-Page — Login-Form ist nur visuell, kein Backend.
- **Attribution-Tracker** (`assets/js/attribution.js`) läuft bereits + sammelt UTMs/Referrer in sessionStorage. Noch nicht ans Form gehängt — kommt mit Phase 2.

## Voraussetzung für Phase 2 (technisch)

- Vercel Pro Plan (oder kostenlos OK, aber dann keine private Functions-Logs) — du hast schon Pro?
- Domain `bb-brands.de` muss in Vercel + auf Resend funktionieren
- Funktionierendes E-Mail-Postfach `info@bb-brands.de` (das hast du)
