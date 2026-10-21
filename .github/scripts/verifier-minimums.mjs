#!/usr/bin/env node
// Garde-fou avant envoi aux stores : versions minimales iOS / Android inchangées (aucun appareil perdu).
// Usage : verifier-minimums.mjs ios <fichier.ipa> | android <fichier.aab> <bundletool.jar>
// Réglages (env) : MIN_IOS (défaut 16.4), EXTENSIONS_IOS (« Nom.appex=18.0,… »), MIN_ANDROID (défaut 24).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAndroid, checkIos, parseExtensions } from './lib/minimums.mjs';

const [plateforme, fichier, bundletool] = process.argv.slice(2);
const sortir = (erreurs, tableau) => {
  console.log(tableau);
  if (erreurs.length) { for (const e of erreurs) console.log(`::error::${e}`); process.exit(1); }
  console.log('Versions minimales conformes.');
};

if (plateforme === 'ios') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-'));
  execFileSync('unzip', ['-q', fichier, '-d', tmp]);
  const payload = path.join(tmp, 'Payload');
  const app = fs.readdirSync(payload).find((d) => d.endsWith('.app'));
  const lire = (dossier) => {
    const plist = path.join(dossier, 'Info.plist');
    if (!fs.existsSync(plist)) return null;
    return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })).MinimumOSVersion ?? null;
  };
  const lister = (dossier, ext) => (fs.existsSync(dossier) ? fs.readdirSync(dossier).filter((d) => d.endsWith(ext)) : [])
    .map((d) => ({ name: d, min: lire(path.join(dossier, d)) }));
  const racine = path.join(payload, app);
  const releve = {
    app: { name: app, min: lire(racine) },
    frameworks: lister(path.join(racine, 'Frameworks'), '.framework'),
    extensions: lister(path.join(racine, 'PlugIns'), '.appex'),
  };
  const regles = { minimum: process.env.MIN_IOS || '16.4', extensions: parseExtensions(process.env.EXTENSIONS_IOS) };
  const lignes = [releve.app, ...releve.frameworks, ...releve.extensions].map((x) => `${x.name.padEnd(48)} ${x.min ?? '—'}`);
  sortir(checkIos(releve, regles), lignes.join('\n'));
} else if (plateforme === 'android') {
  const brut = execFileSync('java', ['-jar', bundletool, 'dump', 'manifest', '--bundle', fichier,
    '--xpath', '/manifest/uses-sdk/@android:minSdkVersion'], { encoding: 'utf8' }).trim();
  const attendu = Number(process.env.MIN_ANDROID || 24);
  sortir(checkAndroid(Number(brut), attendu), `minSdkVersion = ${brut}`);
} else {
  console.error('usage : verifier-minimums.mjs ios <ipa> | android <aab> <bundletool.jar>');
  process.exit(2);
}
