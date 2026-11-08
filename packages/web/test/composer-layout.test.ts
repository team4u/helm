import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/conversation/Composer.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const responsive = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

test('工具栏仅保留左右两组，模型归入左组，避免三个子项落入两列后换行', { timeout: 60_000 }, () => {
  assert.match(source, /className="composer-toolbar">\s*<div className="composer-toolbar-left">/)
  const leftGroup = source.slice(source.indexOf('className="composer-toolbar-left"'), source.indexOf('className="composer-toolbar-right"'))
  assert.match(leftGroup, /<ModelPicker conversation=\{conversation\} \/>/)
  assert.match(source, /className="composer-model-label"/)
  // 思考档位已并入模型浮层，工具栏不再有独立 <select>
  assert.doesNotMatch(source, /composer-thinking-select/)
  assert.match(source, /composer-thinking-row/)
  assert.match(styles, /\.composer-pills \{[^}]*overflow-x: auto;/)
  assert.match(styles, /\.composer-toolbar-right \{ justify-content: flex-end;/)
})

test('思考档位合并进模型浮层：按钮组切换，当前档位随模型短名展示', { timeout: 60_000 }, () => {
  assert.match(source, /composer-model-level/)
  assert.match(source, /void pickThinking\(''\)/)
  assert.match(source, /void pickThinking\(level\)/)
  // 浮层内档位行为分段按钮组（默认 + 各档位），主按钮态表达当前选择
  const popoverSlice = source.slice(source.indexOf('composer-thinking-row'))
  assert.match(popoverSlice, /跟随模型 \/ Profile 默认档位/)
})

test('textarea 单行起步并自动长高：rows=1，发完回归单行', { timeout: 60_000 }, () => {
  assert.match(source, /rows=\{1\}/)
  assert.match(source, /autoGrow/)
  assert.match(styles, /\.composer-textarea\s*\{[^}]*min-height:\s*36px/)
  assert.match(styles, /\.composer-textarea\s*\{[^}]*overflow-y:\s*auto/)
})

test('窄面板单行工具栏：取消思考下拉独占行，配置与发送同排', { timeout: 60_000 }, () => {
  const narrow = responsive.slice(responsive.indexOf('@container (max-width: 680px)'), responsive.indexOf('@container (max-width: 450px)'))
  assert.match(styles, /\.composer-toolbar\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/)
  assert.doesNotMatch(narrow, /composer-thinking-select/)
  // 模型选择器不再独占整行（grid-column: 1 / -1 已移除）
  assert.doesNotMatch(narrow, /grid-column: 1 \/ -1/)
  assert.match(narrow, /\.composer-action-label \{ display: none;/)
  assert.doesNotMatch(responsive, /\.composer-toolbar \{[^}]*flex-wrap: wrap/)
})

test('发送 / 停止按钮图标化：无文字仍可辨识（title + aria-label）', { timeout: 60_000 }, () => {
  assert.match(source, /btn-send/)
  assert.match(source, /aria-label=\{uploading > 0 \? `上传中 \(\$\{uploading\}\)` : '发送'\}/)
  assert.match(source, /aria-label="停止当前执行"/)
  assert.match(styles, /\.btn-send\s*\{[^}]*width: 32px;[^}]*height: 32px;[^}]*border-radius: 50%/)
})

test('移动端插件入口收进会话工具菜单，挂件默认折叠', { timeout: 60_000 }, () => {
  assert.match(source, /widgetsExpanded/)
  assert.match(source, /<details className="composer-extras"/)
  assert.match(source, /aria-label="会话工具"/)
  assert.match(source, /widgets\.length > 0 && \(!isMobile \|\| widgetsExpanded\)/)
  assert.doesNotMatch(source, /composer-widgets-toggle/)
})

test('ModelPicker 内置原生动态模型刷新按钮，调用 assetsApi.refreshModels', { timeout: 60_000 }, () => {
  assert.match(source, /assetsApi\.refreshModels\(\)/, '必须调用通用的 assetsApi.refreshModels')
  assert.match(source, /store\.refreshAssets\(\)/, '刷新完成后需同步更新前端资产')
  assert.match(source, /composer-model-refresh-btn/, '刷新按钮具有专属类名')
  assert.match(source, /aria-label="刷新动态模型目录"/, '具备无障碍描述')
  assert.match(source, /name="rotate-cw"/, '使用 rotate-cw 线性图标')
})
