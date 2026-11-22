#!/usr/bin/env node
// Amorce côté Apple + côté Expo les credentials des cibles watchOS pour que
// `eas build --non-interactive` ne tombe pas sur `MissingCredentialsNonInteractiveError`
// (eas-cli 26.0.0 `SetUpDistributionCertificate.runNonInteractiveAsync` lève cette
// erreur dès que le bundle visé n'a pas encore un `IosAppBuildCredentials` côté serveur
// Expo, même si le certificat de distribution existe pour l'App Store Connect team).
//
// Historique : jusqu'au 2026-11-21, ce script contenait toute la logique en inline.
// Le 2026-11-22, pour pouvoir amorcer AUSSI la cible d'extension de partage iOS
// (expo-share-intent, bundle com.meschasses.share-extension) sur tous les builds,
// la logique a été extraite dans lib/prime-ios-credentials.mjs — ce wrapper
// n'applique plus que la whitelist watch, le comportement est identique.
//
// Variables d'env attendues (inchangées) :
//   APPSTORE_API_KEY_ID / APPSTORE_API_PRIVATE_KEY / APPSTORE_ISSUER_ID (ASC JWT ES256)
//   APPSTORE_API_PRIVATE_KEY_PATH : chemin du .p8 si écrit sur disque (prend le dessus)
//   EXPO_TOKEN                   : token Expo (role publisher ou admin sur l'account)
//   EXPO_APP_ID                  : app id Expo (defaut 723bb511-987b-4d04-983b-40dfa4929bba)
//   EXPO_APPLE_TEAM_ID           : B77M2F5M8R
//   PRIMARY_BUNDLE               : bundle id du cert source (défaut com.meschasses)
//   TARGET_BUNDLES               : liste des bundles à amorcer, séparés par des espaces

import {
  createClients,
  parseTargetBundles,
  primeBundles,
  readAscPrivateKey,
} from './lib/prime-ios-credentials.mjs';

// Liste blanche en DUR des bundles qu'on autorise à être resynchronisés
// (suppression + recréation d'IosAppBuildCredentials côté Expo). Toute
// tentative sur un bundle hors liste — en particulier com.meschasses ou
// com.meschasses.widget qui portent la prod iPhone — fait échouer le script.
// Blinde contre une faute de frappe dans TARGET_BUNDLES ou un bug qui
// toucherait au mauvais AppleAppIdentifier côté Expo.
const RESYNC_ALLOWLIST = new Set([
  'com.meschasses.watchkitapp',
  'com.meschasses.watchkitapp.complications',
]);

async function main() {
  const bundles = parseTargetBundles(process.env.TARGET_BUNDLES, RESYNC_ALLOWLIST);

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
    // Les cibles watch n'ont pas besoin qu'on active APP_GROUPS : la capability
    // est déjà présente sur leurs bundles (mesurée le 2026-11-22 via API ASC).
    capabilities: [],
    label: 'watch-credentials',
    clients,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
