/**
 * Git 仓库夹具加速辅助（`@helm/test-kit/git`）。
 * 支持一次性初始化模板仓库后用 `cpSync` 快速复制多份独立 Git 仓库，
 * 避免每个用例重复 spawn `git init / add / commit` 带来的进程开销。
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['GIT_DIR']
  delete env['GIT_WORK_TREE']
  delete env['GIT_INDEX_FILE']
  delete env['GIT_OBJECT_DIRECTORY']
  delete env['GIT_ALTERNATE_OBJECT_DIRECTORIES']
  return env
}

function runGit(dir: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: dir,
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * 在指定目录初始化一个真实 Git 仓库（`main` 分支、隔离配置与初始提交）。
 * 默认写入 `README.md`，可通过 `files` 自定义初始工作区文件集合。
 */
export function initGitRepo(
  dir: string,
  files: Record<string, string> = { 'README.md': '# repo\n' },
): string {
  mkdirSync(dir, { recursive: true })
  runGit(dir, ['init', '-q', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@helm.local'])
  runGit(dir, ['config', 'user.name', 'helm-test'])
  const entries = Object.entries(files)
  for (const [relPath, content] of entries) {
    const absPath = join(dir, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, content, 'utf8')
  }
  if (entries.length > 0) {
    runGit(dir, ['add', '-A'])
    runGit(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
  } else {
    runGit(dir, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'init'])
  }
  return dir
}

/** 预初始化 Git 模板句柄。 */
export interface GitTemplate {
  templateDir: string
  /** 通过文件系统整树拷贝将模板实例化到独立目录。 */
  cloneTo: (targetDir: string) => string
  /** 清理模板临时目录。 */
  cleanup: () => void
}

/**
 * 创建可复用的已初始化 Git 模板仓库；可选 `setup` 在初始提交之后追加自定义提交或文件。
 * 适合在套件级别初始化一次，再用 `cloneTo` 毫秒级实例化各用例仓库。
 */
export function createGitTemplate(
  prefix = 'helm-git-template-',
  setup?: (dir: string) => void,
): GitTemplate {
  const templateDir = mkdtempSync(join(tmpdir(), prefix))
  try {
    initGitRepo(templateDir)
    if (setup) {
      setup(templateDir)
    }
  } catch (error) {
    rmSync(templateDir, { recursive: true, force: true })
    throw error
  }
  return {
    templateDir,
    cloneTo: (targetDir: string): string => {
      mkdirSync(dirname(targetDir), { recursive: true })
      cpSync(templateDir, targetDir, { recursive: true })
      return targetDir
    },
    cleanup: (): void => {
      rmSync(templateDir, { recursive: true, force: true })
    },
  }
}
