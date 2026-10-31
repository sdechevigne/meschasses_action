// LECTURE SEULE : compare les fiches App Store et Google Play en ligne avec
// apps/mobile/store/fiche/ du monorepo, et imprime les textes actuels des
// stores (textes publics) pour pouvoir les relever. Rien n'est écrit : l'edit
// Google Play est supprimé sans commit.
//
// Variables : ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY, ASC_BUNDLE_ID,
// GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, FICHE_DIR / FICHE_MODULE (cf. lib/fiche-stores.mjs).

import { existsSync } from 'node:fs';
import { createAscClient } from './lib/asc.mjs';
import { accessToken, createEdit, deleteEdit, makeCall } from './lib/play.mjs';
import {
  CHAMPS_APP_STORE,
  CHAMPS_PLAY,
  FICHE_DIR,
  FICHE_MODULE,
  chargerFiches,
  ecart,
  importerModuleFiche,
  lireFicheAppStore,
  lireFichePlay,
  restreindre,
} from './lib/fiche-stores.mjs';

const PACKAGE = process.env.PLAY_PACKAGE_NAME || 'com.meschasses';
let echec = false;

function imprimer(titre, fiche) {
  for (const [locale, champs] of Object.entries(fiche)) {
    for (const [champ, texte] of Object.entries(champs)) {
      console.log(`----- ${titre} ${locale} ${champ} -----\n${texte}`);
    }
  }
}

function comparer(titre, actuel, attendu) {
  if (!attendu) return;
  const diff = ecart(actuel, attendu);
  if (!diff.length) return console.log(`✅ ${titre} : identique au dépôt.`);
  for (const d of diff) {
    console.log(`≠ ${titre} ${d.locale} ${d.champ} : ${d.actuel === undefined ? 'à créer' : 'différent'}`);
  }
}

let fiches = null;
if (existsSync(FICHE_MODULE)) {
  try {
    const mod = await importerModuleFiche();
    if (mod.langues(FICHE_DIR).length) {
      fiches = chargerFiches(mod, FICHE_DIR);
      console.log(`Fiche du dépôt : ${Object.keys(fiches).join(', ')}.`);
    } else {
      console.log(`::warning::Aucune langue dans ${FICHE_DIR} : textes des stores seulement.`);
    }
  } catch (e) {
    echec = true;
    console.log(`::error::${e.message}`);
  }
} else {
  console.log(`::warning::${FICHE_MODULE} absent : pas de comparaison, textes des stores seulement.`);
}

try {
  const api = createAscClient({
    issuerId: process.env.ASC_ISSUER_ID,
    keyId: process.env.ASC_KEY_ID,
    privateKey: process.env.ASC_PRIVATE_KEY,
  });
  const apps = await api(`/apps?filter[bundleId]=${encodeURIComponent(process.env.ASC_BUNDLE_ID)}`);
  const { version, fiche } = await lireFicheAppStore(api, apps.data[0].id);
  console.log(`\n=== App Store (version ${version}) ===`);
  imprimer('App Store', fiche);
  comparer('App Store', fiche, fiches && restreindre(fiches, CHAMPS_APP_STORE));
} catch (e) {
  echec = true;
  console.log(`::error::App Store : ${e.message}`);
}

try {
  const call = makeCall(await accessToken(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON));
  const api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
  const edit = `${api}/edits/${await createEdit(call, api)}`;
  try {
    const fiche = await lireFichePlay(call, edit);
    console.log('\n=== Google Play ===');
    imprimer('Google Play', fiche);
    comparer('Google Play', fiche, fiches && restreindre(fiches, CHAMPS_PLAY));
  } finally {
    await deleteEdit(call, edit);
  }
} catch (e) {
  echec = true;
  console.log(`::error::Google Play : ${e.message}`);
}

if (echec) process.exit(1);
