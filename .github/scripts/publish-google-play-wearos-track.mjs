// Publie l'.aab Wear OS sur la piste wear:internal (test interne, formulaire Wear OS).
// L'app Wear OS partage le package `com.meschasses` avec le téléphone (Play App Signing
// commun) ; la piste wear:internal est séparée de la piste `internal` du téléphone, et
// n'exige pas de notes de version.
//
// Entrées (env) :
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON  compte de service (secret)
//   AAB_PATH                           .aab Wear OS à envoyer
//   PLAY_TRACK                         piste cible (défaut 'wear:internal')
//   PLAY_PACKAGE_NAME                  défaut 'com.meschasses'
//
// Mode CHECK_ONLY=1 (lecture seule) : vérifie la clé de service, affiche l'état
// de la piste cible, puis SUPPRIME l'edit sans rien publier. Si VERSION_CODE est
// posée, elle doit être strictement supérieure au max versionCode présent sur la
// fiche (toutes pistes confondues) : fail-fast avant toute minute de build.
//
// Réutilise lib/play.mjs (auth JWT RS256 + call) ; aucune dépendance externe,
// fetch global (Node ≥ 22). REPO PUBLIC : ni la clé ni le jeton sur stdout.

import { readFileSync } from 'node:fs';
import { accessToken, makeCall, createEdit, deleteEdit } from './lib/play.mjs';

const CHECK_ONLY = process.env.CHECK_ONLY === '1';
const PACKAGE = process.env.PLAY_PACKAGE_NAME || 'com.meschasses';
const TRACK = process.env.PLAY_TRACK || 'wear:internal';
const AAB_PATH = process.env.AAB_PATH;

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

if (!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) fail('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON manquant');
if (!CHECK_ONLY && !AAB_PATH) fail('AAB_PATH manquant');

async function main() {
  const token = await accessToken(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  const call = makeCall(token);

  const editId = await createEdit(call, API);
  const edit = `${API}/edits/${editId}`;
  let committed = false;
  try {
    // Garde-fou versionCode : lu avant tout. Toutes les pistes de la fiche sont
    // consultées pour trouver le max — garantit zéro collision quelle que soit
    // l'origine du bundle existant (téléphone, Wear OS, Capacitor historique).
    if (process.env.VERSION_CODE) {
      const target = Number(process.env.VERSION_CODE);
      if (!Number.isFinite(target) || target <= 0) throw new Error(`VERSION_CODE invalide : ${process.env.VERSION_CODE}`);
      const tracks = await call(`${edit}/tracks`);
      let max = 0;
      for (const t of tracks.tracks || []) {
        for (const r of t.releases || []) {
          for (const v of r.versionCodes || []) {
            const n = Number(v);
            if (Number.isFinite(n) && n > max) max = n;
          }
        }
      }
      console.log(`Max versionCode sur la fiche Play (toutes pistes) : ${max}. Projeté : ${target}.`);
      if (target <= max) throw new Error(`VERSION_CODE projeté ${target} <= max déjà présent ${max} : augmenter l'offset.`);
    }

    // Diagnostic : afficher l'état courant de la piste cible (releases éventuelles).
    let current;
    try {
      current = await call(`${edit}/tracks/${encodeURIComponent(TRACK)}`);
    } catch (e) {
      // Une piste wear:internal non activée (format Wear OS pas coché dans la fiche)
      // provoque un 404 : on le remonte proprement, le workflow pourra le relayer à
      // l'utilisateur.
      throw new Error(`Piste Play '${TRACK}' indisponible : ${e.message}. Activer le format Wear OS dans la fiche (Play Console → Test et publication → Configuration avancée → Formats de la boutique → Wear OS).`);
    }
    for (const r of current.releases || []) {
      console.log(`Piste ${TRACK} : ${r.name || '(sans nom)'} — ${r.status} — ${(r.versionCodes || []).join(', ')}`);
    }

    if (CHECK_ONLY) {
      console.log(`✅ Google Play prêt pour la piste ${TRACK} (lecture seule, rien publié).`);
      return;
    }

    console.log(`Envoi du bundle Wear OS vers Google Play (piste ${TRACK})…`);
    const bundle = await call(`${UPLOAD}/edits/${editId}/bundles?uploadType=media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: readFileSync(AAB_PATH),
    });
    const versionCode = String(bundle.versionCode);
    console.log(`Bundle accepté : versionCode ${versionCode}.`);

    // La piste wear:internal est une piste de test : status 'completed' = disponible
    // immédiatement pour les testeurs internes, pas de releaseNotes requises.
    const release = {
      name: `wearos ${versionCode}`,
      versionCodes: [versionCode],
      status: 'completed',
    };
    await call(`${edit}/tracks/${encodeURIComponent(TRACK)}`, {
      method: 'PUT',
      body: JSON.stringify({ track: TRACK, releases: [release] }),
    });
    await call(`${edit}:commit`, { method: 'POST' });
    committed = true;
    console.log(`🎉 Bundle Wear OS ${versionCode} envoyé sur la piste ${TRACK}.`);
  } finally {
    if (!committed) await deleteEdit(call, edit);
  }
}

main().catch((e) => fail(e.message));
