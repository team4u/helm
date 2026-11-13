import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const STYLES_ENTRY = join(WEB_ROOT, 'src/styles.css')

/**
 * 读取宿主样式契约源：按 src/styles.css 入口的 @import 顺序拼接 src/styles/ 全部分片。
 * 拼接结果与 Vite 构建产物的级联顺序一致，供 CSS 契约测试断言使用。
 */
export function readHostStyles(): string {
  const entry = readFileSync(STYLES_ENTRY, 'utf8')
  const fragments: string[] = []
  for (const line of entry.split('\n')) {
    const match = line.match(/^@import '\.\/styles\/([^']+\.css)';$/)
    if (match) {
      fragments.push(readFileSync(join(WEB_ROOT, 'src/styles', match[1]!), 'utf8'))
    }
  }
  if (fragments.length === 0) {
    throw new Error('src/styles.css 入口未声明任何 @import 样式分片，宿主样式契约测试无法读取')
  }
  return fragments.join('\n')
}
