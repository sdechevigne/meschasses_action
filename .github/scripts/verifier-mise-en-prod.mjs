// Contrôle préalable d'une mise en PRODUCTION, lancé juste après le checkout du
// monorepo, AVANT toute minute de build. Échoue (job rouge) si :
//   - le build ne part pas de la branche par défaut du monorepo ;
//   - les nouveautés de la version manquent ou sont invalides ;
//   - la version n'est pas strictement supérieure à celle publiée sur l'App Store.
//
// Variables d'environnement :
//   MONOREPO_REF     - input monorepo_ref du dispatch (doit être vide en production)
//   APP_JSON         - chemin de app.json (défaut app/apps/mobile/app.json)
//   NOUVEAUTES_DIR   - dossier des nouveautés (défaut app/apps/mobile/store/nouveautes)
//   IOS_BUNDLE_ID    - bundle id pour le lookup public Apple (défaut com.meschasses)

import { readFileSync } from 'node:fs';
import { compareSemver, readNouveautes } from './lib/nouveautes.mjs';

const APP_JSON = process.env.APP_JSON || 'app/apps/mobile/app.json';
const NOUVEAUTES_DIR = process.env.NOUVEAUTES_DIR || 'app/apps/mobile/store/nouveautes';
const BUNDLE_ID = process.env.IOS_BUNDLE_ID || 'com.meschasses';

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

if ((process.env.MONOREPO_REF || '').trim()) {
  fail('Mise en production : uniquement depuis la branche par défaut du monorepo (laisser monorepo_ref vide).');
}

const version = JSON.parse(readFileSync(APP_JSON, 'utf8')).expo?.version;
if (!/^\d+\.\d+\.\d+$/.test(version || '')) fail(`expo.version invalide dans ${APP_JSON} : « ${version} »`);

try {
  const notes = readNouveautes(NOUVEAUTES_DIR, version);
  console.log(`Nouveautés ${version} : ${Object.keys(notes).join(', ')}`);
} catch (e) {
  fail(e.message);
}

// Version publiée sur l'App Store (API publique Apple, sans clé). Même SemVer
// sur les deux plateformes : un build qui ne la dépasse pas serait refusé par
// Apple après 30 min de build, autant l'arrêter ici.
let live;
try {
  const res = await fetch(`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(BUNDLE_ID)}&country=fr`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  live = (await res.json()).results?.[0]?.version;
} catch (e) {
  fail(`Version publiée sur l'App Store illisible (${e.message}) : relancer plus tard.`);
}
if (!live) fail(`App ${BUNDLE_ID} introuvable sur l'App Store (lookup public).`);
if (compareSemver(version, live) <= 0) {
  fail(`Version ${version} ≤ version en ligne ${live} : monter expo.version dans app.json.`);
}
console.log(`✅ Prêt pour la production : ${version} (en ligne : ${live}).`);
