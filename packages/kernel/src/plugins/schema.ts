/**
 * 插件边界 JSON Schema 校验器（AJV 封装）。
 *
 * 为什么集中封装：输入与输出统一在边界校验是内核铁律，失败必须显式报错
 * （validation_error / invalid_plugin_output），绝不静默放行。
 * 插件是可信进程内代码，但其产物（动作入参、动作输出、transform 载荷）
 * 仍需运行时边界校验——TypeScript 类型不跨运行时边界。
 */
import { Ajv, type ValidateFunction } from 'ajv';
import { HelmError, type JsonSchema } from '@helm/protocol';

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });

const compiledCache = new WeakMap<JsonSchema, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) return cached;
  let fn: ValidateFunction;
  try {
    fn = ajv.compile(schema);
  } catch (err) {
    throw new HelmError(
      'invalid_plugin_schema',
      `插件声明的 JSON Schema 本身无法编译：${err instanceof Error ? err.message : String(err)}`,
      500,
      { schema },
    );
  }
  compiledCache.set(schema, fn);
  return fn;
}

function formatErrors(errors: Array<{ instancePath?: string; message?: string }> | null | undefined): string {
  if (!errors || errors.length === 0) return 'unknown';
  return errors.map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim()).join('; ');
}

/** 校验动作入参（HTTP body / CLI flags / Agent Tool / Workflow action() 五端共用）。失败 400 validation_error。 */
export function validatePluginInput(pluginId: string, actionId: string, schema: JsonSchema, input: unknown): void {
  const fn = compile(schema);
  if (!fn(input)) {
    throw new HelmError(
      'validation_error',
      `动作 ${pluginId}.${actionId} 入参校验失败：${formatErrors(fn.errors)}`,
      400,
      { pluginId, actionId, errors: fn.errors },
    );
  }
}

/** 校验插件动作输出。失败 500 invalid_plugin_output（插件产物违约，非调用方错误）。 */
export function validatePluginOutput(pluginId: string, actionId: string, schema: JsonSchema, output: unknown): void {
  const fn = compile(schema);
  if (!fn(output)) {
    throw new HelmError(
      'invalid_plugin_output',
      `动作 ${pluginId}.${actionId} 输出不符合声明的 outputSchema：${formatErrors(fn.errors)}`,
      500,
      { pluginId, actionId, errors: fn.errors },
    );
  }
}

/** 通用边界校验（交接文件、路由参数等）。失败抛 HelmError。 */
export function validateOrThrow(
  schema: JsonSchema,
  value: unknown,
  message: string,
  code = 'validation_error',
  status = 400,
): void {
  const fn = compile(schema);
  if (!fn(value)) {
    throw new HelmError(code, `${message}：${formatErrors(fn.errors)}`, status, { errors: fn.errors });
  }
}
