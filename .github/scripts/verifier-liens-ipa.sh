#!/usr/bin/env bash
# Garde-fou avant envoi à App Store Connect : chaque bibliothèque liée par un
# binaire de l'app doit être soit fournie par iOS, soit embarquée dans l'app.
# Sinon dyld refuse de lancer l'app (« Library missing ») AVANT tout code JS :
# plantage au démarrage, invisible pour Sentry.
#
# Vécu 4.2.10 (build 757) : le binaire précompilé d'expo-contacts 56.0.14
# référençait @rpath/Testing.framework (Swift Testing, outil de test Xcode,
# absent des iPhone) → l'app ne s'ouvrait plus.
#
# Usage : verifier-liens-ipa.sh <chemin .ipa>
# OTOOL peut être surchargé (tests).
set -euo pipefail

IPA="${1:?usage: verifier-liens-ipa.sh <fichier.ipa>}"
OTOOL="${OTOOL:-otool}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q "$IPA" -d "$WORK"

APP="$(find "$WORK/Payload" -maxdepth 1 -name '*.app' -type d | head -1)"
[ -n "$APP" ] || { echo "::error::Aucun .app dans $IPA"; exit 1; }

# Binaires Mach-O à contrôler : exécutable principal, frameworks embarqués,
# dylibs embarquées, extensions (et leurs frameworks).
binaires() {
  local exe
  exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist" 2>/dev/null || basename "$APP" .app)"
  echo "$APP/$exe"
  find "$APP" -type d -name '*.framework' | while read -r fw; do
    local nom
    nom="$(basename "$fw" .framework)"
    [ -f "$fw/$nom" ] && echo "$fw/$nom"
  done
  find "$APP" -type f -name '*.dylib'
  find "$APP" -type d -name '*.appex' | while read -r ext; do
    local e
    e="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$ext/Info.plist" 2>/dev/null || basename "$ext" .appex)"
    [ -f "$ext/$e" ] && echo "$ext/$e"
  done
}

# Une dépendance @rpath/... est présente si elle existe dans un dossier
# Frameworks de l'app (app principale ou extension).
present_dans_app() {
  local rel="$1"
  [ -e "$APP/Frameworks/$rel" ] && return 0
  find "$APP/PlugIns" -path "*/Frameworks/$rel" -print -quit 2>/dev/null | grep -q .
}

manquants=0
while read -r bin; do
  [ -n "$bin" ] || continue
  # 1re ligne = nom du binaire ; les suivantes = bibliothèques liées.
  while read -r ligne; do
    dep="$(echo "$ligne" | sed -E 's/^[[:space:]]+//; s/ \(compatibility version.*$//')"
    [ -n "$dep" ] || continue
    # Lien faible : son absence ne bloque pas le lancement.
    case "$ligne" in *", weak)"*) continue ;; esac
    case "$dep" in
      /System/*|/usr/lib/*) continue ;;                  # fourni par iOS
      @rpath/libswift*.dylib) continue ;;                # runtime Swift, dans iOS depuis 12.2
      @rpath/*)
        rel="${dep#@rpath/}"
        present_dans_app "$rel" && continue ;;
      @executable_path/*|@loader_path/*)
        base="$APP"; [ "${dep%%/*}" = "@loader_path" ] && base="$(dirname "$bin")"
        [ -e "$base/${dep#*/}" ] && continue ;;
    esac
    echo "::error::${bin#"$APP"/} lie « $dep », absent de l'app et d'iOS : l'app planterait au lancement."
    manquants=$((manquants + 1))
  done < <("$OTOOL" -L "$bin" | tail -n +2)
done < <(binaires)

if [ "$manquants" -gt 0 ]; then
  echo "::error::$manquants bibliothèque(s) manquante(s) : envoi à App Store Connect annulé. Piste : un module Expo précompilé défectueux → l'ajouter à expo.autolinking.ios.buildFromSource (apps/mobile/package.json)."
  exit 1
fi
echo "Bibliothèques liées : toutes présentes ($(binaires | wc -l | tr -d ' ') binaires contrôlés)."
