// Petite bibliothèque d'envoi Google Play (API Android Publisher v3) partagée par
// publish-google-play.mjs (téléphone, piste production), rollout-google-play.mjs
// (pilotage par paliers) et publish-google-play-wearos-track.mjs (app Wear OS,
// piste wear:internal). Aucune dépendance : JWT RS256 avec crypto natif,
// requêtes via fetch global (Node ≥ 22). REPO PUBLIC : ni la clé, ni le jeton
// ne sont écrits sur stdout.
//
// Expose :
//   accessToken(serviceAccountJson)   → jeton OAuth (chaîne), 1 h
//   makeCall(token)                    → async (url, opts) → objet (lance en cas d'erreur HTTP)
//   createEdit(call, api)              → id d'un nouvel edit sur l'application
//   deleteEdit(call, edit)             → DELETE silencieux (ignore les erreurs)

import crypto from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function accessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key);
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${input}.${b64url(sig)}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Authentification Google refusée (${res.status} ${json.error || ''}).`);
  }
  return json.access_token;
}

export function makeCall(token) {
  return async (url, opts = {}) => {
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${opts.method || 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')} → ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  };
}

export async function createEdit(call, api) {
  return (await call(`${api}/edits`, { method: 'POST', body: '{}' })).id;
}

export async function deleteEdit(call, edit) {
  await call(edit, { method: 'DELETE' }).catch(() => {});
}
