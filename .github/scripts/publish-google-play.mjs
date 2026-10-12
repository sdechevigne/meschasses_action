// Publie le .aab en PRODUCTION sur Google Play, à 100 % des utilisateurs
// (status "completed"), avec les nouveautés de la version. Google l'examine
// puis la publie automatiquement.
//
// Remplace `eas submit` en mode production : eas submit ne sait pas écrire les
// notes de version. API Google Play Developer (Publisher v3), via un « edit » :
// création → upload du bundle → piste production → commit.
//
// Mode CHECK_ONLY=1 (lecture seule) : vérifie la clé du compte de service, que
// chaque langue de la fiche a ses nouveautés, affiche l'état de la piste
// production, puis SUPPRIME l'edit sans rien publier.
//
// Aucune dépendance externe : JWT RS256 (crypto natif) échangé contre un jeton
// OAuth, requêtes via fetch global (Node 22).
// REPO PUBLIC : ni la clé, ni le jeton ne sont écrits sur stdout.
//
// Variables d'environnement :
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON - JSON du compte de service (secret)
//   PLAY_PACKAGE_NAME  - défaut com.meschasses
//   AAB_PATH           - .aab à publier (mode normal)
//   APP_JSON           - chemin de app.json (défaut app/apps/mobile/app.json)
//   NOUVEAUTES_DIR     - dossier des nouveautés (défaut app/apps/mobile/store/nouveautes)
//   CHECK_ONLY         - "1" pour le contrôle en lecture seule

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { notesForLocale, readNouveautes } from './lib/nouveautes.mjs';

const CHECK_ONLY = process.env.CHECK_ONLY === '1';
const PACKAGE = process.env.PLAY_PACKAGE_NAME || 'com.meschasses';
const AAB_PATH = process.env.AAB_PATH;
const APP_JSON = process.env.APP_JSON || 'app/apps/mobile/app.json';
const NOUVEAUTES_DIR = process.env.NOUVEAUTES_DIR || 'app/apps/mobile/store/nouveautes';

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

if (!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) fail('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON manquant');
if (!CHECK_ONLY && !AAB_PATH) fail('AAB_PATH manquant');

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken() {
  const sa = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key);
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${input}.${b64url(sig)}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Authentification Google refusée (${res.status} ${json.error || ''}).`);
  }
  return json.access_token;
}

async function main() {
  const version = JSON.parse(readFileSync(APP_JSON, 'utf8')).expo?.version;
  if (!version) throw new Error(`expo.version absente de ${APP_JSON}`);
  // En contrôle, des nouveautés absentes n'empêchent pas le diagnostic : on liste
  // quand même les langues et la piste production, et on échoue à la fin.
  let notes = null;
  let notesError = null;
  try {
    notes = readNouveautes(NOUVEAUTES_DIR, version);
  } catch (e) {
    if (!CHECK_ONLY) throw e;
    notesError = e;
  }

  // Un jeton dure 1 h : largement assez pour un edit (upload compris).
  const token = await accessToken();
  const call = async (url, opts = {}) => {
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  };

  const editId = (await call(`${API}/edits`, { method: 'POST', body: '{}' })).id;
  const edit = `${API}/edits/${editId}`;
  let committed = false;
  try {
    // Langues de la fiche Play : chacune reçoit ses notes de version.
    const languages = ((await call(`${edit}/listings`)).listings || []).map((l) => l.language);
    if (!languages.length) throw new Error('Aucune langue de fiche Google Play lue.');
    console.log(`Langues de la fiche Google Play : ${languages.join(', ')}.`);
    const missing = notes ? languages.filter((lang) => !notesForLocale(notes, lang)) : [];
    if (missing.length) {
      throw new Error(
        `Nouveautés manquantes pour la/les langue(s) ${missing.join(', ')} : ` +
          `ajouter le fichier correspondant dans store/nouveautes/${version}/.`
      );
    }
    const releaseNotes = (notes ? languages : []).map((language) => ({ language, text: notesForLocale(notes, language) }));

    if (CHECK_ONLY) {
      const prod = await call(`${edit}/tracks/production`);
      for (const r of prod.releases || []) {
        console.log(`Piste production : ${r.name || '(sans nom)'} — ${r.status} — ${(r.versionCodes || []).join(', ')}`);
      }
      if (notesError) throw notesError;
      console.log(`✅ Google Play prêt pour ${version} : langues ${languages.join(', ')} (lecture seule, rien publié).`);
      return;
    }

    console.log('Envoi du bundle vers Google Play…');
    const bundle = await call(`${UPLOAD}/edits/${editId}/bundles?uploadType=media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: readFileSync(AAB_PATH),
    });
    const versionCode = String(bundle.versionCode);
    console.log(`Bundle accepté : versionCode ${versionCode}.`);

    await call(`${edit}/tracks/production`, {
      method: 'PUT',
      body: JSON.stringify({
        track: 'production',
        releases: [{ name: `${version} (${versionCode})`, versionCodes: [versionCode], status: 'completed', releaseNotes }],
      }),
    });
    await call(`${edit}:commit`, { method: 'POST' });
    committed = true;
    console.log(`🎉 Version ${version} (${versionCode}) envoyée en production à 100 % : publication après examen Google.`);
  } finally {
    // Un edit non commité est abandonné proprement (sinon il bloque les suivants).
    if (!committed) await call(edit, { method: 'DELETE' }).catch(() => {});
  }
}

main().catch((e) => fail(e.message));
