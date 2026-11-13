# Streetlight

Navigation apps pick the fastest route. Streetlight helps you pick the **safest** one, using anonymous, community-verified reports, with SOS, trip check-in and a fake call built in. No sign-up, no personal data.

![Area safety score](docs/01-area-safety-score.png)

## What it does
- **Safety-scored walking routes** (day/night aware) with a plain-language explanation and a confidence label.
- **Community reports** (dark, isolated, harassment, well-lit) that others can confirm, dispute or flag. Flagged or outdated reports drop out of scores.
- **SOS** that texts a trusted contact your location (Twilio), with an SMS-app fallback and a one-tap 112 call.
- **Trip check-in**: if you do not respond, your contact is alerted with your last location.
- **Fake call** and **nearby police/hospitals**.

## How it is built
- `server.js`: dependency-free Node 20+ backend. Persistent reports, rate limits, de-duplication, one vote per device, server-side routing/geocoding/Overpass proxies with caching (API keys never reach the browser), SMS alerts whose text is built server-side, security headers.
- `public/index.html`: Leaflet front end.
- Privacy: no accounts. Devices are identified only by a salted hash of the IP address, used for rate limiting and one-vote-per-report.

## Run locally
```bash
cp .env.example .env      # add your OpenRouteService key
export $(grep -v '^#' .env | xargs)
node server.js            # http://localhost:8080
npm test
```

## Deploy on Google Cloud Run
```bash
gcloud run deploy streetlight --source . --region asia-south1 --allow-unauthenticated \
  --max-instances 1 \
  --set-env-vars ORS_KEY=...,HASH_SALT=...,CONTACT_EMAIL=...,TWILIO_SID=...,TWILIO_TOKEN=...,TWILIO_FROM=...
```
Cloud Run's disk is temporary: reports reset when the instance restarts. For a persistent demo, mount a Cloud Storage volume at `/data` (keep `--max-instances 1`). For real scale, move the store to Firestore (the report logic in `server.js` is isolated in a few functions).

## Honest limitations
- Safety scores reflect community reports, not guarantees. Areas without reports show "No community data yet".
- Trip sharing animates along the planned route; live GPS tracking and a contact tracking page are on the roadmap.
- Needs a production map-tile provider and OSM-service agreements before heavy traffic.

## Roadmap
1. Firestore storage and live-GPS trip sharing with a contact tracking link.
2. Baseline scores from open data (street lighting, open shops, police posts) so every route has a score on day one.
3. Gemini-assisted report moderation and plain-language route explanations.
4. Hindi and Marathi, voice-activated SOS, installable offline PWA.
5. Campus pilot and an anonymised dashboard for institutions and municipalities.
