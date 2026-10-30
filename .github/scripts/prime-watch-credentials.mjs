#!/usr/bin/env node
// Amorce côté Apple + côté Expo les credentials des cibles watchOS pour que
// `eas build --non-interactive` ne tombe pas sur `MissingCredentialsNonInteractiveError`
// (eas-cli 26.0.0 `SetUpDistributionCertificate.runNonInteractiveAsync` lève cette
// erreur dès que le bundle visé n'a pas encore un `IosAppBuildCredentials` côté serveur
// Expo, même si le certificat de distribution existe pour l'App Store Connect team).
//
// Pour chaque bundle argument :
//   1. S'assure que le bundleIds Apple existe (POST /v1/bundleIds si absent).
//   2. Trouve ou crée un provisioning profile IOS_APP_STORE ACTIVE pour ce bundle,
//      lié au même Distribution Certificate que celui qu'utilise déjà `com.meschasses`
//      (lecture du profil IOS_APP_STORE du bundle principal via l'API ASC).
//   3. Télécharge le `.mobileprovision` en base64.
//   4. Côté Expo (GraphQL `https://api.expo.dev/graphql`, auth EXPO_TOKEN) :
//        a. find ou crée l'`AppleAppIdentifier`.
//        b. find ou crée l'`IosAppCredentials` (par bundle).
//        c. crée l'`AppleProvisioningProfile` Expo (upload base64 + developerPortalIdentifier).
//        d. crée l'`IosAppBuildCredentials` (iosDistributionType APP_STORE,
//           distributionCertificateId = celui déjà associé au bundle principal,
//           provisioningProfileId = celui qu'on vient de créer).
//
// Sans effet si tout est déjà en place (toutes les étapes sont idempotentes).
// Variables d'env attendues :
//   APPSTORE_API_KEY_ID / APPSTORE_API_PRIVATE_KEY / APPSTORE_ISSUER_ID (ASC JWT ES256)
//   APPSTORE_API_PRIVATE_KEY_PATH : chemin du .p8 si écrit sur disque (prend le dessus)
//   EXPO_TOKEN                   : token Expo (role publisher ou admin sur l'account)
//   EXPO_APP_ID                  : app id Expo (defaut 723bb511-987b-4d04-983b-40dfa4929bba)
//   EXPO_APPLE_TEAM_ID           : B77M2F5M8R
//   PRIMARY_BUNDLE               : bundle id du cert source (défaut com.meschasses)
//   TARGET_BUNDLES               : liste des bundles à amorcer, séparés par des espaces

import crypto from 'node:crypto';
import fs from 'node:fs';

const EXPO_APP_ID = process.env.EXPO_APP_ID || '723bb511-987b-4d04-983b-40dfa4929bba';
const EXPO_APPLE_TEAM_ID = process.env.EXPO_APPLE_TEAM_ID || 'B77M2F5M8R';
const PRIMARY_BUNDLE = process.env.PRIMARY_BUNDLE || 'com.meschasses';
const TARGET_BUNDLES = (process.env.TARGET_BUNDLES || '').split(/\s+/).filter(Boolean);
if (TARGET_BUNDLES.length === 0) {
  console.error('TARGET_BUNDLES vide — rien à faire');
  process.exit(1);
}
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
for (const b of TARGET_BUNDLES) {
  if (!RESYNC_ALLOWLIST.has(b)) {
    console.error(`TARGET_BUNDLES contient « ${b} » qui n'est pas dans la liste blanche montre : ${[...RESYNC_ALLOWLIST].join(', ')}`);
    process.exit(1);
  }
}
const EXPO_TOKEN = process.env.EXPO_TOKEN;
if (!EXPO_TOKEN) { console.error('EXPO_TOKEN manquant'); process.exit(1); }

const ASC_KEY_ID = process.env.APPSTORE_API_KEY_ID;
const ASC_ISSUER_ID = process.env.APPSTORE_ISSUER_ID;
if (!ASC_KEY_ID || !ASC_ISSUER_ID) { console.error('APPSTORE_API_KEY_ID / ISSUER_ID manquants'); process.exit(1); }

function readAscPrivateKey() {
  const asPath = process.env.APPSTORE_API_PRIVATE_KEY_PATH;
  if (asPath && fs.existsSync(asPath)) return fs.readFileSync(asPath, 'utf8');
  const raw = process.env.APPSTORE_API_PRIVATE_KEY;
  if (!raw) throw new Error('APPSTORE_API_PRIVATE_KEY manquant');
  // Si la clé a été passée via secret GitHub multiligne, les sauts de ligne sont présents.
  return raw;
}

const ascPem = readAscPrivateKey();
const ascKey = crypto.createPrivateKey(ascPem);

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeAscJwt() {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }));
  const sig = crypto.sign('SHA256', Buffer.from(`${header}.${payload}`), { key: ascKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(sig)}`;
}

async function asc(method, path, body) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + path, {
    method,
    headers: {
      Authorization: `Bearer ${makeAscJwt()}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (r.status >= 400) {
    const err = JSON.stringify(json).slice(0, 400);
    throw new Error(`ASC ${method} ${path} HTTP ${r.status} :: ${err}`);
  }
  return json;
}

async function expo(query, variables) {
  const r = await fetch('https://api.expo.dev/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EXPO_TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) {
    throw new Error(`Expo GraphQL error: ${JSON.stringify(j.errors).slice(0, 400)}`);
  }
  return j.data;
}

// Trouve un bundle Apple par son identifier EXACT. `/v1/bundleIds?filter[identifier]=X`
// retourne tous les bundles dont l'identifier CONTIENT X : `com.meschasses` ramène
// `com.meschasses`, `com.meschasses.widget`, `.watchkitapp`, `.complications`, et
// `limit=1` sélectionne un ordre non spécifié. On liste donc large puis on filtre.
async function findBundleByExactIdentifier(bundleIdentifier) {
  const d = await asc('GET', `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleIdentifier)}&limit=200`);
  return (d.data || []).find((b) => b.attributes?.identifier === bundleIdentifier) ?? null;
}

// ---- 1. Lire côté Apple le profil IOS_APP_STORE du bundle principal (pour en déduire le cert).
// On préfère le profil ACTIVE. À défaut, on lit le cert d'un profil INVALID : ajouter une
// capability à l'App ID (ex. HealthKit, vécu le 2026-10-30) invalide tous ses profils sans
// toucher au certificat. Ce profil du bundle principal appartient à EAS, qui le régénère
// lui-même au build : on ne fait ici que le LIRE, jamais le supprimer ni le recréer.
async function findPrimaryAppStoreProfileCert(bundleIdentifier) {
  const bundle = await findBundleByExactIdentifier(bundleIdentifier);
  if (!bundle) throw new Error(`Bundle Apple ${bundleIdentifier} introuvable`);
  const profiles = ((await asc('GET', `/v1/bundleIds/${bundle.id}/profiles?limit=50`)).data || [])
    .filter((p) => p.attributes.profileType === 'IOS_APP_STORE');
  const source = profiles.find((p) => p.attributes.profileState === 'ACTIVE')
    ?? profiles.find((p) => p.attributes.profileState === 'INVALID');
  if (!source) throw new Error(`Aucun profil IOS_APP_STORE (ACTIVE ou INVALID) pour ${bundleIdentifier}`);
  if (source.attributes.profileState !== 'ACTIVE') {
    console.log(`[ASC] Profil IOS_APP_STORE de ${bundleIdentifier} ${source.attributes.profileState} (${source.id}) : cert lu quand même, EAS régénérera le profil au build`);
  }
  const detail = await asc('GET', `/v1/profiles/${source.id}?include=certificates`);
  const certId = detail.data.relationships.certificates.data[0]?.id;
  if (!certId) throw new Error(`Profil ${source.id} n'a aucun certificat`);
  return { certId, primaryBundleAppleId: bundle.id, primaryProfileAppleId: source.id };
}

// ---- 2. ASC : s'assure du bundle, du profil IOS_APP_STORE lié au cert donné, retourne le .mobileprovision en base64.
// Les profils INVALID (une capability a été ajoutée au bundle depuis leur création,
// ou le cert a tourné) sont supprimés avant d'en recréer un à jour.
async function ensureAppStoreProfile(bundleIdentifier, certId, { name } = {}) {
  let bundle = await findBundleByExactIdentifier(bundleIdentifier);
  if (!bundle) {
    console.log(`[ASC] Création du bundle Apple ${bundleIdentifier}`);
    const created = await asc('POST', '/v1/bundleIds', {
      data: {
        type: 'bundleIds',
        attributes: {
          identifier: bundleIdentifier,
          name: (name || bundleIdentifier).replace(/[^A-Za-z0-9 ]/g, ' '),
          platform: 'IOS',
        },
      },
    });
    bundle = created.data;
  } else {
    console.log(`[ASC] Bundle ${bundleIdentifier} déjà présent (${bundle.id})`);
  }

  const existing = (await asc('GET', `/v1/bundleIds/${bundle.id}/profiles?limit=50`)).data || [];
  const staleAppStore = existing.filter((p) => p.attributes.profileType === 'IOS_APP_STORE' && p.attributes.profileState !== 'ACTIVE');
  for (const stale of staleAppStore) {
    console.log(`[ASC] Suppression du profil IOS_APP_STORE ${stale.attributes.profileState} ${stale.id}`);
    await asc('DELETE', `/v1/profiles/${stale.id}`);
  }
  let profile = existing.find((p) => p.attributes.profileType === 'IOS_APP_STORE' && p.attributes.profileState === 'ACTIVE');
  if (!profile) {
    console.log(`[ASC] Création du profil IOS_APP_STORE pour ${bundleIdentifier}`);
    const profileName = `[prime] ${bundleIdentifier} AppStore ${new Date().toISOString()}`;
    const created = await asc('POST', '/v1/profiles', {
      data: {
        type: 'profiles',
        attributes: {
          name: profileName,
          profileType: 'IOS_APP_STORE',
        },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundle.id } },
          certificates: { data: [{ type: 'certificates', id: certId }] },
        },
      },
    });
    profile = created.data;
  } else {
    console.log(`[ASC] Profil IOS_APP_STORE déjà actif pour ${bundleIdentifier} (${profile.id})`);
  }

  const full = await asc('GET', `/v1/profiles/${profile.id}`);
  const b64 = full.data.attributes.profileContent;
  if (!b64) throw new Error(`profileContent vide pour ${profile.id}`);
  return { bundleAppleId: bundle.id, profileAppleId: profile.id, profileBase64: b64 };
}

// ---- 3. Expo GraphQL — queries et mutations réduites.

async function expoApp() {
  const q = `query($id: String!) { app { byId(appId: $id) { id ownerAccount { id name } fullName } } }`;
  const d = await expo(q, { id: EXPO_APP_ID });
  const a = d.app.byId;
  if (!a) throw new Error('App Expo introuvable');
  return a;
}

async function expoFindAppleAppIdentifier(accountName, bundleIdentifier) {
  const q = `query($n: String!, $b: String!) { account { byName(accountName: $n) { id appleAppIdentifiers(bundleIdentifier: $b) { id bundleIdentifier } } } }`;
  const d = await expo(q, { n: accountName, b: bundleIdentifier });
  const all = d.account.byName.appleAppIdentifiers ?? [];
  // Même précaution que côté ASC : égalité exacte, pas de confiance aveugle au [0]
  // si le serveur devait un jour élargir la recherche à une sous-chaîne.
  return all.find((x) => x.bundleIdentifier === bundleIdentifier) ?? null;
}

async function expoCreateAppleAppIdentifier(accountId, bundleIdentifier, appleTeamId) {
  const q = `mutation($i: AppleAppIdentifierInput!, $a: ID!) { appleAppIdentifier { createAppleAppIdentifier(appleAppIdentifierInput: $i, accountId: $a) { id bundleIdentifier } } }`;
  const d = await expo(q, { i: { bundleIdentifier, appleTeamId }, a: accountId });
  return d.appleAppIdentifier.createAppleAppIdentifier;
}

async function expoFindAppleTeam(accountName, appleTeamIdentifier) {
  const q = `query($n: String!, $t: String!) { account { byName(accountName: $n) { id appleTeams(appleTeamIdentifier: $t) { id appleTeamIdentifier appleTeamName } } } }`;
  const d = await expo(q, { n: accountName, t: appleTeamIdentifier });
  return d.account.byName.appleTeams?.[0] ?? null;
}

async function expoCreateAppleTeam(accountId, appleTeamIdentifier) {
  const q = `mutation($i: AppleTeamInput!, $a: ID!) { appleTeam { createAppleTeam(appleTeamInput: $i, accountId: $a) { id appleTeamIdentifier } } }`;
  const d = await expo(q, { i: { appleTeamIdentifier }, a: accountId });
  return d.appleTeam.createAppleTeam;
}

async function expoFindDistributionCertificateForBundle(appFullName, appleAppIdentifierId) {
  const q = `query($p: String!, $a: String!) {
    app { byFullName(fullName: $p) { id iosAppCredentials(filter: { appleAppIdentifierId: $a }) { id iosAppBuildCredentialsList(filter: { iosDistributionType: APP_STORE }) { id distributionCertificate { id } provisioningProfile { id } } } } }
  }`;
  const d = await expo(q, { p: appFullName, a: appleAppIdentifierId });
  const list = d.app.byFullName?.iosAppCredentials?.[0]?.iosAppBuildCredentialsList ?? [];
  return list[0]?.distributionCertificate?.id ?? null;
}

async function expoFindIosAppCredentials(appFullName, appleAppIdentifierId) {
  const q = `query($p: String!, $a: String!) {
    app { byFullName(fullName: $p) { id iosAppCredentials(filter: { appleAppIdentifierId: $a }) { id iosAppBuildCredentialsList(filter: { iosDistributionType: APP_STORE }) { id distributionCertificate { id } provisioningProfile { id developerPortalIdentifier } } } } }
  }`;
  const d = await expo(q, { p: appFullName, a: appleAppIdentifierId });
  const ac = d.app.byFullName?.iosAppCredentials?.[0] ?? null;
  return ac;
}

// Supprime l'IosAppBuildCredentials existant côté Expo (p. ex. parce que son
// provisioning profile côté Expo pointe vers un developer portal id supprimé).
async function expoDeleteIosAppBuildCredentials(iosAppBuildCredentialsId) {
  const q = `mutation($id: ID!) { iosAppBuildCredentials { deleteIosAppBuildCredentials(id: $id) { id } } }`;
  await expo(q, { id: iosAppBuildCredentialsId });
}

async function expoDeleteAppleProvisioningProfile(id) {
  const q = `mutation($id: ID!) { appleProvisioningProfile { deleteAppleProvisioningProfile(id: $id) { id } } }`;
  try {
    await expo(q, { id });
  } catch (e) {
    console.log(`[Expo] Suppression du profile ${id} ignorée: ${e.message}`);
  }
}

async function expoCreateIosAppCredentials(appId, appleAppIdentifierId, appleTeamId) {
  const q = `mutation($i: IosAppCredentialsInput!, $app: ID!, $aai: ID!) { iosAppCredentials { createIosAppCredentials(iosAppCredentialsInput: $i, appId: $app, appleAppIdentifierId: $aai) { id } } }`;
  const d = await expo(q, { i: { appleTeamId }, app: appId, aai: appleAppIdentifierId });
  return d.iosAppCredentials.createIosAppCredentials;
}

async function expoCreateAppleProvisioningProfile(accountId, appleAppIdentifierId, profileBase64, developerPortalIdentifier) {
  const q = `mutation($i: AppleProvisioningProfileInput!, $a: ID!, $aai: ID!) { appleProvisioningProfile { createAppleProvisioningProfile(appleProvisioningProfileInput: $i, accountId: $a, appleAppIdentifierId: $aai) { id developerPortalIdentifier } } }`;
  const d = await expo(q, {
    i: { appleProvisioningProfile: profileBase64, developerPortalIdentifier },
    a: accountId,
    aai: appleAppIdentifierId,
  });
  return d.appleProvisioningProfile.createAppleProvisioningProfile;
}

async function expoCreateIosAppBuildCredentials(iosAppCredentialsId, distributionCertificateId, provisioningProfileId) {
  const q = `mutation($i: IosAppBuildCredentialsInput!, $c: ID!) { iosAppBuildCredentials { createIosAppBuildCredentials(iosAppBuildCredentialsInput: $i, iosAppCredentialsId: $c) { id } } }`;
  const d = await expo(q, {
    i: { iosDistributionType: 'APP_STORE', distributionCertificateId, provisioningProfileId },
    c: iosAppCredentialsId,
  });
  return d.iosAppBuildCredentials.createIosAppBuildCredentials;
}

// ---- 4. Pipeline principal.

async function main() {
  console.log(`== prime-watch-credentials : bundles = ${TARGET_BUNDLES.join(', ')} ==`);
  const app = await expoApp();
  const accountId = app.ownerAccount.id;
  const accountName = app.ownerAccount.name;
  const appFullName = app.fullName;
  console.log(`[Expo] app=${app.id} fullName=${appFullName} accountId=${accountId}`);

  // Apple team Expo
  let appleTeam = await expoFindAppleTeam(accountName, EXPO_APPLE_TEAM_ID);
  if (!appleTeam) {
    appleTeam = await expoCreateAppleTeam(accountId, EXPO_APPLE_TEAM_ID);
    console.log(`[Expo] AppleTeam créée: ${appleTeam.id}`);
  }

  // Cert source (celui qu'utilise déjà le bundle principal)
  const primaryAai = await expoFindAppleAppIdentifier(accountName, PRIMARY_BUNDLE);
  if (!primaryAai) throw new Error(`AppleAppIdentifier Expo introuvable pour ${PRIMARY_BUNDLE}`);
  const distributionCertificateId = await expoFindDistributionCertificateForBundle(appFullName, primaryAai.id);
  if (!distributionCertificateId) throw new Error(`distributionCertificate Expo introuvable pour ${PRIMARY_BUNDLE}`);
  console.log(`[Expo] distributionCertificateId (source ${PRIMARY_BUNDLE}) = ${distributionCertificateId}`);

  // Côté Apple : le cert utilisé par ce même profil (ID Apple).
  const { certId: appleCertId } = await findPrimaryAppStoreProfileCert(PRIMARY_BUNDLE);
  console.log(`[ASC] Apple cert id = ${appleCertId}`);

  for (const bundle of TARGET_BUNDLES) {
    console.log(`\n--- ${bundle} ---`);
    // a. Apple : bundle + profil + base64
    const { profileAppleId, profileBase64 } = await ensureAppStoreProfile(bundle, appleCertId, { name: bundle });
    console.log(`[ASC] profile Apple id = ${profileAppleId}`);

    // b. Expo : AppleAppIdentifier
    let aai = await expoFindAppleAppIdentifier(accountName, bundle);
    if (!aai) {
      aai = await expoCreateAppleAppIdentifier(accountId, bundle, appleTeam.id);
      console.log(`[Expo] AppleAppIdentifier créé: ${aai.id}`);
    } else {
      console.log(`[Expo] AppleAppIdentifier déjà présent: ${aai.id}`);
    }
    // Ceinture + bretelles avant toute écriture : ne JAMAIS continuer sur un
    // AppleAppIdentifier qui ne porte pas EXACTEMENT le bundle de la boucle.
    // Un bug de query qui remonterait un identifier voisin (p. ex. le bundle
    // principal) pourrait sinon détruire ses IosAppBuildCredentials.
    if (aai.bundleIdentifier !== bundle) {
      throw new Error(
        `[Expo] AppleAppIdentifier ${aai.id} porte « ${aai.bundleIdentifier} » et pas « ${bundle} » : refus de continuer`,
      );
    }

    // c. Expo : IosAppCredentials
    let credentials = await expoFindIosAppCredentials(appFullName, aai.id);
    if (!credentials) {
      credentials = await expoCreateIosAppCredentials(app.id, aai.id, appleTeam.id);
      console.log(`[Expo] IosAppCredentials créé: ${credentials.id}`);
    } else {
      console.log(`[Expo] IosAppCredentials déjà présent: ${credentials.id}`);
    }

    // d. Si l'IosAppBuildCredentials APP_STORE est absent OU pointe vers un profil
    //    différent du profil ACTIVE qu'on vient de constater côté Apple, on le refait.
    //    Mesuré nécessaire après l'activation d'une capability sur un bundle existant :
    //    les anciens profils tombent en INVALID côté ASC (reproduit le 2026-10-27 après
    //    activation d'APP_GROUPS sur watchkitapp/.complications).
    const existingBuild = credentials.iosAppBuildCredentialsList?.find?.((b) => b.distributionCertificate?.id === distributionCertificateId);
    const existingPortalId = existingBuild?.provisioningProfile?.developerPortalIdentifier ?? null;
    const needsRecreate = !existingBuild || existingPortalId !== profileAppleId;
    if (needsRecreate) {
      if (existingBuild) {
        console.log(`[Expo] Reset IosAppBuildCredentials ${existingBuild.id} (profile portal id ${existingPortalId || 'absent'} ≠ ${profileAppleId})`);
        await expoDeleteIosAppBuildCredentials(existingBuild.id);
        if (existingBuild.provisioningProfile?.id) {
          await expoDeleteAppleProvisioningProfile(existingBuild.provisioningProfile.id);
        }
      }
      const pp = await expoCreateAppleProvisioningProfile(accountId, aai.id, profileBase64, profileAppleId);
      console.log(`[Expo] AppleProvisioningProfile créé: ${pp.id}`);
      const built = await expoCreateIosAppBuildCredentials(credentials.id, distributionCertificateId, pp.id);
      console.log(`[Expo] IosAppBuildCredentials créé: ${built.id}`);
    } else {
      console.log(`[Expo] IosAppBuildCredentials déjà à jour: ${existingBuild.id} (portal ${existingPortalId})`);
    }
  }

  console.log('\n== prime-watch-credentials : OK ==');
}

main().catch((e) => { console.error(e); process.exit(1); });
