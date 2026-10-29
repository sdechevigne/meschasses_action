// Publie le .aab en PRODUCTION sur Google Play, avec les nouveautés de la
// version. Google l'examine puis la publie automatiquement.
// Par défaut à 100 % (status "completed") ; PLAY_USER_FRACTION (ex. "0.1")
// publie EN PALIERS (status "inProgress" : seul ce pourcentage d'utilisateurs
// reçoit la version). Montée / pause / complétion ensuite : rollout-google-play.mjs
// (workflow rollout-android.yml).
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

import { readFileSync } from 'node:fs';
import { notesForLocale, readNouveautes } from './lib/nouveautes.mjs';
import { accessToken, makeCall, createEdit, deleteEdit } from './lib/play.mjs';

const CHECK_ONLY = process.env.CHECK_ONLY === '1';
// Déploiement par paliers : fraction d'utilisateurs servie (0 < f < 1), vide = 100 %.
const USER_FRACTION = process.env.PLAY_USER_FRACTION ? Number(process.env.PLAY_USER_FRACTION) : null;
if (USER_FRACTION !== null && !(USER_FRACTION > 0 && USER_FRACTION < 1)) {
  console.error('::error::PLAY_USER_FRACTION doit être strictement entre 0 et 1 (ex. 0.1).');
  process.exit(1);
}
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
  const token = await accessToken(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  const call = makeCall(token);

  const editId = await createEdit(call, API);
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

    const release = USER_FRACTION !== null
      ? { name: `${version} (${versionCode})`, versionCodes: [versionCode], status: 'inProgress', userFraction: USER_FRACTION, releaseNotes }
      : { name: `${version} (${versionCode})`, versionCodes: [versionCode], status: 'completed', releaseNotes };
    await call(`${edit}/tracks/production`, {
      method: 'PUT',
      body: JSON.stringify({ track: 'production', releases: [release] }),
    });
    await call(`${edit}:commit`, { method: 'POST' });
    committed = true;
    console.log(USER_FRACTION !== null
      ? `🎉 Version ${version} (${versionCode}) envoyée en production PAR PALIERS (${Math.round(USER_FRACTION * 100)} % des utilisateurs) : publication après examen Google. Montée : workflow rollout-android.yml.`
      : `🎉 Version ${version} (${versionCode}) envoyée en production à 100 % : publication après examen Google.`);
  } finally {
    // Un edit non commité est abandonné proprement (sinon il bloque les suivants).
    if (!committed) await deleteEdit(call, edit);
  }
}

main().catch((e) => fail(e.message));
