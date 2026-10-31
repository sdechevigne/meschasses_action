// Soumet la version à la validation Apple, publication AUTOMATIQUE après
// acceptation (releaseType AFTER_APPROVAL, 100 % des utilisateurs).
//
// Étapes (mode normal) :
//   1. attendre que le build uploadé soit traité par Apple (processingState VALID) ;
//   2. prendre la version App Store éditable (ou la créer) et lui donner la SemVer ;
//   3. écrire les nouveautés (whatsNew) sur chaque locale de la fiche ;
//   4. rattacher le build, releaseType AFTER_APPROVAL ;
//   5. créer (ou reprendre) la soumission et l'envoyer en validation.
//
// Mode CHECK_ONLY=1 (lecture seule, AVANT le build) : vérifie l'accès à l'API,
// qu'aucune version n'est déjà en cours chez Apple, et que chaque locale de la
// fiche a ses nouveautés. Ne modifie rien.
//
// REPO PUBLIC : seuls des états, numéros de version/build et locales sont
// écrits sur stdout. Les nouveautés sont publiques par nature.
//
// Variables d'environnement :
//   ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY  - clé API App Store Connect
//   ASC_BUNDLE_ID     - bundle id (ex. com.meschasses)
//   APP_JSON          - chemin de app.json (défaut app/apps/mobile/app.json)
//   NOUVEAUTES_DIR    - dossier des nouveautés (défaut app/apps/mobile/store/nouveautes)
//   BUILD_NUMBER      - CFBundleVersion du build uploadé (mode normal)
//   POLL_TIMEOUT_SEC  - attente max du traitement Apple (défaut 2700)
//   CHECK_ONLY        - "1" pour le contrôle en lecture seule

import { readFileSync } from 'node:fs';
import { createAscClient, sleep } from './lib/asc.mjs';
import { notesForLocale, readNouveautes } from './lib/nouveautes.mjs';
import { FICHE_DIR, appliquerFicheAppStore, chargerFiches, importerModuleFiche, verifierPublication } from './lib/fiche-stores.mjs';

const CHECK_ONLY = process.env.CHECK_ONLY === '1';
// Publie aussi la fiche (apps/mobile/store/fiche/) : input `fiche` de mise-en-production.yml.
const PUBLIER_FICHE = process.env.PUBLIER_FICHE === '1';
const BUNDLE_ID = process.env.ASC_BUNDLE_ID;
const BUILD_NUMBER = process.env.BUILD_NUMBER;
const APP_JSON = process.env.APP_JSON || 'app/apps/mobile/app.json';
const NOUVEAUTES_DIR = process.env.NOUVEAUTES_DIR || 'app/apps/mobile/store/nouveautes';
const POLL_TIMEOUT_SEC = Number(process.env.POLL_TIMEOUT_SEC || 2700);

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

const required = ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY', 'ASC_BUNDLE_ID'];
if (!CHECK_ONLY) required.push('BUILD_NUMBER');
for (const k of required) if (!process.env[k]) fail(`Variable ${k} manquante`);

const api = createAscClient({
  issuerId: process.env.ASC_ISSUER_ID,
  keyId: process.env.ASC_KEY_ID,
  privateKey: process.env.ASC_PRIVATE_KEY,
});

// États d'une version App Store (attribut appStoreState).
// Éditable : on peut la (ré)utiliser pour cette soumission.
const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
// En cours chez Apple : une nouvelle soumission est impossible tant qu'elle n'est
// pas publiée ou retirée. On ne la retire JAMAIS automatiquement.
const IN_FLIGHT = [
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'WAITING_FOR_EXPORT_COMPLIANCE',
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_APP_STORE',
];

async function main() {
  const version = JSON.parse(readFileSync(APP_JSON, 'utf8')).expo?.version;
  if (!version) throw new Error(`expo.version absente de ${APP_JSON}`);
  // En contrôle, des nouveautés absentes n'empêchent pas le diagnostic : on liste
  // quand même les locales, et on échoue à la fin.
  let notes = null;
  let notesError = null;
  try {
    notes = readNouveautes(NOUVEAUTES_DIR, version);
  } catch (e) {
    if (!CHECK_ONLY) throw e;
    notesError = e;
  }
  // Fiche : contrôlée AVANT toute écriture (et dès le contrôle d'avant build).
  const fiches = PUBLIER_FICHE ? chargerFiches(await importerModuleFiche(), FICHE_DIR) : null;
  if (fiches) {
    verifierPublication(fiches, notes, version);
    console.log(`Fiche à publier : ${Object.keys(fiches).join(', ')}.`);
  }

  // --- App ------------------------------------------------------------------
  const apps = await api(`/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`);
  const appId = apps.data?.[0]?.id;
  if (!appId) throw new Error(`App introuvable pour bundleId=${BUNDLE_ID}`);

  // --- Versions existantes ---------------------------------------------------
  const versions = (await api(`/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=20`)).data || [];
  const state = (v) => v.attributes.appStoreState;
  const inFlight = versions.find((v) => IN_FLIGHT.includes(state(v)));
  if (inFlight) {
    throw new Error(
      `La version ${inFlight.attributes.versionString} est déjà en cours chez Apple (${state(inFlight)}). ` +
        'Attendre sa publication, ou la retirer dans App Store Connect, puis relancer.'
    );
  }
  let target = versions.find((v) => EDITABLE.includes(state(v)));
  console.log(
    target
      ? `Version éditable existante : ${target.attributes.versionString} (${state(target)}).`
      : `Aucune version éditable : la version ${version} sera créée.`
  );

  // Locales de la fiche : celles de la version éditable, sinon de la plus récente
  // (Apple recopie ses localisations dans la nouvelle version).
  const localesOf = async (v) =>
    ((await api(`/appStoreVersions/${v.id}/appStoreVersionLocalizations?limit=50`)).data || []).map((l) => ({
      id: l.id,
      locale: l.attributes.locale,
    }));
  const reference = target || versions[0];
  if (reference) {
    const locales = await localesOf(reference);
    console.log(`Locales de la fiche App Store : ${locales.map((l) => l.locale).join(', ')}.`);
    const missing = notes ? locales.filter((l) => !notesForLocale(notes, l.locale)) : [];
    if (missing.length) {
      throw new Error(
        `Nouveautés manquantes pour la/les locale(s) ${missing.map((l) => l.locale).join(', ')} : ` +
          `ajouter le fichier de langue correspondant dans store/nouveautes/${version}/.`
      );
    }
  }

  if (CHECK_ONLY) {
    if (notesError) throw notesError;
    console.log(`✅ App Store prêt pour ${version} (lecture seule, rien n'a été modifié).`);
    return;
  }

  // --- 1. Attendre le traitement du build ------------------------------------
  const deadline = Date.now() + POLL_TIMEOUT_SEC * 1000;
  let build;
  for (;;) {
    try {
      const res = await api(
        `/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(BUILD_NUMBER)}` +
          `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&limit=1`
      );
      build = res.data?.[0];
    } catch (e) {
      console.log(`::warning::Lecture du build échouée, nouvelle tentative : ${e.message}`);
    }
    const ps = build?.attributes?.processingState;
    if (ps === 'VALID') break;
    if (ps === 'FAILED' || ps === 'INVALID') throw new Error(`Build ${BUILD_NUMBER} refusé par le traitement Apple (${ps}).`);
    if (Date.now() > deadline) {
      throw new Error(`Build ${BUILD_NUMBER} toujours non traité après ${Math.round(POLL_TIMEOUT_SEC / 60)} min.`);
    }
    console.log(`Build ${BUILD_NUMBER} : ${ps || 'pas encore visible'}…`);
    await sleep(30_000);
  }
  console.log(`Build ${BUILD_NUMBER} traité (VALID).`);

  // Conformité export : déclarée par ITSAppUsesNonExemptEncryption=false dans
  // app.json. Filet si Apple ne l'a pas reprise (sinon la soumission bloque).
  if (build.attributes.usesNonExemptEncryption == null) {
    await api(`/builds/${build.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } } }),
    });
    console.log('Conformité export renseignée (pas de chiffrement non exempté).');
  }

  // --- 2. Version App Store ---------------------------------------------------
  if (!target) {
    target = (
      await api('/appStoreVersions', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'appStoreVersions',
            attributes: { platform: 'IOS', versionString: version, releaseType: 'AFTER_APPROVAL' },
            relationships: { app: { data: { type: 'apps', id: appId } } },
          },
        }),
      })
    ).data;
    console.log(`Version ${version} créée.`);
  } else {
    await api(`/appStoreVersions/${target.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'appStoreVersions',
          id: target.id,
          attributes: { versionString: version, releaseType: 'AFTER_APPROVAL' },
        },
      }),
    });
    console.log(`Version ${target.attributes.versionString} → ${version}, publication automatique après validation.`);
  }

  // --- 2 bis. Fiche (crée les locales absentes, ex. en-GB / en-US) -----------
  if (fiches) await appliquerFicheAppStore(api, { appId, versionId: target.id, fiches });

  // --- 3. Nouveautés ----------------------------------------------------------
  const locs = await localesOf(target);
  if (!locs.length) throw new Error(`Aucune localisation sur la version ${version}.`);
  for (const { id, locale } of locs) {
    const whatsNew = notesForLocale(notes, locale);
    if (!whatsNew) throw new Error(`Nouveautés manquantes pour la locale ${locale}.`);
    await api(`/appStoreVersionLocalizations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: { type: 'appStoreVersionLocalizations', id, attributes: { whatsNew } } }),
    });
    console.log(`Nouveautés ${locale} écrites.`);
  }

  // --- 4. Build ---------------------------------------------------------------
  await api(`/appStoreVersions/${target.id}/relationships/build`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'builds', id: build.id } }),
  });
  console.log(`Build ${BUILD_NUMBER} rattaché à la version ${version}.`);

  // --- 5. Soumission ----------------------------------------------------------
  const open = await api(
    `/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW&limit=1`
  );
  let submissionId = open.data?.[0]?.id;
  if (!submissionId) {
    submissionId = (
      await api('/reviewSubmissions', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'reviewSubmissions',
            attributes: { platform: 'IOS' },
            relationships: { app: { data: { type: 'apps', id: appId } } },
          },
        }),
      })
    ).data.id;
  }
  const items = await api(`/reviewSubmissions/${submissionId}/items?include=appStoreVersion&limit=50`);
  const alreadyIn = (items.data || []).some((i) => i.relationships?.appStoreVersion?.data?.id === target.id);
  if (!alreadyIn) {
    await api('/reviewSubmissionItems', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: target.id } },
          },
        },
      }),
    });
  }
  await api(`/reviewSubmissions/${submissionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } } }),
  });
  console.log(`🎉 Version ${version} (build ${BUILD_NUMBER}) soumise à Apple : publication automatique après validation.`);
}

main().catch((e) => fail(e.message));
