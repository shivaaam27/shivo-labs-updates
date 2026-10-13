#!/bin/bash
# Prepares the Fabra Labs Linux (a fresh Ubuntu base image) for xtool.
# Everything we had to install by hand on 10 Oct 2026 is here, plus unzip
# (xtool's login fails without it). Prints "STEP n/5 ..." lines for the app.
set -e
export DEBIAN_FRONTEND=noninteractive

echo "STEP 1/5 Settings"
cat > /etc/wsl.conf <<'EOF'
[boot]
systemd=false
[interop]
enabled=true
appendWindowsPath=false
[user]
default=root
EOF

echo "STEP 2/5 Package lists"
apt-get update -qq

echo "STEP 3/5 Tools"
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl unzip zip socat libimobiledevice-utils ideviceinstaller \
  libfuse2t64 squashfs-tools bsdutils >/dev/null

echo "STEP 4/5 xtool"
mkdir -p /opt/xtool && cd /opt/xtool
curl -fsSL "${XTOOL_URL:-https://github.com/xtool-org/xtool/releases/latest/download/xtool-x86_64.AppImage}" -o xtool.AppImage
chmod +x xtool.AppImage
rm -rf squashfs-root
./xtool.AppImage --appimage-extract >/dev/null
ln -sf /opt/xtool/squashfs-root/AppRun /usr/local/bin/xtool
xtool --version

echo "STEP 5/5 Finishing"
apt-get clean
rm -rf /var/lib/apt/lists/*
touch /etc/fabra-ready
echo "DONE"
