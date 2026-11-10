/**
 * PluginUiView 上下文测试（client 轨）：
 * - ctx 含 conversationId/composer 正确注入（createPluginClientContext 行为在
 *   plugin-client-context-ext.test.ts 覆盖，此处验证 PluginUiView 布线）；
 *（声明式 JSON 轨已迁出 Web 核心，求值域卫生测试随插件 DSL 移至 kernel 侧）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true




