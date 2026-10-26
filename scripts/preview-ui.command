#!/bin/zsh
set -e

# Development preview only. The application target remains Windows.
cd "${0:A:h}/.."
for wcs_node_dir in "$HOME/.local/n/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.local/n/n/versions/node/"*/bin(N/); do
  if [[ -x "$wcs_node_dir/node" ]] && "$wcs_node_dir/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    export PATH="$wcs_node_dir:$PATH"
    break
  fi
done
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  print '请先安装 Node.js 22 或更高版本，详见 README。'
  read -k 1 '?按任意键退出。'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  print '请先在项目目录执行：ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci'
  read -k 1 '?按任意键退出。'
  exit 1
fi
if wcs_preview_html=$(curl --fail --silent --max-time 1 'http://127.0.0.1:5273/' 2>/dev/null); then
  if [[ "$wcs_preview_html" == *'WinCapture Studio'* ]]; then
    open 'http://127.0.0.1:5273/#/editor'
    exit 0
  fi
fi
exec npm run dev:ui -- --open '/#/editor'
