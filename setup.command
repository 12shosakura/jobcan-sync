#!/bin/bash
# Jobcan → Google カレンダー同期 セットアップ（macOS）
#
# Finder でこのファイルをダブルクリックすると、次をまとめて行います。
#   1. Node.js が入っているか確認
#   2. アプリを ~/jobcan-sync に配置（ダウンロードフォルダから実行した場合）
#   3. npm install
#   4. ログイン時に自動で起動するよう登録（LaunchAgent）
#   5. ブラウザで設定画面を開く
#
# 何度実行しても安全です。更新したいときも、新しい版でもう一度実行してください。
set -euo pipefail

PORT="${JOBCAN_SYNC_PORT:-5675}"
URL="http://127.0.0.1:$PORT"
INSTALL_DIR="$HOME/jobcan-sync"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2
  echo
  read -r -p "Enter キーを押すと閉じます…" _ || true
  exit 1
}

# ダブルクリックで起動した場合は PATH が最小限なので、よくある場所を足しておく。
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
# nvm を使っている人向け
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

[ "$(uname)" = "Darwin" ] || fail "このセットアップは macOS 専用です。"

say "1/5 Node.js を確認しています…"
if ! command -v node >/dev/null 2>&1; then
  open "https://nodejs.org/ja/download"
  fail "Node.js が見つかりません。開いたページから LTS 版をインストールしてから、もう一度このファイルをダブルクリックしてください。"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js $(node -v) は古すぎます。nodejs.org から LTS 版を入れ直してください。"
echo "Node.js $(node -v) ✓"

say "2/5 アプリを配置しています…"
if [ "$SRC_DIR" != "$INSTALL_DIR" ]; then
  # ダウンロードフォルダは消されやすいので、決まった場所に置いてからそこで動かす。
  mkdir -p "$INSTALL_DIR"
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude data \
    "$SRC_DIR/" "$INSTALL_DIR/"
  echo "$INSTALL_DIR に配置しました ✓"
else
  echo "$INSTALL_DIR から実行しています ✓"
fi
cd "$INSTALL_DIR"

say "3/5 必要なライブラリを入れています（1 分ほどかかることがあります）…"
npm install --no-audit --no-fund --loglevel=error || fail "npm install に失敗しました。インターネット接続を確認してください。"

say "4/5 自動起動を登録しています…"
# ターミナルで npm start した分が動いたままだとポートを取り合うので、先に止める。
pkill -f "node .*jobcan-.*src/index.js" 2>/dev/null || true
pkill -f "node src/index.js" 2>/dev/null || true
sleep 1
bash bin/install-service.sh >/dev/null || fail "自動起動の登録に失敗しました。"
echo "ログイン時に自動で起動します ✓"

say "5/5 起動を待っています…"
for _ in $(seq 1 20); do
  if curl -fs -o /dev/null "$URL/api/state"; then
    open "$URL"
    say "✓ セットアップ完了！ ブラウザで設定画面を開きました。"
    echo "  このウィンドウは閉じて大丈夫です。"
    echo "  設定画面はいつでも $URL で開けます。"
    exit 0
  fi
  sleep 1
done

fail "アプリが起動しませんでした。~/.jobcan-gcal-sync/service.err.log を確認してください。"
