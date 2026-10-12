// Nouveautés de version (« What's new ») écrites dans le monorepo, une par langue :
//   apps/mobile/store/nouveautes/<version>/<langue>.txt   (ex. 4.2.7/fr.txt, 4.2.7/en.txt)
//
// Un fichier par LANGUE (fr, en…), appliqué à toute locale de fiche store qui
// commence par ce code (fr-FR, fr-CA → fr.txt ; en-US, en-GB → en.txt).
// Ces textes sont publics par nature (affichés sur les stores) : ils peuvent
// apparaître dans les logs de ce repo public.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Limite la plus stricte des deux stores : Google Play = 500 caractères par
// langue (Apple en accepte 4 000). Un seul texte sert aux deux stores.
export const MAX_CHARS = 500;

/**
 * Lit et valide les nouveautés d'une version. Lève une Error lisible si le
 * dossier manque, s'il est vide, ou si un texte est vide / trop long.
 * @returns {Record<string, string>} langue → texte
 */
export function readNouveautes(rootDir, version) {
  const dir = join(rootDir, version);
  if (!existsSync(dir)) {
    throw new Error(
      `Nouveautés absentes pour la version ${version} : créer ${dir}/fr.txt et en.txt dans le monorepo.`
    );
  }
  const notes = {};
  for (const file of readdirSync(dir)) {
    const m = /^([a-z]{2})\.txt$/.exec(file);
    if (!m) continue;
    const text = readFileSync(join(dir, file), 'utf8').trim();
    if (!text) throw new Error(`Nouveautés ${version}/${file} : fichier vide.`);
    const len = [...text].length;
    if (len > MAX_CHARS) {
      throw new Error(`Nouveautés ${version}/${file} : ${len} caractères, limite ${MAX_CHARS} (Google Play).`);
    }
    notes[m[1]] = text;
  }
  if (!notes.fr) throw new Error(`Nouveautés ${version} : fr.txt obligatoire (langue principale).`);
  return notes;
}

/** Texte à utiliser pour une locale de fiche store (ex. fr-FR → notes.fr), ou undefined. */
export function notesForLocale(notes, locale) {
  return notes[locale.slice(0, 2).toLowerCase()];
}

/** Compare deux versions SemVer « x.y.z » (suffixe -… ignoré). Retourne -1, 0 ou 1. */
export function compareSemver(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
