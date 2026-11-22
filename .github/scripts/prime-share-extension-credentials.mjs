#!/usr/bin/env node
// Amorce côté Apple + côté Expo les credentials de la cible d'extension de partage iOS
// (plugin expo-share-intent ^9) sur TOUS les builds iOS — contrairement à prime-watch,
// cette cible est incluse dans chaque build (pas conditionnée à un input watch=true).
//
// Comportement :
//   1. Crée côté Apple le bundleIds `com.meschasses.share-extension` si absent.
//   2. Active la capability APP_GROUPS sur ce bundle (settings:null, le groupe
//      `group.com.meschasses` du team est alors rattaché automatiquement dans le
//      profil généré — comportement constaté le 2026-11-22 sur com.meschasses.widget,
//      qui porte le même groupe sans configuration explicite côté Apple).
//   3. Crée le profil IOS_APP_STORE lié au même distribution certificate que
//      `com.meschasses`, puis l'enregistre côté Expo via les mutations GraphQL
//      habituelles (créer/réutiliser AppleAppIdentifier, IosAppCredentials, …).
//
// Idempotent : sans effet si tout est déjà en place. Variables d'env attendues :
//   APPSTORE_API_KEY_ID / APPSTORE_API_PRIVATE_KEY / APPSTORE_ISSUER_ID (ASC JWT ES256)
//   APPSTORE_API_PRIVATE_KEY_PATH : chemin du .p8 si écrit sur disque (prend le dessus)
//   EXPO_TOKEN                   : token Expo
//   EXPO_APP_ID                  : app id Expo (defaut 723bb511-987b-4d04-983b-40dfa4929bba)
//   EXPO_APPLE_TEAM_ID           : B77M2F5M8R
//   PRIMARY_BUNDLE               : bundle id du cert source (défaut com.meschasses)
//   TARGET_BUNDLES               : OPTIONNEL — par défaut `com.meschasses.share-extension`.
//
// Le bundle id de l'extension est imposé par le plugin expo-share-intent :
//   `${iosAppBundleIdentifier}.share-extension` quand `iosShareExtensionBundleIdentifier`
//   n'est pas passé (vérifié dans node_modules/expo-share-intent/plugin/build/ios/constants.js).
// `apps/mobile/app.json` configure bien `iosShareExtensionName: "Mes Chasses Partage"`
// et `iosAppGroupIdentifier: "group.com.meschasses"`, SANS surcharger le bundle id.

import {
  createClients,
  parseTargetBundles,
  primeBundles,
  readAscPrivateKey,
} from './lib/prime-ios-credentials.mjs';

// Liste blanche : seulement les bundles relatifs à l'extension de partage.
// Même garde-fou que prime-watch : interdit de pointer sur un autre bundle de la prod.
const RESYNC_ALLOWLIST = new Set([
  'com.meschasses.share-extension',
]);

async function main() {
  const bundles = parseTargetBundles(
    process.env.TARGET_BUNDLES || 'com.meschasses.share-extension',
    RESYNC_ALLOWLIST,
  );

  const EXPO_TOKEN = process.env.EXPO_TOKEN;
  if (!EXPO_TOKEN) { console.error('EXPO_TOKEN manquant'); process.exit(1); }
  const ASC_KEY_ID = process.env.APPSTORE_API_KEY_ID;
  const ASC_ISSUER_ID = process.env.APPSTORE_ISSUER_ID;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID) { console.error('APPSTORE_API_KEY_ID / ISSUER_ID manquants'); process.exit(1); }

  const clients = createClients({
    ascKeyId: ASC_KEY_ID,
    ascIssuerId: ASC_ISSUER_ID,
    ascPem: readAscPrivateKey(),
    expoToken: EXPO_TOKEN,
  });

  await primeBundles({
    bundles,
    expoAppId: process.env.EXPO_APP_ID || '723bb511-987b-4d04-983b-40dfa4929bba',
    expoAppleTeamId: process.env.EXPO_APPLE_TEAM_ID || 'B77M2F5M8R',
    primaryBundle: process.env.PRIMARY_BUNDLE || 'com.meschasses',
    // L'extension de partage a besoin de l'App Group pour échanger avec l'app
    // principale (fichiers partagés transitent via group.com.meschasses).
    capabilities: ['APP_GROUPS'],
    label: 'share-extension-credentials',
    clients,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
