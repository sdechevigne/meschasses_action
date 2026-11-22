import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTargetBundles } from './prime-ios-credentials.mjs';

const ALLOW = new Set(['com.meschasses.watchkitapp', 'com.meschasses.watchkitapp.complications']);

test('parseTargetBundles : chaîne vide → erreur explicite', () => {
  assert.throws(() => parseTargetBundles('', ALLOW), /TARGET_BUNDLES vide/);
  assert.throws(() => parseTargetBundles(undefined, ALLOW), /TARGET_BUNDLES vide/);
});

test('parseTargetBundles : espaces multiples tolérés, vides filtrés', () => {
  const r = parseTargetBundles('  com.meschasses.watchkitapp   com.meschasses.watchkitapp.complications  ', ALLOW);
  assert.deepEqual(r, ['com.meschasses.watchkitapp', 'com.meschasses.watchkitapp.complications']);
});

test('parseTargetBundles : bundle hors allowlist refusé, le nom est dans le message', () => {
  assert.throws(
    () => parseTargetBundles('com.meschasses', ALLOW),
    /com\.meschasses.*liste blanche/s,
  );
});

test('parseTargetBundles : faute de frappe refusée, les bundles autorisés sont listés', () => {
  assert.throws(
    () => parseTargetBundles('com.meschasses.watchkitapp.complication', ALLOW),
    /com\.meschasses\.watchkitapp\.complications/,
  );
});

test('parseTargetBundles : allowlist pour l\'extension de partage accepte son seul bundle', () => {
  const ext = new Set(['com.meschasses.share-extension']);
  assert.deepEqual(
    parseTargetBundles('com.meschasses.share-extension', ext),
    ['com.meschasses.share-extension'],
  );
  assert.throws(
    () => parseTargetBundles('com.meschasses.widget', ext),
    /com\.meschasses\.widget/,
  );
});
