// Amorce des credentials iOS pour UNE cible d'extension additionnelle (watchOS,
// extension de partage, etc.) côté App Store Connect ET côté Expo, pour que
// `eas build --non-interactive` ne tombe pas sur `MissingCredentialsNonInteractiveError`
// quand il rencontre un bundle qu'Expo n'a pas encore vu.
//
// Extrait de prime-watch-credentials.mjs (restait inchangé jusqu'au 2026-11-21),
// que ce module alimente désormais aux côtés de prime-share-extension-credentials.mjs.
//
// Pipeline, pour chaque bundle argument :
//   1. S'assure que le bundleIds Apple existe (POST /v1/bundleIds si absent).
//   2. Active les capabilities demandées (POST /v1/bundleIdCapabilities si manquantes) ;
//      les App Groups du team sont alors rattachés automatiquement par Apple aux
//      profils générés (c'est ainsi qu'opère déjà `com.meschasses.widget`).
//   3. Trouve ou crée un profil IOS_APP_STORE ACTIVE pour ce bundle, lié au MÊME
//      distribution certificate que celui utilisé par PRIMARY_BUNDLE.
//   4. Télécharge le `.mobileprovision` (base64).
//   5. Côté Expo (GraphQL `https://api.expo.dev/graphql`, auth EXPO_TOKEN) :
//        a. find ou crée l'`AppleAppIdentifier`.
//        b. find ou crée l'`IosAppCredentials` (par bundle).
//        c. crée l'`AppleProvisioningProfile` Expo (upload base64 + developerPortalIdentifier).
//        d. crée l'`IosAppBuildCredentials` (iosDistributionType APP_STORE,
//           distributionCertificateId = celui déjà associé au bundle principal,
//           provisioningProfileId = celui qu'on vient de créer).
//
// Toutes les étapes sont idempotentes : sans effet si rien ne manque.

import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Lit la clé privée App Store Connect, en préférant le fichier (chemin passé par
 * APPSTORE_API_PRIVATE_KEY_PATH) à la variable d'environnement. Retourne le PEM brut.
 */
export function readAscPrivateKey(env = process.env) {
  const asPath = env.APPSTORE_API_PRIVATE_KEY_PATH;
  if (asPath && fs.existsSync(asPath)) return fs.readFileSync(asPath, 'utf8');
  const raw = env.APPSTORE_API_PRIVATE_KEY;
  if (!raw) throw new Error('APPSTORE_API_PRIVATE_KEY manquant');
  return raw;
}

/**
 * Parse une liste de bundles séparés par des espaces, en filtrant les vides.
 * Valide que chaque bundle est présent dans l'allowlist fournie (blindage
 * contre une faute de frappe dans la variable d'env — cf. commentaire historique
 * du script watch, où une faute ciblant com.meschasses détruirait ses credentials).
 *
 * @param {string} raw - valeur brute de TARGET_BUNDLES
 * @param {Set<string>} allowlist - bundles autorisés
 * @returns {string[]}
 */
export function parseTargetBundles(raw, allowlist) {
  const bundles = (raw || '').split(/\s+/).filter(Boolean);
  if (bundles.length === 0) {
    throw new Error('TARGET_BUNDLES vide — rien à faire');
  }
  for (const b of bundles) {
    if (!allowlist.has(b)) {
      throw new Error(
        `TARGET_BUNDLES contient « ${b} » qui n'est pas dans la liste blanche : ${[...allowlist].join(', ')}`,
      );
    }
  }
  return bundles;
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function makeAscJwtFactory(ascKey, keyId, issuerId) {
  return () => {
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }));
    const sig = crypto.sign('SHA256', Buffer.from(`${header}.${payload}`), { key: ascKey, dsaEncoding: 'ieee-p1363' });
    return `${header}.${payload}.${b64url(sig)}`;
  };
}

/**
 * Retourne un couple { asc, expo } : deux fonctions pour parler respectivement
 * à App Store Connect et à l'API GraphQL Expo. Le JWT ASC est régénéré à chaque
 * appel (même raison que lib/asc.mjs : les attentes dépassent 20 min).
 */
export function createClients({ ascKeyId, ascIssuerId, ascPem, expoToken }) {
  const ascKey = crypto.createPrivateKey(ascPem);
  const makeAscJwt = makeAscJwtFactory(ascKey, ascKeyId, ascIssuerId);

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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${expoToken}` },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) {
      throw new Error(`Expo GraphQL error: ${JSON.stringify(j.errors).slice(0, 400)}`);
    }
    return j.data;
  }

  return { asc, expo };
}

// Trouve un bundle Apple par son identifier EXACT. `/v1/bundleIds?filter[identifier]=X`
// retourne tous les bundles dont l'identifier CONTIENT X : `com.meschasses` ramène
// `com.meschasses`, `com.meschasses.widget`, `.watchkitapp`, `.complications`, etc.,
// et `limit=1` sélectionne un ordre non spécifié. On liste donc large puis on filtre.
export async function findBundleByExactIdentifier(asc, bundleIdentifier) {
  const d = await asc('GET', `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleIdentifier)}&limit=200`);
  return (d.data || []).find((b) => b.attributes?.identifier === bundleIdentifier) ?? null;
}

// Lit côté Apple le profil IOS_APP_STORE du bundle principal pour en déduire le cert.
// On préfère un profil ACTIVE ; à défaut on lit le cert d'un profil INVALID (ajouter
// une capability à l'App ID invalide ses profils sans toucher au certificat). Ce profil
// du bundle principal appartient à EAS, qui le régénère au build : on ne fait ici que le LIRE.
export async function findPrimaryAppStoreProfileCert(asc, bundleIdentifier) {
  const bundle = await findBundleByExactIdentifier(asc, bundleIdentifier);
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

// S'assure que les capabilities listées sont activées sur le bundle (idempotent).
// Un GET sur la relation bundleIdCapabilities retourne la liste actuelle ; on POST
// uniquement celles qui manquent. Apple rattache automatiquement les App Groups
// existants du team quand APP_GROUPS est activée (comportement constaté le 2026-11-22
// sur com.meschasses.widget : settings:null côté API, mais group.com.meschasses
// présent dans l'entitlement des profils générés).
export async function ensureBundleCapabilities(asc, bundleAppleId, capabilities) {
  if (!capabilities || capabilities.length === 0) return;
  const existing = (await asc('GET', `/v1/bundleIds/${bundleAppleId}/bundleIdCapabilities`)).data || [];
  const present = new Set(existing.map((c) => c.attributes.capabilityType));
  for (const cap of capabilities) {
    if (present.has(cap)) {
      console.log(`[ASC] Capacité ${cap} déjà active sur ${bundleAppleId}`);
      continue;
    }
    console.log(`[ASC] Activation de la capacité ${cap} sur ${bundleAppleId}`);
    await asc('POST', '/v1/bundleIdCapabilities', {
      data: {
        type: 'bundleIdCapabilities',
        attributes: { capabilityType: cap },
        relationships: { bundleId: { data: { type: 'bundleIds', id: bundleAppleId } } },
      },
    });
  }
}

// ASC : s'assure du bundle, de ses capabilities, du profil IOS_APP_STORE lié au cert
// donné, puis retourne le .mobileprovision en base64. Les profils INVALID sont supprimés
// avant d'en recréer un à jour (une capability activée après coup invalide les profils).
export async function ensureAppStoreProfile(asc, bundleIdentifier, certId, { name, capabilities } = {}) {
  let bundle = await findBundleByExactIdentifier(asc, bundleIdentifier);
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

  await ensureBundleCapabilities(asc, bundle.id, capabilities);

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

// ---- Côté Expo — queries et mutations réduites.

async function expoApp(expo, appId) {
  const q = `query($id: String!) { app { byId(appId: $id) { id ownerAccount { id name } fullName } } }`;
  const d = await expo(q, { id: appId });
  const a = d.app.byId;
  if (!a) throw new Error('App Expo introuvable');
  return a;
}

async function expoFindAppleAppIdentifier(expo, accountName, bundleIdentifier) {
  const q = `query($n: String!, $b: String!) { account { byName(accountName: $n) { id appleAppIdentifiers(bundleIdentifier: $b) { id bundleIdentifier } } } }`;
  const d = await expo(q, { n: accountName, b: bundleIdentifier });
  const all = d.account.byName.appleAppIdentifiers ?? [];
  return all.find((x) => x.bundleIdentifier === bundleIdentifier) ?? null;
}

async function expoCreateAppleAppIdentifier(expo, accountId, bundleIdentifier, appleTeamId) {
  const q = `mutation($i: AppleAppIdentifierInput!, $a: ID!) { appleAppIdentifier { createAppleAppIdentifier(appleAppIdentifierInput: $i, accountId: $a) { id bundleIdentifier } } }`;
  const d = await expo(q, { i: { bundleIdentifier, appleTeamId }, a: accountId });
  return d.appleAppIdentifier.createAppleAppIdentifier;
}

async function expoFindAppleTeam(expo, accountName, appleTeamIdentifier) {
  const q = `query($n: String!, $t: String!) { account { byName(accountName: $n) { id appleTeams(appleTeamIdentifier: $t) { id appleTeamIdentifier appleTeamName } } } }`;
  const d = await expo(q, { n: accountName, t: appleTeamIdentifier });
  return d.account.byName.appleTeams?.[0] ?? null;
}

async function expoCreateAppleTeam(expo, accountId, appleTeamIdentifier) {
  const q = `mutation($i: AppleTeamInput!, $a: ID!) { appleTeam { createAppleTeam(appleTeamInput: $i, accountId: $a) { id appleTeamIdentifier } } }`;
  const d = await expo(q, { i: { appleTeamIdentifier }, a: accountId });
  return d.appleTeam.createAppleTeam;
}

async function expoFindDistributionCertificateForBundle(expo, appFullName, appleAppIdentifierId) {
  const q = `query($p: String!, $a: String!) {
    app { byFullName(fullName: $p) { id iosAppCredentials(filter: { appleAppIdentifierId: $a }) { id iosAppBuildCredentialsList(filter: { iosDistributionType: APP_STORE }) { id distributionCertificate { id } provisioningProfile { id } } } } }
  }`;
  const d = await expo(q, { p: appFullName, a: appleAppIdentifierId });
  const list = d.app.byFullName?.iosAppCredentials?.[0]?.iosAppBuildCredentialsList ?? [];
  return list[0]?.distributionCertificate?.id ?? null;
}

async function expoFindIosAppCredentials(expo, appFullName, appleAppIdentifierId) {
  const q = `query($p: String!, $a: String!) {
    app { byFullName(fullName: $p) { id iosAppCredentials(filter: { appleAppIdentifierId: $a }) { id iosAppBuildCredentialsList(filter: { iosDistributionType: APP_STORE }) { id distributionCertificate { id } provisioningProfile { id developerPortalIdentifier } } } } }
  }`;
  const d = await expo(q, { p: appFullName, a: appleAppIdentifierId });
  return d.app.byFullName?.iosAppCredentials?.[0] ?? null;
}

async function expoDeleteIosAppBuildCredentials(expo, id) {
  const q = `mutation($id: ID!) { iosAppBuildCredentials { deleteIosAppBuildCredentials(id: $id) { id } } }`;
  await expo(q, { id });
}

async function expoDeleteAppleProvisioningProfile(expo, id) {
  const q = `mutation($id: ID!) { appleProvisioningProfile { deleteAppleProvisioningProfile(id: $id) { id } } }`;
  try {
    await expo(q, { id });
  } catch (e) {
    console.log(`[Expo] Suppression du profile ${id} ignorée: ${e.message}`);
  }
}

async function expoCreateIosAppCredentials(expo, appId, appleAppIdentifierId, appleTeamId) {
  const q = `mutation($i: IosAppCredentialsInput!, $app: ID!, $aai: ID!) { iosAppCredentials { createIosAppCredentials(iosAppCredentialsInput: $i, appId: $app, appleAppIdentifierId: $aai) { id } } }`;
  const d = await expo(q, { i: { appleTeamId }, app: appId, aai: appleAppIdentifierId });
  return d.iosAppCredentials.createIosAppCredentials;
}

async function expoCreateAppleProvisioningProfile(expo, accountId, appleAppIdentifierId, profileBase64, developerPortalIdentifier) {
  const q = `mutation($i: AppleProvisioningProfileInput!, $a: ID!, $aai: ID!) { appleProvisioningProfile { createAppleProvisioningProfile(appleProvisioningProfileInput: $i, accountId: $a, appleAppIdentifierId: $aai) { id developerPortalIdentifier } } }`;
  const d = await expo(q, {
    i: { appleProvisioningProfile: profileBase64, developerPortalIdentifier },
    a: accountId,
    aai: appleAppIdentifierId,
  });
  return d.appleProvisioningProfile.createAppleProvisioningProfile;
}

async function expoCreateIosAppBuildCredentials(expo, iosAppCredentialsId, distributionCertificateId, provisioningProfileId) {
  const q = `mutation($i: IosAppBuildCredentialsInput!, $c: ID!) { iosAppBuildCredentials { createIosAppBuildCredentials(iosAppBuildCredentialsInput: $i, iosAppCredentialsId: $c) { id } } }`;
  const d = await expo(q, {
    i: { iosDistributionType: 'APP_STORE', distributionCertificateId, provisioningProfileId },
    c: iosAppCredentialsId,
  });
  return d.iosAppBuildCredentials.createIosAppBuildCredentials;
}

/**
 * Pipeline principal factorisé — appelé par chaque wrapper (watch, share-extension…)
 * avec une allowlist de bundles distincte, et éventuellement des capabilities à
 * activer côté ASC (pour share-extension : APP_GROUPS).
 *
 * @param {Object} opts
 * @param {string[]} opts.bundles - bundles à amorcer (déjà validés contre l'allowlist)
 * @param {string} opts.expoAppId
 * @param {string} opts.expoAppleTeamId
 * @param {string} opts.primaryBundle
 * @param {string[]=} opts.capabilities - capacités ASC à activer sur chaque bundle (p. ex. ['APP_GROUPS'])
 * @param {string} opts.label - utilisé pour l'en-tête de log (ex. 'watch', 'share-extension')
 * @param {{asc: Function, expo: Function}} opts.clients
 */
export async function primeBundles({ bundles, expoAppId, expoAppleTeamId, primaryBundle, capabilities, label, clients }) {
  const { asc, expo } = clients;

  console.log(`== prime-${label} : bundles = ${bundles.join(', ')} ==`);
  const app = await expoApp(expo, expoAppId);
  const accountId = app.ownerAccount.id;
  const accountName = app.ownerAccount.name;
  const appFullName = app.fullName;
  console.log(`[Expo] app=${app.id} fullName=${appFullName} accountId=${accountId}`);

  let appleTeam = await expoFindAppleTeam(expo, accountName, expoAppleTeamId);
  if (!appleTeam) {
    appleTeam = await expoCreateAppleTeam(expo, accountId, expoAppleTeamId);
    console.log(`[Expo] AppleTeam créée: ${appleTeam.id}`);
  }

  const primaryAai = await expoFindAppleAppIdentifier(expo, accountName, primaryBundle);
  if (!primaryAai) throw new Error(`AppleAppIdentifier Expo introuvable pour ${primaryBundle}`);
  const distributionCertificateId = await expoFindDistributionCertificateForBundle(expo, appFullName, primaryAai.id);
  if (!distributionCertificateId) throw new Error(`distributionCertificate Expo introuvable pour ${primaryBundle}`);
  console.log(`[Expo] distributionCertificateId (source ${primaryBundle}) = ${distributionCertificateId}`);

  const { certId: appleCertId } = await findPrimaryAppStoreProfileCert(asc, primaryBundle);
  console.log(`[ASC] Apple cert id = ${appleCertId}`);

  for (const bundle of bundles) {
    console.log(`\n--- ${bundle} ---`);
    const { profileAppleId, profileBase64 } = await ensureAppStoreProfile(asc, bundle, appleCertId, { name: bundle, capabilities });
    console.log(`[ASC] profile Apple id = ${profileAppleId}`);

    let aai = await expoFindAppleAppIdentifier(expo, accountName, bundle);
    if (!aai) {
      aai = await expoCreateAppleAppIdentifier(expo, accountId, bundle, appleTeam.id);
      console.log(`[Expo] AppleAppIdentifier créé: ${aai.id}`);
    } else {
      console.log(`[Expo] AppleAppIdentifier déjà présent: ${aai.id}`);
    }
    // Ceinture + bretelles : ne JAMAIS continuer sur un AppleAppIdentifier qui ne porte pas EXACTEMENT
    // le bundle de la boucle. Un bug de query qui remonterait un identifier voisin (p. ex. le bundle
    // principal) pourrait sinon détruire ses IosAppBuildCredentials.
    if (aai.bundleIdentifier !== bundle) {
      throw new Error(
        `[Expo] AppleAppIdentifier ${aai.id} porte « ${aai.bundleIdentifier} » et pas « ${bundle} » : refus de continuer`,
      );
    }

    let credentials = await expoFindIosAppCredentials(expo, appFullName, aai.id);
    if (!credentials) {
      credentials = await expoCreateIosAppCredentials(expo, app.id, aai.id, appleTeam.id);
      console.log(`[Expo] IosAppCredentials créé: ${credentials.id}`);
    } else {
      console.log(`[Expo] IosAppCredentials déjà présent: ${credentials.id}`);
    }

    // Si l'IosAppBuildCredentials APP_STORE est absent OU pointe vers un profil
    // différent du profil ACTIVE qu'on vient de constater côté Apple, on le refait.
    const existingBuild = credentials.iosAppBuildCredentialsList?.find?.((b) => b.distributionCertificate?.id === distributionCertificateId);
    const existingPortalId = existingBuild?.provisioningProfile?.developerPortalIdentifier ?? null;
    const needsRecreate = !existingBuild || existingPortalId !== profileAppleId;
    if (needsRecreate) {
      if (existingBuild) {
        console.log(`[Expo] Reset IosAppBuildCredentials ${existingBuild.id} (profile portal id ${existingPortalId || 'absent'} ≠ ${profileAppleId})`);
        await expoDeleteIosAppBuildCredentials(expo, existingBuild.id);
        if (existingBuild.provisioningProfile?.id) {
          await expoDeleteAppleProvisioningProfile(expo, existingBuild.provisioningProfile.id);
        }
      }
      const pp = await expoCreateAppleProvisioningProfile(expo, accountId, aai.id, profileBase64, profileAppleId);
      console.log(`[Expo] AppleProvisioningProfile créé: ${pp.id}`);
      const built = await expoCreateIosAppBuildCredentials(expo, credentials.id, distributionCertificateId, pp.id);
      console.log(`[Expo] IosAppBuildCredentials créé: ${built.id}`);
    } else {
      console.log(`[Expo] IosAppBuildCredentials déjà à jour: ${existingBuild.id} (portal ${existingPortalId})`);
    }
  }

  console.log(`\n== prime-${label} : OK ==`);
}
