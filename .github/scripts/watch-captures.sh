#!/usr/bin/env bash
# .github/scripts/watch-captures.sh — Tâche 11
#
# Prend des captures de l'app montre (4 tailles × 2 langues × N fixtures DemoMode)
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
# (40 mm, 41 mm, 45 mm, Ultra 49 mm). Les devices « captures-* » sont créés à la
# volée s'ils n'existent pas déjà, puis supprimés en fin de run.
#
# La permission de localisation est accordée AVANT le premier launch de l'app
# (via `xcrun simctl privacy grant location`) pour éviter l'alerte système
# « Allow to use your location? » qui masquait 4 écrans sur 10.
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
# 2) Choix des 4 device types (40 mm / 41 mm / 45 mm / Ultra 49 mm).
#    Le 40 mm est la plus petite montre (162 pt de large) et sert à vérifier
#    la règle anti-troncature.
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

# 40 mm = Series 4/5/6/SE (1re gen) 40mm — le plus petit écran (162 pt)
TYPE_40=$(pick_device_type '40mm')
TYPE_41=$(pick_device_type '41mm')
TYPE_45=$(pick_device_type '45mm')
TYPE_49=$(pick_device_type 'Ultra.*49mm|49mm.*Ultra|49mm')

[[ -z "$TYPE_40" ]] && TYPE_40=$(pick_device_type 'SE.*40mm|Series.*4.*40|Series.*5.*40|Series.*6.*40')
[[ -z "$TYPE_41" ]] && TYPE_41=$(pick_device_type 'Series.*7|Series.*8|Series.*9|Series.*10|Series 10|SE.*44mm')
[[ -z "$TYPE_45" ]] && TYPE_45=$(pick_device_type 'Series.*10|Series 10|Series.*9|Series.*8|Series.*7|44mm')
[[ -z "$TYPE_49" ]] && TYPE_49=$(pick_device_type 'Ultra')

echo "Device type 40 mm = ${TYPE_40:-(aucun)}"
echo "Device type 41 mm = ${TYPE_41:-(aucun)}"
echo "Device type 45 mm = ${TYPE_45:-(aucun)}"
echo "Device type 49 mm Ultra = ${TYPE_49:-(aucun)}"

# Au moins 3 tailles obligatoires (40 mm peut manquer sur certains runners)
SIZES_FOUND=0
[[ -n "$TYPE_40" ]] && SIZES_FOUND=$((SIZES_FOUND+1))
[[ -n "$TYPE_41" ]] && SIZES_FOUND=$((SIZES_FOUND+1))
[[ -n "$TYPE_45" ]] && SIZES_FOUND=$((SIZES_FOUND+1))
[[ -n "$TYPE_49" ]] && SIZES_FOUND=$((SIZES_FOUND+1))

if [[ "$SIZES_FOUND" -lt 3 ]]; then
  echo "::error::Moins de 3 device types watchOS disponibles (trouvés: $SIZES_FOUND)."
  exit 1
fi

# Avertissement si le 40 mm manque (vérification anti-troncature moins fiable)
if [[ -z "$TYPE_40" ]]; then
  echo "::warning::Device type 40 mm non disponible — vérification anti-troncature sur 41 mm seulement"
fi

# ---------------------------------------------------------------------------
# 3) Création des 4 devices (si pas déjà présents).
# ---------------------------------------------------------------------------
NAME_40="captures-40mm"
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

UDID_40=""
[[ -n "$TYPE_40" ]] && UDID_40=$(create_or_reuse "$NAME_40" "$TYPE_40" "$WATCH_RUNTIME")
UDID_41=$(create_or_reuse "$NAME_41" "$TYPE_41" "$WATCH_RUNTIME")
UDID_45=$(create_or_reuse "$NAME_45" "$TYPE_45" "$WATCH_RUNTIME")
UDID_49=$(create_or_reuse "$NAME_49" "$TYPE_49" "$WATCH_RUNTIME")

echo "UDID 40mm = ${UDID_40:-(non créé)}"
echo "UDID 41mm = $UDID_41"
echo "UDID 45mm = $UDID_45"
echo "UDID 49mm = $UDID_49"

cleanup() {
  for u in "$UDID_40" "$UDID_41" "$UDID_45" "$UDID_49"; do
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
# Timeout de bootstatus en secondes. Correctif revue : avant on prétendait un
# timeout de 180 s qui n'existait pas (`-b` seul attend indéfiniment). Comme
# macOS n'a pas `timeout`, on lance `bootstatus` en arrière-plan et on
# surveille son PID jusqu'à `BOOTSTATUS_TIMEOUT`.
BOOTSTATUS_TIMEOUT="${BOOTSTATUS_TIMEOUT:-180}"

boot_device() {
  local udid="$1"
  for attempt in 1 2 3; do
    xcrun simctl shutdown "$udid" 2>/dev/null || true
    sleep 1
    xcrun simctl boot "$udid" 2>/dev/null || true

    # bootstatus -b attend la fin du boot sans borne native. On le lance en
    # arrière-plan et on l'arrête de force au bout de BOOTSTATUS_TIMEOUT s.
    local statfile="/tmp/bootstatus.$$.$attempt"
    xcrun simctl bootstatus "$udid" -b >"$statfile" 2>&1 &
    local bs_pid=$!
    local waited=0
    while kill -0 "$bs_pid" 2>/dev/null; do
      if (( waited >= BOOTSTATUS_TIMEOUT )); then
        echo "  ⏱️ bootstatus > ${BOOTSTATUS_TIMEOUT}s, kill $bs_pid"
        kill -9 "$bs_pid" 2>/dev/null || true
        break
      fi
      sleep 2; waited=$(( waited + 2 ))
    done
    wait "$bs_pid" 2>/dev/null || true
    cat "$statfile"
    rm -f "$statfile"

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
      return 0
    fi
    echo "  reboot (tentative $attempt/3)…"
    sleep 2
  done
  echo "::error::device $udid refuse de booter après 3 tentatives"
  return 1
}

# ---------------------------------------------------------------------------
# 4) Captures : 4 tailles × 2 langues × N écrans. L'app lit `-screen <nom>`
#    (DemoMode.swift) et monte directement l'écran voulu.
#
#    Scénarios de base (10 par taille × langue) :
#       - home   : les 5 fixtures (empty, oneHunt, noCoordinates, card, signedOut)
#       - hunt   : oneHunt
#       - post   : oneHunt, noCoordinates
#       - card   : card
#       - permit : oneHunt
#
#    Scénarios « textes longs » (fixture `longTexts`, 7 par taille × langue) :
#       - home, hunt, post : noms de territoire/traque/poste longs
#       - battue2TraqueOn : bandeau « DRIVE 12 IN PROGRESS », dernier signalement long
#       - signalPlanLine : choix de ligne de plan avec libellés longs
#       - card : carte de membre avec numéro long
#       - horns : sonneries avec lignes longues (si espèces multiples)
#
#    Nom : <taille>-<langue>-<démo>-<écran>.png
# ---------------------------------------------------------------------------
# Liste explicite (démo, écran) — simple et lisible.
PAIRS=(
  # Scénarios de base
  "empty home"
  "oneHunt home"
  "noCoordinates home"
  "card home"
  "signedOut home"
  "oneHunt hunt"
  "oneHunt post"
  "noCoordinates post"
  "card card"
  "oneHunt permit"
  # Scénarios « textes longs » pour vérifier la règle anti-troncature
  "longTexts home"
  "longTexts hunt"
  "longTexts post"
  "longTexts battue2TraqueOn"
  "longTexts signalPlanLine"
  "longTexts card"
  "longTexts horns"
)
LANGS=(fr en)

# Un `simctl install` peut planter en `ipc/mig server died` (code -308,
# NSMachErrorDomain) quand le démon CoreSimulatorService meurt — ça laisse
# ensuite les devices suivants dans un état où `simctl boot` échoue avec
# « cannot determine the runtime bundle » (vécu run 40716075617 : 45 mm et
# 49 mm perdus en cascade). On force alors un redémarrage du service et on
# retente une fois avec un boot propre.
restart_core_simulator() {
  echo "  🔄 restart CoreSimulatorService (après -308)…"
  xcrun simctl shutdown all 2>/dev/null || true
  killall -9 Simulator 2>/dev/null || true
  # pkill nécessite sudo pour tuer un daemon root ; sur runner GH Actions,
  # sudo passe sans mot de passe.
  sudo pkill -9 -f com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
  sleep 5
  # Un simctl inoffensif pour forcer launchd à relancer le service.
  xcrun simctl list devices >/dev/null 2>&1 || true
  sleep 2
}

shoot_device() {
  local udid="$1"
  local size_label="$2"

  echo
  echo "### Simulateur $size_label ($udid)"

  # Shutdown de tout avant de démarrer ce device : évite une fuite de
  # ressources du device précédent et donne au CoreSimulatorService une
  # pause propre.
  xcrun simctl shutdown all 2>/dev/null || true
  sleep 2

  if ! boot_device "$udid"; then
    echo "::error::simulateur $size_label indisponible — captures de ce device ignorées"
    return 0
  fi

  if ! xcrun simctl install "$udid" "$WATCH_APP_PATH"; then
    echo "::warning::simctl install KO pour $size_label — restart CoreSimulatorService + retry"
    restart_core_simulator
    if ! boot_device "$udid"; then
      echo "::error::reboot post-restart impossible — captures de $size_label ignorées"
      return 0
    fi
    if ! xcrun simctl install "$udid" "$WATCH_APP_PATH"; then
      echo "::error::simctl install KO deux fois pour $size_label — captures ignorées"
      return 0
    fi
  fi

  # Accorder la permission de localisation AVANT le premier launch.
  # Évite l'alerte système « Allow "MesChassesWatch" to use your location? »
  # qui masquait 4 écrans sur 10 (card-card, noCoordinates-post, oneHunt-permit, oneHunt-post).
  echo "  Accord de la permission de localisation..."
  xcrun simctl privacy "$udid" grant location "$BUNDLE_ID" 2>/dev/null || {
    echo "::warning::privacy grant location a échoué pour $size_label"
  }

  for lang in "${LANGS[@]}"; do
    for pair in "${PAIRS[@]}"; do
      local demo="${pair% *}"
      local screen="${pair#* }"
      local out="$OUTDIR/${size_label}-${lang}-${demo}-${screen}.png"
      echo "  → $out"

      xcrun simctl terminate "$udid" "$BUNDLE_ID" 2>/dev/null || true

      if ! xcrun simctl launch "$udid" "$BUNDLE_ID" \
            -demo "$demo" \
            -screen "$screen" \
            -AppleLanguages "($lang)" \
            -AppleLocale "${lang}_FR" 2>/tmp/launch.err >/dev/null; then
        echo "    launch.err :"
        sed 's/^/      /' /tmp/launch.err || true
        if grep -q "server died\|code=-308\|cannot determine the runtime" /tmp/launch.err 2>/dev/null; then
          echo "::warning::CoreSimulatorService mort pendant la série — restart"
          restart_core_simulator
          boot_device "$udid" || { echo "::error::reboot impossible, abandon $size_label"; return 0; }
          xcrun simctl install "$udid" "$WATCH_APP_PATH" || true
          # Rejoue CETTE capture
          xcrun simctl launch "$udid" "$BUNDLE_ID" -demo "$demo" -screen "$screen" \
            -AppleLanguages "($lang)" -AppleLocale "${lang}_FR" >/dev/null 2>&1 || {
            echo "::warning::launch échoue encore pour $out après restart"; continue;
          }
        else
          echo "::warning::launch a échoué pour $out — capture ignorée"
          continue
        fi
      fi

      sleep "$WAIT_SECONDS"

      if ! xcrun simctl io "$udid" screenshot "$out" 2>/dev/null; then
        echo "::warning::screenshot a échoué pour $out"
        continue
      fi
    done
  done
}

[[ -n "$UDID_40" ]] && shoot_device "$UDID_40" "40mm"
shoot_device "$UDID_41" "41mm"
shoot_device "$UDID_45" "45mm"
shoot_device "$UDID_49" "49mm-ultra"

# ---------------------------------------------------------------------------
# 5) Vérification finale : N captures (selon les tailles disponibles), puis contrôle d'empreintes.
#
# Une capture peut être « présente et de taille normale » tout en montrant
# la mauvaise chose : crash juste après launch (cadran noir), fallback
# silencieux de `DemoRootView` quand l'élément manque (round 1 : retombait
# sur l'accueil), traduction manquante (EN == FR). On attrape ces trois cas
# par comparaison de SHA256 :
#   • écran `hunt`/`post`/`card`/`permit`/etc. identique à `home` même démo /
#     taille / langue → la capture détail est en fait l'accueil.
#   • `fr` identique à `en` même écran / démo / taille → l'EN n'est pas
#     réellement affiché (ou l'écran n'a aucun texte localisé — toléré
#     uniquement pour `card`/`permit` sans texte localisable, voir
#     exceptions ci-dessous).
#   • taille < 1 Ko → ::error::.
# ---------------------------------------------------------------------------

# Construire la liste des tailles effectivement capturées
SIZES_CAPTURED=()
[[ -n "$UDID_40" ]] && SIZES_CAPTURED+=("40mm")
SIZES_CAPTURED+=("41mm" "45mm" "49mm-ultra")

EXPECTED_COUNT=$(( ${#SIZES_CAPTURED[@]} * ${#LANGS[@]} * ${#PAIRS[@]} ))
echo
echo "## Vérification des $EXPECTED_COUNT captures (${#SIZES_CAPTURED[@]} tailles × ${#LANGS[@]} langues × ${#PAIRS[@]} écrans)"
missing=0
too_small=0
for size in "${SIZES_CAPTURED[@]}"; do
  for lang in "${LANGS[@]}"; do
    for pair in "${PAIRS[@]}"; do
      demo="${pair% *}"
      screen="${pair#* }"
      f="$OUTDIR/${size}-${lang}-${demo}-${screen}.png"
      if [[ ! -s "$f" ]]; then
        echo "::error::capture manquante ou vide : $f"
        missing=$((missing+1))
        continue
      fi
      sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
      if [[ "$sz" -lt 1024 ]]; then
        echo "::error::capture $f suspecte ($sz octets)"
        too_small=$((too_small+1))
      fi
    done
  done
done

ls -la "$OUTDIR" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

# Pré-calcul des SHA256.
sha_of() {
  shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
}

echo
echo "## Contrôle d'empreintes (SHA256)"
dup_home=0
dup_i18n=0

for size in "${SIZES_CAPTURED[@]}"; do
  for lang in "${LANGS[@]}"; do
    # (a) écran détail != home de la même démo / taille / langue.
    # Exclure les écrans qui n'ont pas de fixture home correspondante.
    for pair in "${PAIRS[@]}"; do
      demo="${pair% *}"
      screen="${pair#* }"
      [[ "$screen" == "home" ]] && continue
      # Les écrans de la fixture longTexts qui n'ont pas de home correspondant
      # (battue2TraqueOn, signalPlanLine, horns) ne peuvent pas être comparés à home
      f="$OUTDIR/${size}-${lang}-${demo}-${screen}.png"
      href="$OUTDIR/${size}-${lang}-${demo}-home.png"
      [[ -s "$f" && -s "$href" ]] || continue
      sh_f=$(sha_of "$f"); sh_h=$(sha_of "$href")
      if [[ "$sh_f" == "$sh_h" ]]; then
        echo "::error::$f identique à $href (fallback silencieux ou crash → accueil)"
        dup_home=$((dup_home+1))
      fi
    done
  done

  # (b) fr != en même écran / démo / taille.
  # Exception : la carte de membre et le QR permit n'ont PAS de texte
  # localisé significatif — un fr == en y est acceptable. On exempte
  # donc l'écran `card` du contrôle i18n. Pour `permit`, le libellé vient
  # du snapshot (déjà traduit par le monorepo), donc on exempte aussi.
  # Les écrans de signalement (signalPlanLine) sont exemptés aussi car les
  # libellés viennent du snapshot.
  for pair in "${PAIRS[@]}"; do
    demo="${pair% *}"
    screen="${pair#* }"
    [[ "$screen" == "card" || "$screen" == "permit" || "$screen" == "signalPlanLine" ]] && continue
    f_fr="$OUTDIR/${size}-fr-${demo}-${screen}.png"
    f_en="$OUTDIR/${size}-en-${demo}-${screen}.png"
    [[ -s "$f_fr" && -s "$f_en" ]] || continue
    if [[ "$(sha_of "$f_fr")" == "$(sha_of "$f_en")" ]]; then
      echo "::error::$f_fr == $f_en (traduction EN non appliquée)"
      dup_i18n=$((dup_i18n+1))
    fi
  done
done

echo "Doublons détail=home : $dup_home"
echo "Doublons fr=en      : $dup_i18n"

if [[ "$missing" -gt 0 || "$too_small" -gt 0 || "$dup_home" -gt 0 || "$dup_i18n" -gt 0 ]]; then
  echo "::error::échec contrôle captures (manquantes=$missing, suspectes=$too_small, détail=home=$dup_home, fr=en=$dup_i18n)"
  exit 1
fi

echo "## $EXPECTED_COUNT captures OK dans $OUTDIR"
