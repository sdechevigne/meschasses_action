// LECTURE SEULE : vérifie l'accès aux stores pour la publication des VISUELS, et liste ce qui
// changerait si on envoyait les captures du monorepo (sans rien écrire). Sert à prouver, avant
// une mise en production, que l'authentification et les identifiants de displayType / imageType
// sont bons.
//
// Variables : ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY, ASC_BUNDLE_ID,
// GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, PLAY_PACKAGE_NAME (défaut com.meschasses).

import { createAscClient } from './lib/asc.mjs';
import { accessToken, createEdit, deleteEdit, makeCall } from './lib/play.mjs';

const PACKAGE = process.env.PLAY_PACKAGE_NAME || 'com.meschasses';

const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];

let echec = false;

console.log('\n=== App Store : captures en ligne ===');
try {
  const api = createAscClient({
    issuerId: process.env.ASC_ISSUER_ID,
    keyId: process.env.ASC_KEY_ID,
    privateKey: process.env.ASC_PRIVATE_KEY,
  });
  const apps = await api(`/apps?filter[bundleId]=${encodeURIComponent(process.env.ASC_BUNDLE_ID)}`);
  const appId = apps.data?.[0]?.id;
  if (!appId) throw new Error('App Apple introuvable');
  const versions = (await api(`/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=20`)).data || [];
  // On regarde la version éditable s'il y en a une, sinon la plus récente.
  const version = versions.find((v) => EDITABLE.includes(v.attributes.appStoreState)) || versions[0];
  if (!version) throw new Error('Aucune version iOS.');
  console.log(`Version ${version.attributes.versionString} (${version.attributes.appStoreState}).`);
  const locs = (await api(`/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`)).data || [];
  for (const loc of locs) {
    const sets = (await api(`/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`)).data || [];
    if (!sets.length) {
      console.log(`  ${loc.attributes.locale} : aucun set.`);
      continue;
    }
    for (const set of sets) {
      const shots = (await api(`/appScreenshotSets/${set.id}/appScreenshots?limit=50`)).data || [];
      console.log(
        `  ${loc.attributes.locale} · ${set.attributes.screenshotDisplayType} : ${shots.length} visuel(s)`,
      );
    }
  }
} catch (e) {
  echec = true;
  console.error(`::error::App Store : ${e.message}`);
}

console.log('\n=== Google Play : captures en ligne ===');
try {
  const token = await accessToken(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  const call = makeCall(token);
  const api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
  const editId = await createEdit(call, api);
  const edit = `${api}/edits/${editId}`;
  try {
    const listings = (await call(`${edit}/listings`)).listings || [];
    for (const l of listings) {
      for (const imageType of ['phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots', 'featureGraphic']) {
        const res = await call(`${edit}/listings/${l.language}/${imageType}`);
        const n = (res.images || []).length;
        console.log(`  ${l.language} · ${imageType} : ${n} visuel(s)`);
      }
    }
  } finally {
    await deleteEdit(call, edit);
  }
} catch (e) {
  echec = true;
  console.error(`::error::Google Play : ${e.message}`);
}

if (echec) process.exit(1);
