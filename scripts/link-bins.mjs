#!/usr/bin/env node
/**
 * 开发期 bin 命令挂载：在系统 PATH 目录放置薄包装脚本，经 tsx 直跑仓库源码。
 *
 * 与 npm link（指向 dist/，改源码需重新 build）不同，本脚本包装 src/ 入口，
 * 改动即时生效。仅支持 Unix（Linux/macOS）；Windows 下显式报错退出。
 *
 * 用法：
 *   pnpm link:bins             # 安装 helm / helm-node / helm-hub 包装脚本
 *   pnpm unlink:bins           # 移除
 *
 * 环境变量：
 *   HELM_BIN_DIR  覆盖安装目录（默认 /usr/local/bin）
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MARKER = 'generated-by:helm/scripts/link-bins.mjs'

/** bin 名 → 源码入口（相对仓库根） */
const BINS = {
  helm: 'packages/cli/src/index.ts',
  'helm-node': 'packages/node/src/cli.ts',
  'helm-hub': 'packages/kernel/src/main.ts',
}

const removeMode = process.argv.includes('--remove')
if (process.platform === 'win32') {
  console.error('link-bins 暂不支持 Windows：请改用 npm link（bin 指向 dist/，改码后需 pnpm build）。')
  process.exit(1)
}

const binDir = process.env.HELM_BIN_DIR || '/usr/local/bin'
const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx')

if (!removeMode && !fs.existsSync(tsx)) {
  console.error(`未找到 tsx：${tsx}，请先在仓库根执行 pnpm install。`)
  process.exit(1)
}
if (!fs.existsSync(binDir)) {
  console.error(`目标目录不存在：${binDir}（可用 HELM_BIN_DIR 覆盖）。`)
  process.exit(1)
}

function wrapper(entry) {
  return [
    '#!/bin/sh',
    `# ${MARKER} — 请勿手改；撤销执行 pnpm unlink:bins`,
    `exec "${tsx}" "${path.join(ROOT, entry)}" "$@"`,
    '',
  ].join('\n')
}

function npmLinkRemnant(p) {
  // npm link 遗留：bin 软链或全局 node_modules 里的包软链
  try {
    return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : null
  } catch {
    return null
  }
}

function unlinkSyncSafe(p) {
  // 删软链统一用 unlink：fs.rmSync 遇到指向目录的软链会误报 ERR_FS_EISDIR
  try {
    fs.unlinkSync(p)
  } catch {}
}

function cleanNpmLinkLibRemnants() {
  // npm link 会在 <prefix>/lib/node_modules/@helm/<pkg> 留包软链，一并清掉（尽力而为）
  const nm = path.resolve(binDir, '..', 'lib', 'node_modules')
  for (const pkg of ['cli', 'node', 'kernel']) {
    const p = path.join(nm, '@helm', pkg)
    if (npmLinkRemnant(p)) {
      unlinkSyncSafe(p)
      console.log(`  清理 npm link 遗留软链 ${p}`)
      const scopeDir = path.join(nm, '@helm')
      try {
        if (fs.readdirSync(scopeDir).length === 0) fs.rmdirSync(scopeDir)
      } catch {}
    }
  }
}

if (removeMode) {
  console.log(`移除 ${Object.keys(BINS).join(' / ')}（${binDir}）`)
  for (const name of Object.keys(BINS)) {
    const p = path.join(binDir, name)
    let content = ''
    try {
      content = fs.readFileSync(p, 'utf8')
    } catch {}
    if (content.includes(MARKER) || npmLinkRemnant(p)) {
      unlinkSyncSafe(p)
      console.log(`  已移除 ${p}`)
    } else if (fs.existsSync(p)) {
      console.warn(`  跳过 ${p}：非本脚本产物，未动`)
    }
  }
  cleanNpmLinkLibRemnants()
  console.log('完成。')
  process.exit(0)
}

console.log(`安装开发包装脚本到 ${binDir}（tsx 直跑源码，改动即时生效）：`)
for (const [name, entry] of Object.entries(BINS)) {
  const p = path.join(binDir, name)
  let st = null
  try {
    st = fs.lstatSync(p)
  } catch {}
  if (st && !st.isSymbolicLink()) {
    // 已有普通文件：仅当是本脚本旧产物时覆盖，否则显式拒绝（可能是别的工具的二进制）
    if (!fs.readFileSync(p, 'utf8').includes(MARKER)) {
      console.error(`  拒绝覆盖 ${p}：已存在非本脚本产物的文件，请先人工确认。`)
      process.exit(1)
    }
  } else if (st) {
    // 软链（含悬空）：npm link 遗留或旧安装，移除后重写
    unlinkSyncSafe(p)
  }
  fs.writeFileSync(p, wrapper(entry), { mode: 0o755 })
  fs.chmodSync(p, 0o755)
  console.log(`  ${name} -> ${entry}`)
}
cleanNpmLinkLibRemnants()

// 自检：tsx 存在且能启动（--help 快速冒烟，helm-node 同；helm-hub 会真启动内核，仅校验语法）
for (const name of ['helm', 'helm-node']) {
  try {
    execFileSync(path.join(binDir, name), ['--help'], { stdio: 'pipe', timeout: 60_000 })
    console.log(`  自检通过：${name} --help`)
  } catch (err) {
    console.error(`  自检失败：${name} --help\n${err.stderr || err.message}`)
    process.exit(1)
  }
}
console.log('完成。撤销执行 pnpm unlink:bins。')
