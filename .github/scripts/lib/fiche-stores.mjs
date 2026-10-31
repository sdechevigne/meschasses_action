// Fiches store (App Store + Google Play) depuis le monorepo :
//   apps/mobile/store/fiche/<langue>/<champ>.txt, lus et contrôlés par
//   apps/mobile/store/fiche/fiche.mjs (source unique des règles, importée ici).
//
// Utilisé par publish-app-store.mjs / publish-google-play.mjs (PUBLIER_FICHE=1)
// et par verifier-fiche-stores.mjs (lecture seule).
// REPO PUBLIC : les logs ne contiennent que des locales et des noms de champs ;
// seul verifier-fiche-stores.mjs imprime les textes, qui sont publics.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { notesForLocale } from './nouveautes.mjs';

export const FICHE_DIR = process.env.FICHE_DIR || 'app/apps/mobile/store/fiche';
export const FICHE_MODULE = process.env.FICHE_MODULE || `${FICHE_DIR}/fiche.mjs`;

// États d'une appInfo déjà en ligne (non modifiable).
const INFO_EN_LIGNE = ['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'REPLACED_WITH_NEW_INFO'];

export async function importerModuleFiche(chemin = FICHE_MODULE) {
  return import(pathToFileURL(resolve(chemin)).href);
}

/** { [locale]: fiche } pour toutes les langues du dossier ; lève si une fiche est invalide. */
export function chargerFiches(mod, dir) {
  const fiches = {};
  const erreurs = [];
  for (const langue of mod.langues(dir)) {
    const fiche = mod.lireFiche(dir, langue);
    erreurs.push(...mod.verifierFiche(langue, fiche));
    for (const locale of mod.LOCALES[langue] || []) fiches[locale] = fiche;
  }
  if (erreurs.length) throw new Error(`Fiche store invalide :\n- ${erreurs.join('\n- ')}`);
  if (!Object.keys(fiches).length) throw new Error(`Aucune fiche store dans ${dir}.`);
  return fiches;
}

export function champsAppStore(f) {
  return {
    info: { name: f.nom, subtitle: f['sous-titre'] },
    version: { description: f.description, keywords: f['mots-cles'], promotionalText: f['texte-promo'] || null },
  };
}

export function champsPlay(f) {
  return { title: f.nom, shortDescription: f['description-courte'], fullDescription: f.description };
}

export function planAppStore(existantes, fiches) {
  return Object.keys(fiches).map((locale) => {
    const l = existantes.find((e) => e.locale === locale);
    return l ? { locale, action: 'modifier', id: l.id } : { locale, action: 'creer' };
  });
}

export function verifierPublication(fiches, notes, version) {
  const langues = [...new Set(Object.keys(fiches).map((l) => l.slice(0, 2).toLowerCase()))];
  const manquantes = langues.filter((langue) => !notes || !notesForLocale(notes, langue));
  if (manquantes.length) {
    throw new Error(
      `Publication de la fiche impossible : nouveautés manquantes ` +
        manquantes.map((l) => `nouveautes/${version}/${l}.txt`).join(', ') + '.'
    );
  }
}

/** Différences champ par champ entre les stores (actuel) et le dépôt (attendu). */
export function ecart(actuel, attendu) {
  const diff = [];
  for (const [locale, champs] of Object.entries(attendu)) {
    for (const [champ, valeur] of Object.entries(champs)) {
      const avant = actuel[locale]?.[champ];
      if ((avant ?? '') !== (valeur ?? '')) diff.push({ locale, champ, actuel: avant, attendu: valeur });
    }
  }
  return diff;
}

// --- App Store Connect -------------------------------------------------------

async function appInfoEditable(api, appId) {
  const infos = (await api(`/apps/${appId}/appInfos?limit=10`)).data || [];
  const etat = (i) => i.attributes.state || i.attributes.appStoreState;
  return infos.find((i) => !INFO_EN_LIGNE.includes(etat(i)));
}

const localisations = async (api, chemin) =>
  ((await api(`${chemin}?limit=50`)).data || []).map((l) => ({ id: l.id, locale: l.attributes.locale, attributes: l.attributes }));

/** Crée ou met à jour les localisations App Store (appInfo éditable + version). */
export async function appliquerFicheAppStore(api, { appId, versionId, fiches }) {
  const info = await appInfoEditable(api, appId);
  if (!info) throw new Error('Aucune appInfo éditable : la version doit être en préparation.');

  const infoLocs = await localisations(api, `/appInfos/${info.id}/appInfoLocalizations`);
  const versionLocs = await localisations(api, `/appStoreVersions/${versionId}/appStoreVersionLocalizations`);
  // Les locales créées recopient les URL de fr-FR : vérifiées AVANT toute écriture.
  const privacyPolicyUrl = infoLocs.find((l) => l.locale === 'fr-FR')?.attributes.privacyPolicyUrl;
  const fr = versionLocs.find((l) => l.locale === 'fr-FR')?.attributes || {};
  const aCreer = (locs) => planAppStore(locs, fiches).some((p) => p.action === 'creer');
  const manquantes = [
    aCreer(infoLocs) && !privacyPolicyUrl && 'privacyPolicyUrl',
    aCreer(versionLocs) && !fr.supportUrl && 'supportUrl',
  ].filter(Boolean);
  if (manquantes.length) {
    throw new Error(`Fiche App Store fr-FR sans ${manquantes.join(', ')} : impossible de la recopier sur les locales créées.`);
  }

  for (const { locale, action, id } of planAppStore(infoLocs, fiches)) {
    const attributes = champsAppStore(fiches[locale]).info;
    if (action === 'modifier') {
      await api(`/appInfoLocalizations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'appInfoLocalizations', id, attributes } }),
      });
    } else {
      await api('/appInfoLocalizations', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'appInfoLocalizations',
            attributes: { locale, ...attributes, privacyPolicyUrl },
            relationships: { appInfo: { data: { type: 'appInfos', id: info.id } } },
          },
        }),
      });
    }
    console.log(`Fiche App Store ${locale} : nom et sous-titre (${action}).`);
  }

  for (const { locale, action, id } of planAppStore(versionLocs, fiches)) {
    const attributes = champsAppStore(fiches[locale]).version;
    if (action === 'modifier') {
      await api(`/appStoreVersionLocalizations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'appStoreVersionLocalizations', id, attributes } }),
      });
    } else {
      await api('/appStoreVersionLocalizations', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'appStoreVersionLocalizations',
            attributes: { locale, ...attributes, marketingUrl: fr.marketingUrl, supportUrl: fr.supportUrl },
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
          },
        }),
      });
    }
    console.log(`Fiche App Store ${locale} : description, mots-clés, texte promo (${action}).`);
  }
}

/** Fiche App Store actuelle, aux noms de champs du dépôt : { [locale]: {...} }. */
export async function lireFicheAppStore(api, appId) {
  const versions = (await api(`/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=1`)).data || [];
  if (!versions.length) throw new Error('Aucune version App Store.');
  const infos = (await api(`/apps/${appId}/appInfos?limit=10`)).data || [];
  const info = (await appInfoEditable(api, appId)) || infos[0];
  const fiche = {};
  for (const l of await localisations(api, `/appInfos/${info.id}/appInfoLocalizations`)) {
    fiche[l.locale] = { nom: l.attributes.name ?? '', 'sous-titre': l.attributes.subtitle ?? '' };
  }
  for (const l of await localisations(api, `/appStoreVersions/${versions[0].id}/appStoreVersionLocalizations`)) {
    Object.assign((fiche[l.locale] ||= {}), {
      'mots-cles': l.attributes.keywords ?? '',
      'texte-promo': l.attributes.promotionalText ?? '',
      description: l.attributes.description ?? '',
    });
  }
  return { version: versions[0].attributes.versionString, fiche };
}

// --- Google Play -------------------------------------------------------------

/** Écrit les fiches dans un edit ouvert (le commit reste à l'appelant). */
export async function appliquerFichePlay(call, edit, fiches) {
  for (const [locale, f] of Object.entries(fiches)) {
    await call(`${edit}/listings/${locale}`, {
      method: 'PUT',
      body: JSON.stringify({ language: locale, ...champsPlay(f) }),
    });
    console.log(`Fiche Google Play ${locale} : titre, descriptions courte et longue.`);
  }
}

export async function lireFichePlay(call, edit) {
  const fiche = {};
  for (const l of (await call(`${edit}/listings`)).listings || []) {
    fiche[l.language] = {
      nom: l.title ?? '',
      'description-courte': l.shortDescription ?? '',
      description: l.fullDescription ?? '',
    };
  }
  return fiche;
}

/** Sous-ensemble des champs du dépôt publié sur chaque store. */
export const CHAMPS_APP_STORE = ['nom', 'sous-titre', 'mots-cles', 'texte-promo', 'description'];
export const CHAMPS_PLAY = ['nom', 'description-courte', 'description'];

export function restreindre(fiches, champs) {
  return Object.fromEntries(
    Object.entries(fiches).map(([locale, f]) => [locale, Object.fromEntries(champs.map((c) => [c, f[c]]))])
  );
}
