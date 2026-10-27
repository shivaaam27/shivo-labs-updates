#!/bin/bash
# X Tools' Wi-Fi installs, inside its WSL distro (README.md). Engine.ps1 runs these; every line of output is JSON.
#   wifi.sh setup <url> <sha256>           installs the programs (package.sh's package) into /opt/shivo-wifi, if not there yet
#   wifi.sh pair <udid>                    once, on the cable: the Wi-Fi pairing (no tap on the phone)
#   wifi.sh paired <udid>                  {"paired": true|false}
#   wifi.sh find <udid> [last-ip]          {"found": ip}: the last address first, else every address on this PC's networks
#   wifi.sh apps <udid> <ip>               {"apps": [...]}: the phone's own apps
#   wifi.sh install <udid> <ip> <app.ipa>  signs a copy for X Tools' Apple ID (fresh 7-day profiles), sends it over Wi-Fi
set -o pipefail
BIN=${SHIVO_WIFI_BIN:-/usr/local/bin}
DIR=/root/.config/shivo-wifi
say() { printf '%s\n' "$1"; }
err() { printf '{"error":"%s"}\n' "$1"; exit 1; }   # (plain shell: python3 may not be there yet; messages have no ")
rp() { printf '%s/%s.rp' "$DIR" "$1"; }

case "$1" in
setup)
    [ "$(cat /opt/shivo-wifi/.sha256 2>/dev/null)" = "$3" ] && [ -x /usr/local/bin/shivo-sign ] && { say '{"ready":true}'; exit 0; }
    say '{"step":"Getting Wi-Fi tools"}'
    # what the programs and this script need beyond X Tools' Linux (older setups lack some)
    need=""; for p in python3 libcurl4t64 libstdc++6 libffi8 libgmp10 libbrotli1; do dpkg -s $p >/dev/null 2>&1 || need="$need $p"; done
    if [ -n "$need" ]; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $need >/dev/null 2>&1 ||
            { apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $need >/dev/null 2>&1; } ||
            err "Couldn't install what Wi-Fi installs need (check the internet connection)."
    fi
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    curl -fsSL --retry 3 "$2" -o "$tmp/p.tgz" || err "Couldn't download the Wi-Fi tools (check the internet connection)."
    [ "$(sha256sum "$tmp/p.tgz" | cut -d' ' -f1)" = "$3" ] || err "The Wi-Fi tools download was damaged. It will try again next time."
    tar -xzf "$tmp/p.tgz" -C "$tmp" && [ -x "$tmp/shivo-wifi/shivo-sign" ] || err "The Wi-Fi tools download was damaged."
    rm -rf /opt/shivo-wifi && mv "$tmp/shivo-wifi" /opt/shivo-wifi && printf '%s' "$3" > /opt/shivo-wifi/.sha256
    ln -sf /opt/shivo-wifi/shivo-wifi /usr/local/bin/shivo-wifi && ln -sf /opt/shivo-wifi/shivo-sign /usr/local/bin/shivo-sign
    say '{"ready":true}' ;;
pair)
    mkdir -p "$DIR"
    exec "$BIN/shivo-wifi" pair "$2" "$(rp "$2")" ;;
paired)
    [ -s "$(rp "$2")" ] && say '{"paired":true}' || say '{"paired":false}' ;;
find)
    [ -s "$(rp "$2")" ] || err "This iPhone isn't set up for Wi-Fi yet: plug it in once."
    if [ -n "$3" ] && "$BIN/shivo-wifi" check "$(rp "$2")" "$3" 2>/dev/null | grep '"found"'; then exit 0; fi
    # every address on this PC's own networks (WSL networking is mirrored: these are Windows' networks), /24 each.
    # The PC's own addresses from /proc/net/fib_trie (the minimal Linux has no "ip" command); not loopback, link-local
    # or WSL/Docker's own 172.16-31 networks.
    ips=$(awk '/32 host LOCAL/ { print prev } { prev = $2 }' /proc/net/fib_trie | sort -u |
        grep -vE '^(127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | awk -F. '{for (i = 1; i < 255; i++) print $1"."$2"."$3"."i}' | sort -u)
    [ -n "$ips" ] || err "This PC isn't on a network."
    "$BIN/shivo-wifi" check "$(rp "$2")" $ips ;;
apps)
    exec "$BIN/shivo-wifi" apps "$3" "$(rp "$2")" ;;
install)
    [ -s "$(rp "$2")" ] || err "This iPhone isn't set up for Wi-Fi yet: plug it in once."
    [ -f "$4" ] || err "The app file is missing."
    work=$(mktemp -d /tmp/shivo-wifi.XXXXXX); trap 'rm -rf "$work"' EXIT
    say '{"step":"Preparing"}'
    unzip -q "$4" -d "$work/x" || err "This file is not an iPhone app (.ipa)."
    app=$(ls -d "$work"/x/Payload/*.app 2>/dev/null | head -1)
    [ -n "$app" ] || err "This file is not an iPhone app (.ipa)."
    # an already-signed X Tools build (XTL- bundle ID) goes as it is: signing it again would make a second app
    id=$(python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb")).get("CFBundleIdentifier",""))' "$app/Info.plist")
    if [[ "$id" != XTL-* ]]; then
        # (with the phone's id: it is put back on the Apple ID's devices first, as a cable install does; an older
        # shivo-sign takes only the app)
        if "$BIN/shivo-sign" 2>/dev/null | grep -q 'udid'; then "$BIN/shivo-sign" "$app" "$2" "iPhone" || exit 1
        else "$BIN/shivo-sign" "$app" || exit 1; fi
        (cd "$work/x" && python3 -c 'import os,zipfile
with zipfile.ZipFile("../signed.ipa","w",zipfile.ZIP_DEFLATED) as z:
    for r,ds,fs in os.walk("Payload"):
        for f in fs: z.write(os.path.join(r,f))') || err "Packaging the signed app failed."
        ipa="$work/signed.ipa"
    else ipa="$4"; fi
    "$BIN/shivo-wifi" install "$3" "$(rp "$2")" "$ipa" ;;   # (not exec: the temporary folder is removed after)
*) err "usage: wifi.sh pair|paired|find|install ..." ;;
esac
