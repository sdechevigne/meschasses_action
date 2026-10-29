// Pilote le déploiement PAR PALIERS de la piste production Google Play :
//   ACTION=fraction  PLAY_USER_FRACTION=0.5  → monte le palier (release inProgress)
//   ACTION=complete                           → publie à 100 % (status completed)
//   ACTION=halt                               → met en PAUSE (status halted ; les
//                                               utilisateurs déjà servis gardent l'app)
// Opère sur la release inProgress (ou halted) courante de la piste production.
// Mêmes conventions que publish-google-play.mjs (JWT RS256 natif, aucune dépendance,
// REPO PUBLIC : ni clé ni jeton sur stdout).
//
// Variables : GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (secret), PLAY_PACKAGE_NAME
// (défaut com.meschasses), ACTION, PLAY_USER_FRACTION (si ACTION=fraction).

import { accessToken, makeCall, createEdit, deleteEdit } from './lib/play.mjs';

const PACKAGE = process.env.PLAY_PACKAGE_NAME || 'com.meschasses';
const ACTION = process.env.ACTION;
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

if (!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) fail('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON manquant');
if (!['fraction', 'complete', 'halt'].includes(ACTION)) fail("ACTION doit valoir 'fraction', 'complete' ou 'halt'.");
let fraction = null;
if (ACTION === 'fraction') {
  fraction = Number(process.env.PLAY_USER_FRACTION);
  if (!(fraction > 0 && fraction < 1)) fail('PLAY_USER_FRACTION doit être strictement entre 0 et 1 (ex. 0.5).');
}

async function main() {
  const token = await accessToken(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  const call = makeCall(token);

  const editId = await createEdit(call, API);
  const edit = `${API}/edits/${editId}`;
  let committed = false;
  try {
    const prod = await call(`${edit}/tracks/production`);
    const releases = prod.releases || [];
    for (const r of releases) console.log(`Piste production : ${r.name || '(sans nom)'} — ${r.status}${r.userFraction ? ` — ${Math.round(r.userFraction * 100)} %` : ''} — ${(r.versionCodes || []).join(', ')}`);
    const staged = releases.find((r) => r.status === 'inProgress' || r.status === 'halted');
    if (!staged) throw new Error('Aucune release par paliers (inProgress/halted) sur la piste production : rien à piloter.');

    if (ACTION === 'fraction') { staged.status = 'inProgress'; staged.userFraction = fraction; }
    else if (ACTION === 'halt') { staged.status = 'halted'; }
    else { staged.status = 'completed'; delete staged.userFraction; }

    await call(`${edit}/tracks/production`, { method: 'PUT', body: JSON.stringify({ track: 'production', releases: [staged] }) });
    await call(`${edit}:commit`, { method: 'POST' });
    committed = true;
    console.log(ACTION === 'fraction'
      ? `✅ Palier monté à ${Math.round(fraction * 100)} % (${staged.name}).`
      : ACTION === 'halt'
        ? `⏸️ Déploiement en PAUSE (${staged.name}) : plus aucun nouvel utilisateur servi.`
        : `🎉 Déploiement complété à 100 % (${staged.name}).`);
  } finally {
    if (!committed) await deleteEdit(call, edit);
  }
}

main().catch((e) => fail(e.message));
