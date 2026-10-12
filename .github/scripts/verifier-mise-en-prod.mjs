// Contrôle préalable d'une mise en PRODUCTION, lancé juste après le checkout du
// monorepo, AVANT toute minute de build. Échoue (job rouge) si :
//   - le build ne part ni de la branche par défaut du monorepo, ni d'un commit
//     précis (SHA complet) déjà intégré à cette branche ;
//   - les nouveautés de la version manquent ou sont invalides ;
//   - la version n'est pas strictement supérieure à celle publiée sur l'App Store.
//
// Variables d'environnement :
//   MONOREPO_REF     - input monorepo_ref du dispatch (vide, ou SHA complet intégré à la branche par défaut)
//   MONOREPO_REPO    - owner/repo du monorepo (vérification du SHA)
//   MONOREPO_TOKEN   - jeton de lecture du monorepo (vérification du SHA)
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

// Production = branche par défaut (ref vide), ou un commit PRÉCIS déjà intégré à
// cette branche (ex. le commit exact d'un build de test vérifié sur téléphone).
// Jamais une autre branche.
const ref = (process.env.MONOREPO_REF || '').trim();
if (ref) {
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    fail('Mise en production : monorepo_ref doit être vide (branche par défaut) ou un SHA complet de 40 caractères.');
  }
  const repo = process.env.MONOREPO_REPO;
  const token = process.env.MONOREPO_TOKEN;
  if (!repo || !token) fail('MONOREPO_REPO / MONOREPO_TOKEN requis pour vérifier le commit.');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const info = await fetch(`https://api.github.com/repos/${repo}`, { headers }).then((r) => r.json());
  // compare base...head : "ahead"/"identical" ⇔ le commit est un ancêtre de la branche par défaut.
  const cmp = await fetch(`https://api.github.com/repos/${repo}/compare/${ref}...${info.default_branch}`, { headers });
  const status = cmp.ok ? (await cmp.json()).status : `HTTP ${cmp.status}`;
  if (status !== 'ahead' && status !== 'identical') {
    fail(`Mise en production : le commit demandé n'est pas intégré à la branche par défaut (${status}).`);
  }
  console.log(`Commit précis, intégré à la branche par défaut (${status}).`);
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
