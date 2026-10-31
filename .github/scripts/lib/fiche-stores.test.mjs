import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appliquerFicheAppStore,
  chargerFiches,
  champsAppStore,
  champsPlay,
  ecart,
  planAppStore,
  verifierPublication,
} from './fiche-stores.mjs';

const fiche = (langue, surcharge = {}) => ({
  nom: `Nom ${langue}`,
  'sous-titre': `Sous-titre ${langue}`,
  'mots-cles': 'a,b',
  'texte-promo': '',
  'description-courte': `Court ${langue}`,
  description: `Description ${langue}`,
  ...surcharge,
});

// Faux module fiche.mjs (même contrat que apps/mobile/store/fiche/fiche.mjs).
const faux = (fiches, erreurs = {}) => ({
  LOCALES: { fr: ['fr-FR'], en: ['en-GB', 'en-US'] },
  langues: () => Object.keys(fiches),
  lireFiche: (_dir, langue) => fiches[langue],
  verifierFiche: (langue) => erreurs[langue] || [],
});

test('chargerFiches met chaque langue à plat sur ses locales', () => {
  const fiches = chargerFiches(faux({ fr: fiche('fr'), en: fiche('en') }), 'x');
  assert.deepEqual(Object.keys(fiches).sort(), ['en-GB', 'en-US', 'fr-FR']);
  assert.equal(fiches['en-US'].nom, 'Nom en');
});

test('chargerFiches refuse une fiche invalide en listant les erreurs', () => {
  assert.throws(
    () => chargerFiches(faux({ fr: fiche('fr') }, { fr: ['fr/nom : 31 caractères, limite 30'] }), 'x'),
    /fr\/nom : 31 caractères/
  );
});

test('champsAppStore envoie un texte promo vide comme null', () => {
  const c = champsAppStore(fiche('fr'));
  assert.deepEqual(c.info, { name: 'Nom fr', subtitle: 'Sous-titre fr' });
  assert.deepEqual(c.version, { description: 'Description fr', keywords: 'a,b', promotionalText: null });
  assert.equal(champsAppStore(fiche('fr', { 'texte-promo': 'Promo' })).version.promotionalText, 'Promo');
});

test('champsPlay', () => {
  assert.deepEqual(champsPlay(fiche('en')), {
    title: 'Nom en',
    shortDescription: 'Court en',
    fullDescription: 'Description en',
  });
});

test('planAppStore crée les locales absentes et modifie les autres', () => {
  const fiches = { 'fr-FR': fiche('fr'), 'en-GB': fiche('en'), 'en-US': fiche('en') };
  assert.deepEqual(planAppStore([{ locale: 'fr-FR', id: 'x' }, { locale: 'de-DE', id: 'y' }], fiches), [
    { locale: 'fr-FR', action: 'modifier', id: 'x' },
    { locale: 'en-GB', action: 'creer' },
    { locale: 'en-US', action: 'creer' },
  ]);
});

test('verifierPublication exige les nouveautés de chaque langue de fiche', () => {
  const fiches = { 'fr-FR': fiche('fr'), 'en-GB': fiche('en'), 'en-US': fiche('en') };
  assert.throws(() => verifierPublication(fiches, { fr: 'Notes' }, '5.1.0'), /nouveautes\/5\.1\.0\/en\.txt/);
  assert.throws(() => verifierPublication(fiches, null, '5.1.0'), /fr\.txt.*en\.txt/);
  assert.doesNotThrow(() => verifierPublication(fiches, { fr: 'Notes', en: 'Notes' }, '5.1.0'));
});

test('ecart liste les champs différents et les locales absentes du store', () => {
  const attendu = { 'fr-FR': { nom: 'A', description: 'D' }, 'en-GB': { nom: 'B' } };
  const actuel = { 'fr-FR': { nom: 'A', description: 'X' } };
  assert.deepEqual(ecart(actuel, attendu), [
    { locale: 'fr-FR', champ: 'description', actuel: 'X', attendu: 'D' },
    { locale: 'en-GB', champ: 'nom', actuel: undefined, attendu: 'B' },
  ]);
});

// Faux client App Store Connect : réponses par chemin, journal des écritures.
function fauxAsc({ privacyPolicyUrl, supportUrl }) {
  const ecritures = [];
  const api = async (chemin, opts = {}) => {
    if (opts.method) {
      ecritures.push(`${opts.method} ${chemin}`);
      return {};
    }
    if (chemin.startsWith('/apps/app/appInfos')) return { data: [{ id: 'info', attributes: { state: 'PREPARE_FOR_SUBMISSION' } }] };
    if (chemin.startsWith('/appInfos/info/appInfoLocalizations'))
      return { data: [{ id: 'i-fr', attributes: { locale: 'fr-FR', privacyPolicyUrl } }] };
    if (chemin.startsWith('/appStoreVersions/v/appStoreVersionLocalizations'))
      return { data: [{ id: 'v-fr', attributes: { locale: 'fr-FR', supportUrl, marketingUrl: 'https://m' } }] };
    throw new Error(`chemin inattendu ${chemin}`);
  };
  return { api, ecritures };
}

const fichesFrEn = () => ({ 'fr-FR': fiche('fr'), 'en-GB': fiche('en'), 'en-US': fiche('en') });

test('appliquerFicheAppStore crée les locales EN et modifie fr-FR', async () => {
  const { api, ecritures } = fauxAsc({ privacyPolicyUrl: 'https://p', supportUrl: 'https://s' });
  await appliquerFicheAppStore(api, { appId: 'app', versionId: 'v', fiches: fichesFrEn() });
  assert.deepEqual(ecritures, [
    'PATCH /appInfoLocalizations/i-fr',
    'POST /appInfoLocalizations',
    'POST /appInfoLocalizations',
    'PATCH /appStoreVersionLocalizations/v-fr',
    'POST /appStoreVersionLocalizations',
    'POST /appStoreVersionLocalizations',
  ]);
});

test('appliquerFicheAppStore refuse avant toute écriture si une URL fr-FR à recopier manque', async () => {
  for (const urls of [{ supportUrl: 'https://s' }, { privacyPolicyUrl: 'https://p' }]) {
    const { api, ecritures } = fauxAsc(urls);
    await assert.rejects(
      appliquerFicheAppStore(api, { appId: 'app', versionId: 'v', fiches: fichesFrEn() }),
      /fr-FR.*(privacyPolicyUrl|supportUrl)/
    );
    assert.deepEqual(ecritures, []);
  }
});
