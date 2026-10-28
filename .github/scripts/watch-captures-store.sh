#!/usr/bin/env bash
# .github/scripts/watch-captures-store.sh
#
# Captures vitrine de l'app montre « Mes Chasses » pour la fiche App Store
# (téléchargées en artifact, PAS envoyées à App Store Connect — la montre
# n'est pas encore dans les builds TestFlight/store, décision produit).
#
# Pour chaque taille de montre disponible sur le runner (Ultra 49 mm,
# Series 46 mm, Series 45 mm, Series 41/42 mm — on prend celles présentes),
# pour chaque langue (fr, en), prend 5 captures de la fixture `store` :
#   01 home            — liste des chasses à venir (boussole : chasses d'abord)
#   02 hunt            — détail de la chasse (en-tête, statut Présent/Absent)
#   03 post            — poste 1, avec la FLÈCHE de guidage et la DISTANCE
#                        (le simulateur est positionné à ~150 m du poste)
#   04 card            — carte de membre avec QR scannable
#   05 permit          — permis validé
#
# L'écran `hunt-scrolled` n'est PAS pris : watchOS n'expose pas de verbe
# `simctl` pour scroller la Digital Crown et l'app watch monte directement
# le détail avec la zone Présent/Absent visible — un deuxième cliché serait
# un doublon.
#
# Pré-requis dans l'env :
#   - WATCH_APP_PATH : chemin absolu vers MesChassesWatch.app Debug déjà bâti.
#   - OUTDIR (défaut : watch-captures-store)
#
# Le script s'inspire fortement du script `watch-captures.sh` existant (même
# détection runtime, même robust boot, même restart CoreSimulatorService
# après -308) — fusionner serait possible plus tard, pour l'instant on garde
# les deux séparés pour ne RIEN changer au comportement du contrôle de
# non-régression (watch-tests.yml).

set -uo pipefail

: "${WATCH_APP_PATH:?variable WATCH_APP_PATH manquante — chemin vers MesChassesWatch.app}"
OUTDIR="${OUTDIR:-watch-captures-store}"
BUNDLE_ID="com.meschasses.watchkitapp"
WAIT_SECONDS="${WAIT_SECONDS:-5}"
# Attente supplémentaire après `simctl location set` pour que CoreLocation
# propage la position avant la capture `post`.
LOCATION_SETTLE_SECONDS="${LOCATION_SETTLE_SECONDS:-6}"

if [[ ! -d "$WATCH_APP_PATH" ]]; then
  echo "::error::WATCH_APP_PATH introuvable : $WATCH_APP_PATH"
  exit 1
fi

mkdir -p "$OUTDIR"

echo "## Préparation du simulateur watchOS (captures App Store)"
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
# 2) Liste des device types watchOS disponibles. On essaie, dans l'ordre :
#    - Ultra 49 mm (le plus grand, retenu par App Store Connect)
#    - Series 46 mm (10/11 « grand »)
#    - Series 45 mm (série 7-9)
#    - Series 41/42 mm (série 7-9 petit)
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

TYPE_49=$(pick_device_type 'Ultra.*49mm|49mm.*Ultra|49mm')
TYPE_46=$(pick_device_type '46mm')
TYPE_45=$(pick_device_type '45mm')
TYPE_41=$(pick_device_type '41mm')
TYPE_42=$(pick_device_type '42mm')

# Replis si une taille absente : on prend la plus proche.
[[ -z "$TYPE_49" ]] && TYPE_49=$(pick_device_type 'Ultra')
[[ -z "$TYPE_41" ]] && TYPE_41="$TYPE_42"

echo "Device type Ultra 49 mm = ${TYPE_49:-(aucun)}"
echo "Device type Series 46 mm = ${TYPE_46:-(aucun)}"
echo "Device type Series 45 mm = ${TYPE_45:-(aucun)}"
echo "Device type Series 41/42 mm = ${TYPE_41:-(aucun)}"

# Pool des tailles à capturer. On ne CRÉE PAS encore les devices : chaque
# device est créé juste avant son tour, et détruit après sa série. C'est le
# seul moyen fiable d'éviter que `CoreSimulatorService` reparte sans
# retrouver le runtime bundle de devices créés avant son redémarrage (vécu
# runs 40755759111 + 40758454581 : les devices créés avant le 1er restart
# refusent de booter après — « cannot determine the runtime bundle »).
POOL=()  # paires "label:type_id" — type_id peut être vide, on skip alors
POOL+=("49mm-ultra:$TYPE_49")
POOL+=("46mm:$TYPE_46")
POOL+=("45mm:$TYPE_45")
POOL+=("41mm:$TYPE_41")

# Trace des devices à nettoyer en sortie (ceux qu'on a créés et pas encore
# supprimés — en pratique au plus 1 à la fois).
CREATED_UDIDS=()

cleanup() {
  for u in "${CREATED_UDIDS[@]}"; do
    [[ -z "$u" ]] && continue
    xcrun simctl shutdown "$u" 2>/dev/null || true
    xcrun simctl delete "$u" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 3) Boot robuste (repris de watch-captures.sh : bootstatus borné à 180 s,
#    retry après -308, restart CoreSimulatorService si besoin).
# ---------------------------------------------------------------------------
BOOTSTATUS_TIMEOUT="${BOOTSTATUS_TIMEOUT:-180}"

boot_device() {
  local udid="$1"
  for attempt in 1 2 3; do
    xcrun simctl shutdown "$udid" 2>/dev/null || true
    sleep 1
    xcrun simctl boot "$udid" >/tmp/boot.err 2>&1 || true
    # On loggue la sortie de boot pour garder la traçabilité qu'avait le
    # pipeline direct précédent (`xcrun simctl boot "$udid" 2>&1`).
    [[ -s /tmp/boot.err ]] && sed 's/^/    /' /tmp/boot.err

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
    # Si le boot a échoué sur « cannot determine the runtime bundle » (ou
    # un équivalent -308), le CoreSimulatorService est en vrac — redémarrer
    # avant la prochaine tentative. Sinon, simple reboot.
    if grep -q "cannot determine the runtime\|server died\|code=-308\|runtime bundle" /tmp/boot.err 2>/dev/null; then
      echo "  CoreSimulatorService semble mort pendant le boot — restart avant retry"
      restart_core_simulator
    fi
    echo "  reboot (tentative $attempt/3)…"
    sleep 2
  done
  echo "::error::device $udid refuse de booter après 3 tentatives"
  return 1
}

restart_core_simulator() {
  echo "  🔄 restart CoreSimulatorService (après -308)…"
  xcrun simctl shutdown all 2>/dev/null || true
  killall -9 Simulator 2>/dev/null || true
  sudo pkill -9 -f com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
  sleep 5
  xcrun simctl list devices >/dev/null 2>&1 || true
  sleep 2
}

# ---------------------------------------------------------------------------
# 4) Matrice de captures.
#    6 écrans par (device × langue), tous sur la fixture `store`.
#    L'ordre numérique guide la lecture dans l'artifact et App Store Connect.
# ---------------------------------------------------------------------------
# Format : "numéro écran [extra]" — `extra` peut être `located`.
SHOTS=(
  "01 home"
  "02 hunt"
  "03 post located"
  "04 card"
  "05 permit"
)
LANGS=(fr en)

# Coordonnées du 1er poste de la fixture `store` (voir DemoMode.swift) :
# 47.2180, -1.5530. Position du simulateur ~150 m plus au nord-est :
# +0.0012° lat ≈ 133 m, +0.0005° lng ≈ 38 m → distance ≈ 138 m.
POST_LAT="47.2180"
POST_LNG="-1.5530"
SIM_LAT="47.2192"
SIM_LNG="-1.5525"

# ---------------------------------------------------------------------------
# 5) Capture d'un device.
# ---------------------------------------------------------------------------
shoot_device() {
  local udid="$1"
  local size_label="$2"

  echo
  echo "### Simulateur $size_label ($udid)"

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

  # Autorisation location pour l'écran `post` (grant une seule fois, suffisant
  # pour toute la série : la permission reste tant que le device vit).
  if xcrun simctl privacy "$udid" grant location "$BUNDLE_ID" 2>/tmp/privacy.err; then
    echo "  Location grant OK"
  else
    echo "  ⚠️ Location grant a échoué (ignoré) :"
    sed 's/^/    /' /tmp/privacy.err || true
  fi

  # Essai status bar override (9:41) — non supporté sur watchOS, on log.
  if xcrun simctl status_bar "$udid" override --time "9:41" 2>/tmp/sb.err; then
    echo "  status_bar override 9:41 OK"
  else
    echo "  ⚠️ status_bar override non supporté sur watchOS (ignoré) :"
    sed 's/^/    /' /tmp/sb.err || true
  fi

  for lang in "${LANGS[@]}"; do
    for shot in "${SHOTS[@]}"; do
      # shot = "nn screen [extra]"
      read -r shot_num shot_screen shot_extra <<<"$shot"
      shot_extra="${shot_extra:-}"
      local out="$OUTDIR/${size_label}-${lang}-${shot_num}-${shot_screen}.png"
      echo "  → $out (extra=${shot_extra:-none})"

      xcrun simctl terminate "$udid" "$BUNDLE_ID" 2>/dev/null || true

      # Si l'écran demande la location, on la pose AVANT le lancement et on
      # attend que CoreLocation ait propagé.
      if [[ "$shot_extra" == "located" ]]; then
        xcrun simctl location "$udid" set "$SIM_LAT,$SIM_LNG" 2>/dev/null || \
          echo "  ⚠️ simctl location set a échoué (continué quand même)"
      fi

      if ! xcrun simctl launch "$udid" "$BUNDLE_ID" \
            -demo "store" \
            -screen "$shot_screen" \
            -AppleLanguages "($lang)" \
            -AppleLocale "${lang}_FR" 2>/tmp/launch.err >/dev/null; then
        echo "    launch.err :"
        sed 's/^/      /' /tmp/launch.err || true
        if grep -q "server died\|code=-308\|cannot determine the runtime" /tmp/launch.err 2>/dev/null; then
          echo "::warning::CoreSimulatorService mort — restart"
          restart_core_simulator
          boot_device "$udid" || { echo "::error::reboot impossible, abandon $size_label"; return 0; }
          xcrun simctl install "$udid" "$WATCH_APP_PATH" || true
          xcrun simctl privacy "$udid" grant location "$BUNDLE_ID" 2>/dev/null || true
          [[ "$shot_extra" == "located" ]] && xcrun simctl location "$udid" set "$SIM_LAT,$SIM_LNG" 2>/dev/null || true
          xcrun simctl launch "$udid" "$BUNDLE_ID" -demo "store" -screen "$shot_screen" \
            -AppleLanguages "($lang)" -AppleLocale "${lang}_FR" >/dev/null 2>&1 || {
            echo "::warning::launch échoue encore pour $out après restart"; continue;
          }
        else
          echo "::warning::launch a échoué pour $out — capture ignorée"
          continue
        fi
      fi

      if [[ "$shot_extra" == "located" ]]; then
        sleep "$LOCATION_SETTLE_SECONDS"
      else
        sleep "$WAIT_SECONDS"
      fi

      if ! xcrun simctl io "$udid" screenshot "$out" 2>/dev/null; then
        echo "::warning::screenshot a échoué pour $out"
        continue
      fi

      # Loggue la taille réelle de l'image (traçabilité App Store Connect :
      # chaque appareil watchOS a sa taille attendue).
      if command -v sips >/dev/null 2>&1; then
        local w h
        w=$(sips -g pixelWidth "$out" 2>/dev/null | awk '/pixelWidth/{print $2}')
        h=$(sips -g pixelHeight "$out" 2>/dev/null | awk '/pixelHeight/{print $2}')
        echo "    ${w}×${h}"
        echo "- $out : ${w}×${h}" >> "$OUTDIR/sizes.txt"
      fi
    done
  done
}

# Pour chaque taille du pool : restart propre du daemon, création d'un
# device neuf (associé au daemon tout juste redémarré), capture, puis
# destruction immédiate du device avant de passer au suivant.
first=1
for pair in "${POOL[@]}"; do
  label="${pair%%:*}"
  type_id="${pair#*:}"
  if [[ -z "$type_id" ]]; then
    echo "- $label : device type absent, taille ignorée"
    continue
  fi
  if (( first == 0 )); then
    restart_core_simulator
  fi
  first=0
  name="captures-store-$label-$$"
  echo
  echo "## $label : création d'un device neuf ($type_id)"
  udid=$(xcrun simctl create "$name" "$type_id" "$WATCH_RUNTIME")
  echo "UDID = $udid"
  CREATED_UDIDS+=("$udid")
  shoot_device "$udid" "$label"
  # Suppression immédiate pour alléger le pool avant le device suivant.
  xcrun simctl shutdown "$udid" 2>/dev/null || true
  xcrun simctl delete "$udid" 2>/dev/null || true
  # Retirer de la liste de cleanup (déjà détruit).
  NEW_CREATED=()
  for u in "${CREATED_UDIDS[@]}"; do
    [[ "$u" != "$udid" ]] && NEW_CREATED+=("$u")
  done
  CREATED_UDIDS=("${NEW_CREATED[@]}")
done

# ---------------------------------------------------------------------------
# 6) Vérifications finales.
#    - Toutes les captures attendues sont présentes et de taille raisonnable.
#    - Deux captures d'écrans DIFFÉRENTS de la même langue × device ne doivent
#      PAS être identiques (SHA256) : empêche un fallback silencieux ou un
#      crash qui laisserait la montre sur l'accueil pour chaque écran.
# ---------------------------------------------------------------------------
echo
echo "## Vérification des captures"
missing=0
too_small=0
EXPECTED_PER_PAIR=${#SHOTS[@]}
for pair in "${DEVICES[@]}"; do
  size_label="${pair%%:*}"
  for lang in "${LANGS[@]}"; do
    for shot in "${SHOTS[@]}"; do
      read -r shot_num shot_screen _ <<<"$shot"
      f="$OUTDIR/${size_label}-${lang}-${shot_num}-${shot_screen}.png"
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
if [[ -f "$OUTDIR/sizes.txt" ]]; then
  echo
  echo "### Tailles des PNG"
  cat "$OUTDIR/sizes.txt"
fi

sha_of() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }

echo
echo "## Contrôle d'empreintes (SHA256) — deux écrans ≠ ne peuvent pas être identiques"
dup_screen=0
for pair in "${DEVICES[@]}"; do
  size_label="${pair%%:*}"
  for lang in "${LANGS[@]}"; do
    # Chaque écran de détail (hunt, post, card, permit) doit différer de
    # l'accueil : empêche un fallback silencieux ou un crash qui laisserait
    # la montre sur l'accueil.
    for shot in "${SHOTS[@]}"; do
      read -r shot_num shot_screen _ <<<"$shot"
      [[ "$shot_num" == "01" ]] && continue
      f="$OUTDIR/${size_label}-${lang}-${shot_num}-${shot_screen}.png"
      home_png="$OUTDIR/${size_label}-${lang}-01-home.png"
      [[ -s "$f" && -s "$home_png" ]] || continue
      if [[ "$(sha_of "$f")" == "$(sha_of "$home_png")" ]]; then
        echo "::error::$f identique à $home_png (fallback silencieux ou crash → accueil)"
        dup_screen=$((dup_screen+1))
      fi
    done
  done
done

echo "Doublons détail=home : $dup_screen"

if [[ "$missing" -gt 0 || "$too_small" -gt 0 || "$dup_screen" -gt 0 ]]; then
  echo "::error::échec contrôle captures (manquantes=$missing, suspectes=$too_small, détail=home=$dup_screen)"
  exit 1
fi

echo "## Captures App Store OK dans $OUTDIR"
