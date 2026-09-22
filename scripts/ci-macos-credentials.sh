#!/usr/bin/env bash
# macOS CI 构建的签名/公证凭据装配（GitLab CI build:macos 专用）。
#
# 输入全部来自受保护的 GitHub Actions Secrets（清单见 docs/github-actions.md），全部可选：
#   APPLE_SIGNING_IDENTITY              使用 runner 钥匙串已有 Developer ID 身份
#                                       （自托管开发机场景，推荐；不触碰钥匙串状态）
#   APPLE_CERTIFICATE                   base64 的 .p12（干净 CI VM 场景，与下一项成对）
#   APPLE_CERTIFICATE_PASSWORD          .p12 导入密码
#   APPLE_KEYCHAIN_PASSWORD             临时钥匙串密码（可缺省）
#   APPLE_API_ISSUER / APPLE_API_KEY    App Store Connect API 公证；GitLab File 型
#                                       变量的值是临时文件路径（直接用），普通变量
#                                       视为 .p8 内容则落盘成 notarytool 需要的文件
#   APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID   备选公证方案 B
#   TAURI_SIGNING_PRIVATE_KEY(+PASSWORD)        updater minisign，同名同义无需处理
#
# 行为：只做「环境变量形态归一」，不做强制校验——凭据缺失时构建自动降级
# （adhoc 未公证 / updater 剥离），与 scripts/generate-release-config.mjs 的
# 自动检测同一套判定；凭据齐组与否的发布级强制属本地 release:gate --publish
# 职责，CI 侧不复制。日志只输出 <set>/<unset> 形态，绝不回显变量值。
set -euo pipefail

# .p12 导入临时钥匙串（tauri-action 同款流程）：codesign 只在钥匙串搜索列表里
# 找身份，故导入后追加进列表并设为默认；login 钥匙串保留在列表内不被改动。
if [ -n "${APPLE_CERTIFICATE:-}" ] && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
  WORKDIR="$(mktemp -d)"
  trap 'rm -rf "$WORKDIR"' EXIT
  P12="$WORKDIR/certificate.p12"
  # macOS 自带 base64 的解码旗标随版本在 --decode / -D 间变化，双写兜底
  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$P12" 2>/dev/null \
    || printf '%s' "$APPLE_CERTIFICATE" | base64 -D > "$P12"
  KC="${RUNNER_TEMP:-/tmp}/axiom-build.keychain-db"
  KC_PASS="${APPLE_KEYCHAIN_PASSWORD:-axiom-ci}"
  security delete-keychain "$KC" 2>/dev/null || true
  security create-keychain -p "$KC_PASS" "$KC"
  security unlock-keychain -p "$KC_PASS" "$KC"
  security import "$P12" -k "$KC" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple: -k "$KC_PASS" "$KC" > /dev/null
  # shellcheck disable=SC2046 —— 搜索列表本就是空格分隔的路径序列
  security list-keychains -s "$KC" $(security list-keychains | sed 's/"//g' | tr '\n' ' ')
  security default-keychain -s "$KC"
  rm -f "$P12"
  echo "已导入 .p12 到临时钥匙串：$KC"
fi

# App Store Connect API Key 形态归一：File 型变量的值本身就是临时文件路径。
if [ -n "${APPLE_API_KEY:-}" ]; then
  if [ -f "$APPLE_API_KEY" ]; then
    export APPLE_API_KEY_PATH="$APPLE_API_KEY"
  else
    KEY_FILE="$(mktemp -d)/AuthKey_axiom.p8"
    printf '%s\n' "$APPLE_API_KEY" > "$KEY_FILE"
    export APPLE_API_KEY_PATH="$KEY_FILE"
  fi
fi

echo "凭据形态：signing-identity=${APPLE_SIGNING_IDENTITY:+<set>}${APPLE_SIGNING_IDENTITY:-<unset>} \
certificate=${APPLE_CERTIFICATE:+<set>}${APPLE_CERTIFICATE:-<unset>} \
api-key=${APPLE_API_KEY:+<set>}${APPLE_API_KEY:-<unset>} \
apple-id=${APPLE_ID:+<set>}${APPLE_ID:-<unset>} \
updater-key=${TAURI_SIGNING_PRIVATE_KEY:+<set>}${TAURI_SIGNING_PRIVATE_KEY:-<unset>}"
