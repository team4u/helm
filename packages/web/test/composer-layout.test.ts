import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/conversation/Composer.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const responsive = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

test('输入工具栏分离模型配置、扩展工具与发送操作，防止左侧整体换行挤走发送按钮', { timeout: 60_000 }, () => {
  assert.match(source, /<ModelPicker conversation=\{conversation\} \/>\s*<span className="composer-toolbar-left">/)
  assert.match(source, /className="composer-model-label"/)
  assert.match(source, /className="input composer-thinking-select"/)
  assert.match(styles, /\.composer-toolbar-left \{ overflow-x: auto;/)
  assert.match(styles, /\.composer-toolbar-right \{ justify-content: flex-end;/)
})

test('窄面板使用两排网格，配置占满首排，发送区保持第二排右侧', { timeout: 60_000 }, () => {
  const narrow = responsive.slice(responsive.indexOf('@container (max-width: 680px)'), responsive.indexOf('@container (max-width: 450px)'))
  assert.match(narrow, /\.composer-toolbar \{ grid-template-columns: minmax\(0, 1fr\) auto;/)
  assert.match(narrow, /\.composer-picker-root \{ grid-column: 1 \/ -1;/)
  assert.match(narrow, /\.composer-action-label-mobile \{ display: inline;/)
  assert.doesNotMatch(responsive, /\.composer-toolbar \{[^}]*flex-wrap: wrap/)
})
