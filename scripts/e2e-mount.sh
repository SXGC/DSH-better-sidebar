#!/usr/bin/env bash
# =============================================================================
# dsh-better-sidebar 挂载冒烟编排（CI + 本地）：
#
#   1. 用官方 CLI 把 npm 打包产物（tarball）真实挂载进一个全新 scratch
#      profile（`dsh plugin --profile web add file:<tarball>`，触发
#      dsh.profile.bundles 协调，与用户安装路径一致）；
#   2. 启动真实 `dsh web`（keyless，--port 0 取 OS 分配端口）；
#   3. 运行 tests/e2e 无头渲染 lane（Playwright Chromium）：断言外壳与
#      插件挂载、无崩溃标记，并驱动内置 tab 深扫。
#
# 用法：
#   bash scripts/e2e-mount.sh [--grep <playwright-filter>]
#
# 环境变量（均可省略）：
#   DSH_CMD        dsh 命令；缺省 PATH 上的 `dsh`，回退 npx 拉官方包
#   TARBALL        插件 tarball 的绝对路径；缺省时脚本先执行当前 checkout 的
#                  `pnpm build && pnpm pack`，并使用唯一命名的 fresh artifact
#   PORT           固定端口（默认 0 = OS 分配，从日志解析 URL）
#   DSH_HOME_BASE  覆盖 scratch 根目录（默认系统临时目录）。脚本始终在其下
#                  新建本调用拥有的独立子目录，只写入/删除该子目录；调用方
#                  提供的目录本身（可能是真实 ~/.dsh）绝不写入或删除。
#   KEEP_HOME      非空时保留 scratch home（调试用）
#
# 退出码 = playwright 的退出码；服务器与 scratch 目录由 trap 兜底清理。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DSH_CMD="${DSH_CMD:-dsh}"
read -r -a DSH_COMMAND <<< "$DSH_CMD"
PORT="${PORT:-0}"
TARBALL="${TARBALL:-}"
GREP_FILTER=""
if [ "${1:-}" = "--grep" ]; then GREP_FILTER="${2:?--grep 需要参数}"; fi

say()  { printf '\033[32m[e2e-mount]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[e2e-mount]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[e2e-mount]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "未找到 node（DSH 运行需要 Node.js >= 20）"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm（dsh plugin 转发给 pnpm）"

# dsh CLI 解析：PATH 上的 dsh 优先，否则 npx 拉官方包（同 scripts/install.sh）
if ! command -v "${DSH_COMMAND[0]}" >/dev/null 2>&1; then
  if command -v npx >/dev/null 2>&1; then
    say "PATH 上无 $DSH_CMD，回退 npx -y --package @deepseek-ai/dsh"
    DSH_CMD="npx -y --package @deepseek-ai/dsh dsh"
    DSH_COMMAND=(npx -y --package @deepseek-ai/dsh dsh)
  else
    die "未找到 $DSH_CMD 或 npx；请先安装 DSH CLI（npm i -g @deepseek-ai/dsh）或用 DSH_CMD 指定"
  fi
fi

# Artifact provenance is part of this gate. Never infer a tarball from an old
# repository glob: without an explicit artifact, build and pack this checkout
# now. An explicit TARBALL must already be absolute so the installed bytes are
# unambiguous in logs and cannot change meaning with the caller's cwd.
if [ -z "$TARBALL" ]; then
  ARTIFACT_DIR="$ROOT/.artifacts"
  mkdir -p "$ARTIFACT_DIR"
  PACKAGE_VERSION="$(node -p "require('$ROOT/package.json').version")"
  TARBALL="$ARTIFACT_DIR/dsh-better-sidebar-${PACKAGE_VERSION}-sci05-$(date -u +%Y%m%dT%H%M%SZ)-$$.tgz"
  say "未指定 TARBALL；构建并打包当前 checkout ..."
  pnpm build
  pnpm pack --out "$TARBALL"
fi
case "$TARBALL" in
  /*) ;;
  *) die "TARBALL 必须是绝对路径：$TARBALL" ;;
esac
[ -f "$TARBALL" ] || die "找不到 tarball：$TARBALL"

# Mechanical package-surface gate: the mounted artifact must carry both
# Host-owned layout contributions and must not carry the deleted overlay
# ToggleCluster path. This catches a stale 0.16.1 tgz before DSH installation.
node - "$TARBALL" <<'NODE' || die "tarball 不是当前 SCI-05 layout-action artifact"
const { execFileSync } = require('node:child_process')
const tarball = process.argv[2]
const client = execFileSync('tar', ['-xOf', tarball, 'package/lib/client.js'], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
})
for (const marker of ['better-sidebar:right-toggle', 'better-sidebar:bottom-toggle']) {
  if (!client.includes(marker)) throw new Error(`missing ${marker}`)
}
for (const marker of ['data-dsh-better-sidebar-toggles', 'ToggleCluster']) {
  if (client.includes(marker)) throw new Error(`legacy marker present: ${marker}`)
}
NODE
say "tarball: $TARBALL"
say "tarball mtime: $(stat -c '%y' "$TARBALL")"
say "tarball sha256: $(sha256sum "$TARBALL" | awk '{print $1}')"

# scratch home（每次全新，绝不触碰真实 ~/.dsh）：调用方给了 DSH_HOME_BASE
# 时，只在其下新建本调用拥有的子目录并只删除该子目录；缺省时直接用系统
# 临时目录。
if [ -n "${DSH_HOME_BASE:-}" ]; then
  SCRATCH="$(mktemp -d "$DSH_HOME_BASE/dsh-e2e-mount.XXXXXX")"
else
  SCRATCH="$(mktemp -d /tmp/dsh-e2e-mount.XXXXXX)"
fi
export DSH_HOME="$SCRATCH/home"
WORKSPACE_DIR="$SCRATCH/workspace"
LOG_DIR="$SCRATCH"
WEB_LOG="$LOG_DIR/web.log"
mkdir -p "$DSH_HOME/profiles/web" "$WORKSPACE_DIR"
say "scratch home: ${DSH_HOME}（DSH_HOME=${DSH_HOME}）"

SERVER_PID=""
cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -z "${KEEP_HOME:-}" ]; then
    rm -rf "$SCRATCH"
  else
    warn "KEEP_HOME 已设置，保留 $SCRATCH"
  fi
  exit "$code"
}
trap cleanup EXIT

# 步骤 1：引导 scratch profile（web 模板，镜像 dsh initProfile；先写
# pnpm-workspace.yaml 的 allowBuilds / minimumReleaseAgeExclude，避免 pnpm 11
# strict-dep-builds 拦截 node-pty/protobufjs 或拒绝 <24h 新版本——同 install.sh）
PROFILE_DIR="$DSH_HOME/profiles/web"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  node-pty: true
  protobufjs: true

minimumReleaseAgeExclude:
  - dsh-better-sidebar
EOF

# 步骤 2：官方 CLI 安装 tarball + bundle 协调（真实挂载路径）
say "执行 dsh plugin --profile web add file:$TARBALL ..."
"${DSH_COMMAND[@]}" plugin --profile web add "file:$TARBALL"

# 步骤 3：校验挂载生效（dsh.profile.bundles 含 dsh-better-sidebar）
if ! node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const bundles = p.dsh?.profile?.bundles ?? [];
  process.exit(bundles.includes("dsh-better-sidebar") ? 0 : 1);
' "$PROFILE_DIR/package.json"; then
  warn "dsh-better-sidebar 未出现在 dsh.profile.bundles 中——挂载未注册"
  cat "$PROFILE_DIR/package.json"
  exit 1
fi
say "挂载已注册：dsh.profile.bundles 包含 dsh-better-sidebar"

# 步骤 4：启动 dsh web（--port 0 = OS 分配，避免端口冲突；keyless 可起）
say "启动 dsh web（port=${PORT}）..."
"${DSH_COMMAND[@]}" web --port "$PORT" > "$WEB_LOG" 2>&1 &
SERVER_PID=$!

URL=""
for _ in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "=== dsh web 提前退出，日志尾部 ===" >&2
    tail -30 "$WEB_LOG" >&2 || true
    exit 1
  fi
  if URL="$(grep -oE 'dsh web: http://127\.0\.0\.1:[0-9]+' "$WEB_LOG" | head -1 | awk '{print $3}')" && [ -n "$URL" ]; then
    break
  fi
  sleep 1
done
[ -n "$URL" ] || { echo "=== 120s 内未等到 dsh web 就绪，日志尾部 ===" >&2; tail -40 "$WEB_LOG" >&2 || true; exit 1; }
say "dsh web 就绪：${URL}（pid ${SERVER_PID}）"

# 步骤 5：运行无头渲染 lane
say "运行 Playwright 无头渲染 lane..."
DSH_E2E_URL="$URL" DSH_E2E_WORKSPACE="$WORKSPACE_DIR" \
  pnpm exec playwright test ${GREP_FILTER:+--grep "$GREP_FILTER"}

say "通过：插件挂载到真实 DSH 后无头渲染未崩溃"
