import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, checkIos, checkAndroid, parseExtensions } from './minimums.mjs';

const regles = { minimum: '16.4', extensions: { 'MesChassesWidgets.appex': '18.0' } };

test('compareVersions compare numériquement, chiffres manquants = 0', () => {
  assert.equal(compareVersions('16.4', '16.4.0'), 0);
  assert.equal(compareVersions('15.1', '16.4'), -1);
  assert.equal(compareVersions('16.10', '16.4'), 1);
});

test('app au minimum, frameworks en dessous, widget autorisé : aucune erreur', () => {
  assert.deepEqual(checkIos({
    app: { name: 'MesChasses.app', min: '16.4' },
    frameworks: [{ name: 'hermes.framework', min: '15.1' }, { name: 'Sans.framework', min: null }],
    extensions: [{ name: 'MesChassesWidgets.appex', min: '18.0' }],
  }, regles), []);
});

test('app relevée : erreur', () => {
  const e = checkIos({ app: { name: 'MesChasses.app', min: '17.0' }, frameworks: [], extensions: [] }, regles);
  assert.equal(e.length, 1);
  assert.match(e[0], /MesChasses\.app.*17\.0.*16\.4/);
});

test('framework au-dessus du minimum : erreur nommée', () => {
  const e = checkIos({ app: { name: 'A.app', min: '16.4' }, frameworks: [{ name: 'Lourd.framework', min: '17.0' }], extensions: [] }, regles);
  assert.match(e[0], /Lourd\.framework/);
});

test('extension inconnue au-dessus du minimum : erreur ; extension autorisée qui monte encore : erreur', () => {
  assert.equal(checkIos({ app: { name: 'A.app', min: '16.4' }, frameworks: [], extensions: [{ name: 'Autre.appex', min: '17.0' }] }, regles).length, 1);
  assert.equal(checkIos({ app: { name: 'A.app', min: '16.4' }, frameworks: [], extensions: [{ name: 'MesChassesWidgets.appex', min: '18.2' }] }, regles).length, 1);
});

test('Android : minSdk égal attendu = OK, différent = erreur', () => {
  assert.deepEqual(checkAndroid(24, 24), []);
  assert.match(checkAndroid(26, 24)[0], /26.*24/);
});

test('parseExtensions lit « nom=version » séparés par des virgules', () => {
  assert.deepEqual(parseExtensions('A.appex=18.0, B.appex=17.0'), { 'A.appex': '18.0', 'B.appex': '17.0' });
  assert.deepEqual(parseExtensions(''), {});
});
