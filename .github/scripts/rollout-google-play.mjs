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

import crypto from 'node:crypto';

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

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken() {
  const sa = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: tokenUri, iat: now, exp: now + 3600 };
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key);
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${b64url(sig)}` }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Authentification Google refusée (${res.status} ${json.error || ''}).`);
  return json.access_token;
}

async function main() {
  const token = await accessToken();
  const call = async (url, opts = {}) => {
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  };

  const editId = (await call(`${API}/edits`, { method: 'POST', body: '{}' })).id;
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
    if (!committed) await call(edit, { method: 'DELETE' }).catch(() => {});
  }
}

main().catch((e) => fail(e.message));
