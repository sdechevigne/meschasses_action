// Met à jour les "Nouveautés de cette version" (whatsNew) de la fiche App Store
// publique à partir des fichiers whatsnew/<lang>/default.txt du repo mobile.
//
// Utilise l'App Store Connect API (JWT ES256). Aucune dépendance externe :
// JWT signé via le module crypto natif de Node, requêtes via fetch global (Node 22).
//
// Variables d'environnement attendues :
//   ASC_ISSUER_ID      - secrets.APPSTORE_ISSUER_ID
//   ASC_KEY_ID         - secrets.APPSTORE_API_KEY_ID
//   ASC_PRIVATE_KEY    - secrets.APPSTORE_API_PRIVATE_KEY (contenu du .p8)
//   ASC_BUNDLE_ID      - secrets.IOS_BUNDLE_ID
//   IOS_VERSION        - version marketing (ex. 1.4.0), pour créer la version si besoin
//   WHATSNEW_DIR       - dossier racine des notes (défaut: app/whatsnew)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';

const ISSUER = process.env.ASC_ISSUER_ID;
const KID = process.env.ASC_KEY_ID;
const BUNDLE_ID = process.env.ASC_BUNDLE_ID;
const VERSION = process.env.IOS_VERSION;
const WHATSNEW_DIR = process.env.WHATSNEW_DIR || 'app/whatsnew';

// Dossier de langue (whatsnew/<lang>) -> locale App Store Connect
const LOCALE_MAP = { fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE', it: 'it-IT' };

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

for (const k of ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY', 'ASC_BUNDLE_ID', 'IOS_VERSION']) {
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

const TOKEN = makeJWT();
const BASE = 'https://api.appstoreconnect.apple.com/v1';

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// 1. Charger les notes par locale
if (!existsSync(WHATSNEW_DIR)) fail(`Dossier ${WHATSNEW_DIR} introuvable`);
const notesByLocale = {};
for (const lang of readdirSync(WHATSNEW_DIR)) {
  const file = join(WHATSNEW_DIR, lang, 'default.txt');
  if (!existsSync(file)) continue;
  const notes = readFileSync(file, 'utf8').trim();
  if (notes) notesByLocale[LOCALE_MAP[lang] || lang] = notes.slice(0, 4000); // max App Store
}
if (Object.keys(notesByLocale).length === 0) fail('Aucune note whatsnew trouvée');

// 2. Récupérer l'app
const apps = await api(`/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`);
const appId = apps.data?.[0]?.id;
if (!appId) fail(`App introuvable pour bundleId=${BUNDLE_ID}`);

// 3. Trouver une version éditable, sinon la créer
const EDITABLE = [
  'PREPARE_FOR_SUBMISSION',
  'METADATA_REJECTED',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'INVALID_BINARY',
];
const versions = await api(`/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=20`);
let version = versions.data?.find((v) => EDITABLE.includes(v.attributes.appStoreState));
if (!version) {
  console.log(`Aucune version éditable → création de ${VERSION}`);
  const created = await api('/appStoreVersions', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: VERSION },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    }),
  });
  version = created.data;
}
console.log(`Version cible: ${version.attributes.versionString} (${version.attributes.appStoreState})`);

// 4. Mettre à jour (ou créer) la localization de chaque locale
const locs = await api(
  `/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`
);
const existing = Object.fromEntries((locs.data || []).map((l) => [l.attributes.locale, l.id]));

let ok = 0;
for (const [locale, whatsNew] of Object.entries(notesByLocale)) {
  try {
    if (existing[locale]) {
      await api(`/appStoreVersionLocalizations/${existing[locale]}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: 'appStoreVersionLocalizations',
            id: existing[locale],
            attributes: { whatsNew },
          },
        }),
      });
      console.log(`✅ ${locale}: whatsNew mis à jour`);
    } else {
      await api('/appStoreVersionLocalizations', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'appStoreVersionLocalizations',
            attributes: { locale, whatsNew },
            relationships: {
              appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
            },
          },
        }),
      });
      console.log(`✅ ${locale}: whatsNew créé`);
    }
    ok++;
  } catch (e) {
    console.error(`::warning::${locale}: ${e.message}`);
  }
}
if (ok === 0) fail('Aucune note publiée');
console.log(`🎉 ${ok} locale(s) mise(s) à jour`);
