/**
 * JSON Schema 边界校验器（AJV 封装，内核与插件共享的唯一实现）。
 *
 * 为什么集中封装：输入与输出统一在边界校验是内核铁律，失败必须显式报错
 * （validation_error / invalid_plugin_output），绝不静默放行。
 * 插件是可信进程内代码，但其产物（动作入参、动作输出、transform 载荷）
 * 仍需运行时边界校验——TypeScript 类型不跨运行时边界。
 */
import { Ajv, type ValidateFunction } from 'ajv'
import { HelmError } from './error.js'
import type { JsonSchema } from './plugin.js'

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false })

const compiledCache = new WeakMap<JsonSchema, ValidateFunction>()

function compile(schema: JsonSchema): ValidateFunction {
  const cached = compiledCache.get(schema)
  if (cached) return cached
  // 核心接口全为同步校验：$async Schema 的校验函数返回 Promise，
  // 同步 boolean 判断会把 Promise 当 truthy 放行非法输入并产生 unhandled
  // rejection——在编译边界显式拒绝，绝不引入异步路径。
  if ((schema as { $async?: unknown }).$async !== undefined) {
    throw new HelmError(
      'invalid_plugin_schema',
      `声明的 JSON Schema 含 $async：核心同步校验边界不支持异步 Schema`,
      500,
      { schema },
    )
  }
  let fn: ValidateFunction
  try {
    fn = ajv.compile(schema)
  } catch (error) {
    throw new HelmError(
      'invalid_plugin_schema',
      `JSON Schema 编译失败：${error instanceof Error ? error.message : String(error)}`,
      500,
      { schema },
    )
  }
  compiledCache.set(schema, fn)
  return fn
}

export function validateOrThrow(
  schema: JsonSchema,
  value: unknown,
  message: string,
  code = 'validation_error',
  status = 400,
): void {
  const fn = compile(schema)
  if (!fn(value)) {
    throw new HelmError(code, `${message}：${formatErrors(fn.errors)}`, status, { errors: fn.errors })
  }
}

function formatErrors(errors: ValidateFunction['errors'] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) return '未知校验错误'
  return errors
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim())
    .join('; ')
}
