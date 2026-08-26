// Écrit le champ "What to Test" (whatsToTest) du build TestFlight qui vient d'être
// uploadé, avec le commit du monorepo dont il est issu. Objectif : pouvoir dire
// « le build 603 bugue, pas le 602 » et retrouver la plage de commits concernée.
//
// Utilise l'App Store Connect API (JWT ES256). Aucune dépendance externe : JWT
// signé via le module crypto natif de Node, requêtes via fetch global (Node 22).
// Le JWT est REGÉNÉRÉ à chaque requête : le poll d'attente du build dure souvent
// plus longtemps que la durée de vie d'un token (c'est ce qui provoquait les 401
// de l'ancienne action apple-actions).
//
// REPO PUBLIC : ce script n'écrit JAMAIS le SHA ni un secret sur stdout. Le SHA
// part uniquement vers App Store Connect ; les logs ne contiennent que le numéro
// de build et le statut.
//
// Variables d'environnement attendues :
//   ASC_ISSUER_ID       - secrets.APPSTORE_ISSUER_ID
//   ASC_KEY_ID          - secrets.APPSTORE_API_KEY_ID
//   ASC_PRIVATE_KEY     - secrets.APPSTORE_API_PRIVATE_KEY (PEM ou base64 du corps)
//   ASC_BUNDLE_ID       - bundle id de l'app (ex. com.meschasses)
//   BUILD_NUMBER        - CFBundleVersion du build uploadé (ex. 603)
//   COMMIT_SHA          - SHA complet du commit du monorepo buildé
//   COMMIT_REF          - ref déclencheuse (ex. refs/tags/tf-v1.4.0) — optionnel
//   BUILD_DATE          - horodatage UTC du build — optionnel
//   RELEASE_NOTES       - note interne saisie au lancement du workflow — optionnel
//   TESTFLIGHT_LOCALES  - locales à créer si le build n'en a aucune (défaut fr-FR,en-US)
//   POLL_TIMEOUT_SEC    - attente max de l'apparition du build côté Apple (défaut 1200)

import crypto from 'node:crypto';

const ISSUER = process.env.ASC_ISSUER_ID;
const KID = process.env.ASC_KEY_ID;
const BUNDLE_ID = process.env.ASC_BUNDLE_ID;
const BUILD_NUMBER = process.env.BUILD_NUMBER;
const COMMIT_SHA = process.env.COMMIT_SHA || '';
const COMMIT_REF = process.env.COMMIT_REF || '';
const BUILD_DATE = process.env.BUILD_DATE || '';
const RELEASE_NOTES = (process.env.RELEASE_NOTES || '').trim();
const LOCALES = (process.env.TESTFLIGHT_LOCALES || 'fr-FR,en-US').split(',').map((s) => s.trim());
const POLL_TIMEOUT_SEC = Number(process.env.POLL_TIMEOUT_SEC || 1200);

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

// Sortie en SUCCÈS : le binaire est déjà sur TestFlight, seule l'annotation manque.
// Faire échouer le job ici donnerait un faux négatif sur une livraison réussie.
const giveUp = (msg) => {
  console.log(`::warning::${msg}`);
  process.exit(0);
};

for (const k of ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY', 'ASC_BUNDLE_ID', 'BUILD_NUMBER', 'COMMIT_SHA']) {
  if (!process.env[k]) fail(`Variable ${k} manquante`);
}

// Normalise la clé privée : accepte le PEM complet ou le seul corps base64.
let pem = process.env.ASC_PRIVATE_KEY.trim();
if (!pem.includes('BEGIN')) {
  pem = `-----BEGIN PRIVATE KEY-----\n${pem.replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makeJWT() {
  const header = { alg: 'ES256', kid: KID, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('SHA256', Buffer.from(input), { key: pem, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

const BASE = 'https://api.appstoreconnect.apple.com/v1';

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      // Regénéré à chaque appel : jamais expiré, même après 20 min de poll.
      Authorization: `Bearer ${makeJWT()}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Texte poussé dans "What to Test" ----------------------------------------
// Visible par les testeurs TestFlight : on y met le strict nécessaire au triage
// (build, commit, ref, date). Pas de message de commit — le monorepo est privé.
const short = COMMIT_SHA.slice(0, 7);
const lines = [`Build ${BUILD_NUMBER} — commit ${short}`];
if (COMMIT_REF) lines.push(`Ref : ${COMMIT_REF}`);
lines.push(`SHA : ${COMMIT_SHA}`);
if (BUILD_DATE) lines.push(`Build : ${BUILD_DATE}`);
if (RELEASE_NOTES) lines.push('', RELEASE_NOTES);
const whatsToTest = lines.join('\n').slice(0, 4000); // limite App Store Connect

// --- 1. Résoudre l'app -------------------------------------------------------
let appId;
try {
  const apps = await api(`/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`);
  appId = apps.data?.[0]?.id;
} catch (e) {
  fail(`App Store Connect injoignable : ${e.message}`);
}
if (!appId) fail(`App introuvable pour bundleId=${BUNDLE_ID}`);

// --- 2. Attendre que le build uploadé apparaisse -----------------------------
// Le traitement Apple prend de 2 à 20 minutes ; le build devient adressable par
// l'API dès son enregistrement, sans attendre l'état VALID.
const deadline = Date.now() + POLL_TIMEOUT_SEC * 1000;
let buildId;
while (!buildId) {
  try {
    const builds = await api(
      `/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(BUILD_NUMBER)}&limit=1`
    );
    buildId = builds.data?.[0]?.id;
  } catch (e) {
    console.log(`::warning::Lecture des builds échouée, nouvelle tentative : ${e.message}`);
  }
  if (buildId) break;
  if (Date.now() > deadline) {
    giveUp(
      `Build ${BUILD_NUMBER} toujours absent de l'API après ${Math.round(POLL_TIMEOUT_SEC / 60)} min. ` +
        'Le binaire est bien uploadé : renseigner "What to Test" à la main si besoin.'
    );
  }
  await sleep(30_000);
}
console.log(`Build ${BUILD_NUMBER} trouvé côté App Store Connect.`);

// --- 3. Écrire whatsToTest sur chaque localization ---------------------------
let locs = { data: [] };
try {
  locs = await api(`/builds/${buildId}/betaBuildLocalizations?limit=50`);
} catch (e) {
  console.log(`::warning::Lecture des localizations échouée : ${e.message}`);
}

let ok = 0;
if (locs.data?.length) {
  for (const loc of locs.data) {
    try {
      await api(`/betaBuildLocalizations/${loc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: { type: 'betaBuildLocalizations', id: loc.id, attributes: { whatsToTest } },
        }),
      });
      console.log(`✅ ${loc.attributes?.locale} : What to Test mis à jour`);
      ok++;
    } catch (e) {
      console.log(`::warning::${loc.attributes?.locale} : ${e.message}`);
    }
  }
} else {
  for (const locale of LOCALES) {
    try {
      await api('/betaBuildLocalizations', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'betaBuildLocalizations',
            attributes: { locale, whatsToTest },
            relationships: { build: { data: { type: 'builds', id: buildId } } },
          },
        }),
      });
      console.log(`✅ ${locale} : What to Test créé`);
      ok++;
    } catch (e) {
      console.log(`::warning::${locale} : ${e.message}`);
    }
  }
}

if (ok === 0) giveUp(`Aucune localization écrite pour le build ${BUILD_NUMBER}.`);
console.log(`🎉 Build ${BUILD_NUMBER} annoté (${ok} locale(s)).`);
