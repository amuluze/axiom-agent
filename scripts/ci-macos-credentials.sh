#!/usr/bin/env bash
# macOS 构建的签名/公证凭据装配（CI 工作流与本地 build:dmg 共用）。
#
# CI 模式（GITHUB_ENV 存在，GitHub Actions 约定）：
#   输入（step 级 env：secrets 由工作流条件映射，未配置 = 未定义）：
#     APPLE_CERTIFICATE(+APPLE_CERTIFICATE_PASSWORD)  .p12 base64 → 导入临时钥匙串、
#       自动发现 Developer ID 身份 → 写 GITHUB_ENV: APPLE_SIGNING_IDENTITY。
#       刻意不转发证书本体给构建环境：tauri bundler 对 APPLE_CERTIFICATE 只判
#       「存在与否」（空串也算存在，CI 实跑踩坑），二次导入会与钥匙串身份冲突
#     APPLE_API_KEY_P8(+APPLE_API_KEY_ID)             .p8 文本内容 → 落盘临时文件
#       → 写 GITHUB_ENV: APPLE_API_KEY_PATH + APPLE_API_KEY(=Key ID)
#   其余同名透传（APPLE_API_ISSUER / APPLE_ID 三件套 / TAURI_SIGNING_*）由工作流
#   条件映射，本脚本不处理。
# 本地模式（无 GITHUB_ENV，build:dmg source 凭据文件之后调用）：
#   APPLE_API_KEY 为内容或路径时归一成 APPLE_API_KEY_PATH 并 export（同进程生效）。
#
# 行为：只做「形态归一」，不做强制校验——凭据缺失时构建自动降级（adhoc 未公证 /
# updater 剥离），与 scripts/generate-release-config.mjs 的自动检测同一套判定。
# 日志只输出 <set>/<unset> 形态，绝不回显变量值。
set -euo pipefail

if [ -n "${GITHUB_ENV:-}" ]; then
  # ── CI 模式 ──────────────────────────────────────────────────────────────
  WORKDIR="$(mktemp -d)"
  trap 'rm -rf "$WORKDIR"' EXIT
  if [ -n "${APPLE_CERTIFICATE:-}" ] && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
    P12="$WORKDIR/certificate.p12"
    # macOS 自带 base64 的解码旗标随版本在 --decode / -D 间变化，双写兜底
    printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$P12" 2>/dev/null \
      || printf '%s' "$APPLE_CERTIFICATE" | base64 -D > "$P12"
    KC="${RUNNER_TEMP:-/tmp}/axiom-build.keychain-db"
    KC_PASS="${KEYCHAIN_PASSWORD:-axiom-ci}"
    security delete-keychain "$KC" 2>/dev/null || true
    security create-keychain -p "$KC_PASS" "$KC"
    security unlock-keychain -p "$KC_PASS" "$KC"
    security import "$P12" -k "$KC" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple: -k "$KC_PASS" "$KC" > /dev/null
    # shellcheck disable=SC2046 —— 搜索列表本就是空格分隔的路径序列
    security list-keychains -s "$KC" $(security list-keychains | sed 's/"//g' | tr '\n' ' ')
    security default-keychain -s "$KC"
    rm -f "$P12"
    IDENTITY="$(security find-identity -v -p codesigning \
      | grep 'Developer ID Application' | head -1 | sed -E 's/^.*"(.*)"$/\1/')"
    [ -n "$IDENTITY" ] || { echo '导入后未发现 Developer ID Application 身份（检查 .p12 与密码）'; exit 1; }
    echo "APPLE_SIGNING_IDENTITY=$IDENTITY" >> "$GITHUB_ENV"
    echo "已导入 .p12 到临时钥匙串：$KC（身份经 GITHUB_ENV 注入）"
  fi
  if [ -n "${APPLE_API_KEY_P8:-}" ]; then
    # .p8 落盘到 RUNNER_TEMP（notarize 发生在后续步骤，文件须活过本 step）
    KEY_FILE="${RUNNER_TEMP:-/tmp}/AuthKey_axiom-$$.p8"
    printf '%s\n' "$APPLE_API_KEY_P8" > "$KEY_FILE"
    {
      echo "APPLE_API_KEY_PATH=$KEY_FILE"
      [ -n "${APPLE_API_KEY_ID:-}" ] && echo "APPLE_API_KEY=$APPLE_API_KEY_ID"
    } >> "$GITHUB_ENV"
    echo ".p8 已落盘，APPLE_API_KEY_PATH 经 GITHUB_ENV 注入"
  fi
else
  # ── 本地模式 ─────────────────────────────────────────────────────────────
  if [ -n "${APPLE_API_KEY:-}" ]; then
    if [ -f "$APPLE_API_KEY" ]; then
      export APPLE_API_KEY_PATH="$APPLE_API_KEY"
    else
      KEY_FILE="$(mktemp -d)/AuthKey_axiom.p8"
      printf '%s\n' "$APPLE_API_KEY" > "$KEY_FILE"
      export APPLE_API_KEY_PATH="$KEY_FILE"
    fi
  fi
fi

echo "凭据形态：signing-identity=${APPLE_SIGNING_IDENTITY:+<set>}${APPLE_SIGNING_IDENTITY:-<unset>} \
certificate=${APPLE_CERTIFICATE:+<set>}${APPLE_CERTIFICATE:-<unset>} \
api-key-p8=${APPLE_API_KEY_P8:+<set>}${APPLE_API_KEY_P8:-<unset>} \
api-key-id=${APPLE_API_KEY_ID:+<set>}${APPLE_API_KEY_ID:-<unset>} \
apple-id=${APPLE_ID:+<set>}${APPLE_ID:-<unset>} \
updater-key=${TAURI_SIGNING_PRIVATE_KEY:+<set>}${TAURI_SIGNING_PRIVATE_KEY:-<unset>}"
