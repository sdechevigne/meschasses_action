#!/usr/bin/env bash
# .github/scripts/watch-captures.sh — Tâche 11
#
# Prend 30 captures de l'app montre (3 tailles × 2 langues × 5 fixtures DemoMode)
# sur un runner macOS avec Xcode installé, et pose les PNG dans `$OUTDIR`
# (par défaut `watch-captures/`).
#
# Pré-requis dans l'env du job :
#   - WATCH_APP_PATH : chemin absolu vers le .app watchOS Debug déjà bâti
#     (ex. $PWD/build-app/Debug-watchsimulator/MesChassesWatch.app)
#   - OUTDIR (optionnel, défaut: watch-captures)
#
# Le script découvre le runtime watchOS disponible via `xcrun simctl list`,
# et pour chaque taille utilise le device type exact présent sur le runner
# (41 mm, 45 mm, Ultra 49 mm). Les devices « captures-* » sont créés à la
# volée s'ils n'existent pas déjà, puis supprimés en fin de run.
#
# Mode démo : l'app lit `-demo <fixture>` dans ses launch arguments
# (apps/mobile/targets/watch/Views/DemoMode.swift) et NE DÉMARRE PAS
# WatchConnectivity — l'écran est prévisible.

set -uo pipefail

: "${WATCH_APP_PATH:?variable WATCH_APP_PATH manquante — chemin vers MesChassesWatch.app}"
OUTDIR="${OUTDIR:-watch-captures}"
BUNDLE_ID="com.meschasses.watchkitapp"
WAIT_SECONDS="${WAIT_SECONDS:-4}"

if [[ ! -d "$WATCH_APP_PATH" ]]; then
  echo "::error::WATCH_APP_PATH introuvable : $WATCH_APP_PATH"
  exit 1
fi

mkdir -p "$OUTDIR"

echo "## Préparation du simulateur watchOS"
echo "WATCH_APP_PATH=$WATCH_APP_PATH"
echo "OUTDIR=$OUTDIR"

# ---------------------------------------------------------------------------
# 1) Détection du runtime watchOS disponible (le plus récent).
# ---------------------------------------------------------------------------
WATCH_RUNTIME=$(xcrun simctl list runtimes watchOS -j | \
  node -e '(() => {
    const r = JSON.parse(require("fs").readFileSync(0,"utf8")).runtimes || [];
    const avail = r.filter(x => x.isAvailable !== false);
    if (avail.length === 0) { process.exit(2); }
    avail.sort((a,b) => (b.version||"").localeCompare(a.version||"", undefined, {numeric:true}));
    process.stdout.write(avail[0].identifier);
  })()' || true)

if [[ -z "$WATCH_RUNTIME" ]]; then
  echo "::error::Aucun runtime watchOS disponible sur le runner."
  xcrun simctl list runtimes >&2
  exit 1
fi
echo "Runtime watchOS retenu : $WATCH_RUNTIME"

# ---------------------------------------------------------------------------
# 2) Choix des 3 device types (41 mm / 45 mm / Ultra 49 mm).
# ---------------------------------------------------------------------------
ALL_WATCH_TYPES=$(xcrun simctl list devicetypes -j | \
  node -e '(() => {
    const d = JSON.parse(require("fs").readFileSync(0,"utf8")).devicetypes || [];
    const w = d.filter(x => (x.productFamily||"").toLowerCase().includes("watch") ||
                            (x.identifier||"").includes("Apple-Watch"));
    for (const t of w) {
      process.stdout.write(`${t.identifier}\t${t.name}\n`);
    }
  })()')

echo "Device types watchOS disponibles :"
echo "$ALL_WATCH_TYPES" | sed "s/^/  /"

pick_device_type() {
  echo "$ALL_WATCH_TYPES" | awk -F'\t' -v pat="$1" '
    tolower($0) ~ tolower(pat) { print $1; exit }
  '
}

TYPE_41=$(pick_device_type '41mm')
TYPE_45=$(pick_device_type '45mm')
TYPE_49=$(pick_device_type 'Ultra.*49mm|49mm.*Ultra|49mm')

[[ -z "$TYPE_41" ]] && TYPE_41=$(pick_device_type 'Series.*7|Series.*8|Series.*9|Series.*10|Series 10|SE.*44mm|40mm')
[[ -z "$TYPE_45" ]] && TYPE_45=$(pick_device_type 'Series.*10|Series 10|Series.*9|Series.*8|Series.*7|44mm')
[[ -z "$TYPE_49" ]] && TYPE_49=$(pick_device_type 'Ultra')

echo "Device type 41 mm = ${TYPE_41:-(aucun)}"
echo "Device type 45 mm = ${TYPE_45:-(aucun)}"
echo "Device type 49 mm Ultra = ${TYPE_49:-(aucun)}"

if [[ -z "$TYPE_41" || -z "$TYPE_45" || -z "$TYPE_49" ]]; then
  echo "::error::Au moins un device type watchOS attendu est absent du runner."
  exit 1
fi

# ---------------------------------------------------------------------------
# 3) Création des 3 devices (si pas déjà présents).
# ---------------------------------------------------------------------------
NAME_41="captures-41mm"
NAME_45="captures-45mm"
NAME_49="captures-49mm-ultra"

existing_device_udid() {
  xcrun simctl list devices -j | \
    node -e '(() => {
      const n = process.argv[1];
      const t = process.argv[2];
      const d = JSON.parse(require("fs").readFileSync(0,"utf8")).devices || {};
      for (const k of Object.keys(d)) {
        for (const dev of d[k]) {
          if (dev.name === n && (dev.deviceTypeIdentifier === t || k.endsWith(t))) {
            process.stdout.write(dev.udid);
            return;
          }
        }
      }
    })()' "$1" "$2"
}

create_or_reuse() {
  local existing
  existing=$(existing_device_udid "$1" "$2" || true)
  if [[ -n "$existing" ]]; then
    echo "$existing"
    return
  fi
  xcrun simctl create "$1" "$2" "$3"
}

UDID_41=$(create_or_reuse "$NAME_41" "$TYPE_41" "$WATCH_RUNTIME")
UDID_45=$(create_or_reuse "$NAME_45" "$TYPE_45" "$WATCH_RUNTIME")
UDID_49=$(create_or_reuse "$NAME_49" "$TYPE_49" "$WATCH_RUNTIME")

echo "UDID 41mm = $UDID_41"
echo "UDID 45mm = $UDID_45"
echo "UDID 49mm = $UDID_49"

cleanup() {
  for u in "$UDID_41" "$UDID_45" "$UDID_49"; do
    [[ -z "$u" ]] && continue
    xcrun simctl shutdown "$u" 2>/dev/null || true
    xcrun simctl delete "$u" 2>/dev/null || true
  done
}
trap cleanup EXIT

# Robust boot : certains device types (notamment Ultra 49 mm sur les runners
# `xcode-27`) voient `simctl bootstatus` revenir aussitôt avec un statut -1
# (`4294967295`) sans que le device soit réellement booté — install échoue
# derrière avec « Unable to lookup in current state: Shutdown ». On force
# alors un shutdown propre et on retente le boot, jusqu'à 3 fois.
boot_device() {
  local udid="$1"
  for attempt in 1 2 3; do
    xcrun simctl shutdown "$udid" 2>/dev/null || true
    sleep 1
    xcrun simctl boot "$udid" 2>/dev/null || true
    # Attend la fin du boot, bornée à 180 s via timeout extérieur (bootstatus -b).
    xcrun simctl bootstatus "$udid" -b >/tmp/bootstatus.$$ 2>&1 || true
    cat /tmp/bootstatus.$$
    # Confirme l'état réel : la ligne de state dans `simctl list devices`.
    local state
    state=$(xcrun simctl list devices -j | \
      node -e '(() => {
        const u = process.argv[1];
        const d = JSON.parse(require("fs").readFileSync(0,"utf8")).devices || {};
        for (const k of Object.keys(d)) for (const dev of d[k]) if (dev.udid === u) { process.stdout.write(dev.state||""); return; }
      })()' "$udid" || true)
    echo "  state après tentative $attempt = $state"
    if [[ "$state" == "Booted" ]]; then
      rm -f /tmp/bootstatus.$$
      return 0
    fi
    echo "  reboot (tentative $attempt/3)…"
    sleep 2
  done
  rm -f /tmp/bootstatus.$$
  echo "::error::device $udid refuse de booter après 3 tentatives"
  return 1
}

# ---------------------------------------------------------------------------
# 4) Boucle 3 × 2 × 5 — 30 captures. Un échec sur un device ne tue PAS les
#    autres : on continue, et on sort en code 1 si au moins une capture manque.
# ---------------------------------------------------------------------------
DEMOS=(empty oneHunt noCoordinates card signedOut)
LANGS=(fr en)

shoot_device() {
  local udid="$1"
  local size_label="$2"

  echo
  echo "### Simulateur $size_label ($udid)"

  if ! boot_device "$udid"; then
    echo "::error::simulateur $size_label indisponible — captures de ce device ignorées"
    return 0
  fi

  if ! xcrun simctl install "$udid" "$WATCH_APP_PATH"; then
    echo "::error::simctl install a échoué pour $size_label — captures ignorées"
    return 0
  fi

  for lang in "${LANGS[@]}"; do
    for demo in "${DEMOS[@]}"; do
      local out="$OUTDIR/${size_label}-${lang}-${demo}.png"
      echo "  → $out"

      xcrun simctl terminate "$udid" "$BUNDLE_ID" 2>/dev/null || true

      if ! xcrun simctl launch "$udid" "$BUNDLE_ID" \
            -demo "$demo" \
            -AppleLanguages "($lang)" \
            -AppleLocale "${lang}_FR" >/dev/null; then
        echo "::warning::launch a échoué pour $out — capture ignorée"
        continue
      fi

      sleep "$WAIT_SECONDS"

      if ! xcrun simctl io "$udid" screenshot "$out" 2>/dev/null; then
        echo "::warning::screenshot a échoué pour $out"
        continue
      fi
    done
  done
}

shoot_device "$UDID_41" "41mm"
shoot_device "$UDID_45" "45mm"
shoot_device "$UDID_49" "49mm-ultra"

# ---------------------------------------------------------------------------
# 5) Vérification finale.
# ---------------------------------------------------------------------------
echo
echo "## Vérification des 30 captures"
missing=0
for size in 41mm 45mm 49mm-ultra; do
  for lang in "${LANGS[@]}"; do
    for demo in "${DEMOS[@]}"; do
      f="$OUTDIR/${size}-${lang}-${demo}.png"
      if [[ ! -s "$f" ]]; then
        echo "::error::capture manquante ou vide : $f"
        missing=$((missing+1))
        continue
      fi
      sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
      if [[ "$sz" -lt 1024 ]]; then
        echo "::warning::capture $f suspecte ($sz octets)"
      fi
    done
  done
done

ls -la "$OUTDIR" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [[ "$missing" -gt 0 ]]; then
  echo "::error::$missing capture(s) manquante(s)"
  exit 1
fi

echo "## 30 captures OK dans $OUTDIR"
