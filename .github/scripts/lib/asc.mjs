// Client minimal de l'App Store Connect API, partagé par les scripts iOS.
//
// Aucune dépendance externe : JWT ES256 signé avec le module crypto natif de
// Node, requêtes via le fetch global (Node 22). Le JWT est RÉGÉNÉRÉ à chaque
// requête : les attentes de traitement Apple dépassent souvent la durée de vie
// d'un token (cause des 401 de l'ancienne action apple-actions).
//
// REPO PUBLIC : ce module n'écrit jamais la clé ni le token sur stdout.

import crypto from 'node:crypto';

const BASE = 'https://api.appstoreconnect.apple.com/v1';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Accepte le PEM complet ou le seul corps base64 de la clé .p8.
function normalizePem(raw) {
  const pem = raw.trim();
  if (pem.includes('BEGIN')) return pem;
  return `-----BEGIN PRIVATE KEY-----\n${pem.replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;
}

/**
 * @param {{ issuerId: string, keyId: string, privateKey: string }} cfg
 * @returns {(path: string, opts?: RequestInit) => Promise<any>}
 */
export function createAscClient({ issuerId, keyId, privateKey }) {
  const pem = normalizePem(privateKey);

  const makeJWT = () => {
    const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.sign('SHA256', Buffer.from(input), { key: pem, dsaEncoding: 'ieee-p1363' });
    return `${input}.${b64url(sig)}`;
  };

  return async function api(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${makeJWT()}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
