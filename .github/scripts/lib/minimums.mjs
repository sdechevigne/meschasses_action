// Règles des versions minimales (spec monorepo 2026-10-21 Expo 58 §L6) : aucun appareil ne doit perdre l'app.
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function parseExtensions(spec) {
  return Object.fromEntries(String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split('=').map((x) => x.trim())));
}

export function checkIos({ app, frameworks, extensions }, { minimum, extensions: autorisees }) {
  const erreurs = [];
  if (compareVersions(app.min, minimum) !== 0) {
    erreurs.push(`${app.name} : MinimumOSVersion ${app.min}, attendu ${minimum}`);
  }
  for (const f of frameworks) {
    if (f.min && compareVersions(f.min, minimum) > 0) erreurs.push(`${f.name} exige iOS ${f.min} (> ${minimum})`);
  }
  for (const e of extensions) {
    if (!e.min) continue;
    const plafond = autorisees[e.name] ?? minimum;
    if (compareVersions(e.min, plafond) > 0) erreurs.push(`${e.name} exige iOS ${e.min} (autorisé : ${plafond})`);
  }
  return erreurs;
}

export function checkAndroid(minSdk, attendu) {
  return minSdk === attendu ? [] : [`minSdkVersion ${minSdk}, attendu ${attendu}`];
}
