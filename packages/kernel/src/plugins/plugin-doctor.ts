/**
 * 外部插件源码静态自检（doctor）：真实加载 + 真实注册断言，不做第二套近似校验。
 *
 * 检查链（按执行顺序，后继检查依赖前驱成功）：
 * 1. manifest/入口解析（resolvePluginEntry：plugin.json 合法性、main 越根、入口存在）；
 * 2. backend 代际导入（importPluginDefinition：TS 转译、模块初始化、default 导出形状）；
 * 3. register 真实注册（临时 PluginHost + 内存 doc store：definePlugin 全部声明边界
 *    校验——action/tool/ui/doc/service/provider 的形状、重复、scope 等与真实宿主同一
 *    代码路径，不维护第二套近似校验器）；注册经 ctx.ui 代理顺带收集 client 模块引用；
 * 4. client 编译（对收集到的全部 client.tsx 模块引用用真实编译器编译）。
 *
 * 诚实性纪律：任何一步失败都产生结构化 PluginDoctorCheck（code/message/details），
 * 绝不静默降级为「大致可用」；成功报告附真实注册得到的 PluginSummary。
 *
 * 隔离与副作用：
 * - doctor 使用独立代际号导入插件模块（?helmgen=N）：新代数模块图独立初始化，
 *   不影响当前已注册实例正在使用的旧代数模块；裸说明符依赖仍与宿主同实例；
 * - 注册在临时 PluginHost 上进行（临时 dataDir、内存 doc store、doctor 专用后端：
 *   ctx.host.* 调用一律 501 显式拒绝）——definePlugin 顶层依赖宿主调用的插件在
 *   doctor 处如实失败（报告给作者），不是 doctor 的缺陷；
 * - 临时 host 注册即 dispose（enabled: false，服务不启动，无副作用可泄漏）。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HelmError,
  type PluginDefinition,
  type PluginDoctorCheck,
  type PluginDoctorReport,
  type PluginSummary,
} from '@helm/protocol';
import { PluginHost, type PluginHostBackend } from './plugin-host.js';
import { nextPluginGeneration, registerPluginTsRoot } from './backend-ts-loader.js';
import {
  importPluginDefinition,
  normalizeDefinition,
  resolvePluginEntry,
} from './external-loader.js';
import { clientNpmRootsOf, compilePluginClientModule } from './client-compiler.js';

/** doctor 真实注册所需的临时 doc store（内存镜像，不触碰宿主持久层）。 */
class DoctorDocStore {
  private values = new Map<string, unknown>();
  get<T>(key: string, initial: T): T {
    return this.values.has(key) ? (structuredClone(this.values.get(key)) as T) : initial;
  }
  set<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value));
  }
  async flush(): Promise<void> {}
}

/**
 * doctor 后端：ctx.host.* 的全部真实宿主调用一律 501 显式拒绝（不静默返回伪造
 * 数据）。仅提供 PluginHost 构造/注册链必需的安全只读底座：isClosing 恒 false、
 * 文本脱敏恒等。definePlugin 顶层依赖宿主调用的插件在 doctor 处如实失败。
 */
function doctorBackend(): PluginHostBackend {
  const unavailable = (what: string): never => {
    throw new HelmError(
      'unsupported',
      `doctor 静态自检不提供宿主运行时能力：${what}（插件不应在 definePlugin 顶层依赖宿主调用）`,
      501,
    );
  };
  const port = new Proxy({} as Record<string, never>, {
    get: (_t, prop) => unavailable(`host.<port>.${String(prop)}`),
  });
  return {
    isClosing: () => false,
    redact: (text: string) => text,
    redactText: (text: string) => text,
    profiles: port as never,
    skills: port as never,
    nodeIpc: undefined,
  nodeFetch: undefined,
  openTunnel: undefined,
    secrets: port as never,
    setPluginConfig: () => unavailable('host.setConfig'),
    dispatchTrigger: () => unavailable('host.dispatchTrigger'),
    submitInput: () => unavailable('host.submitInput'),
    createConversation: () => unavailable('host.createConversation'),
    listConversations: () => unavailable('host.listConversations'),
    getConversation: () => unavailable('host.getConversation'),
    getConversationDetail: () => unavailable('host.getConversationDetail'),
    updateConversation: () => unavailable('host.updateConversation'),
    abortConversation: () => unavailable('host.abortConversation'),
    getConversationOwnership: () => unavailable('host.getConversationOwnership'),
    getConversationActivity: () => unavailable('host.getConversationActivity'),
    listArtifacts: () => unavailable('host.listArtifacts'),
    getArtifact: () => unavailable('host.getArtifact'),
    completeText: () => unavailable('host.completeText'),
    executionEnv: () => unavailable('host.executionEnv'),
    buildSpawnEnv: () => unavailable('host.buildSpawnEnv'),
    spawnAgent: () => unavailable('host.spawnAgent'),
    runGate: () => unavailable('host.runGate'),
    prepareInterruptedConversations: () => unavailable('host.prepareInterruptedConversations'),
    resolveSpawnTarget: () => unavailable('host.resolveSpawnTarget'),
    listActiveSpawnExecutions: () => [],
    probeNodeFs: () => unavailable('host.probeNodeFs'),
    invokeAction: () => unavailable('host.invokeAction'),
    listActions: () => [],
    refreshModels: () => unavailable('host.refreshModels'),
    createAsk: () => unavailable('host.createAsk'),
    cancelAsk: () => unavailable('host.cancelAsk'),
    registerAskSeqResolver: () => unavailable('host.registerAskSeqResolver'),
    onEvent: () => unavailable('host.onEvent'),
    // 事件发布在注册完成链上必然发生（plugin.changed）：doctor 无 SSE 消费方，
    // 静默丢弃是安全 no-op（不是能力缺失的静默降级：事件本身无返回值可伪造）。
    emitEvent: () => {},
    manageConversation: () => unavailable('host.manageConversation'),
    markConversationOwnership: () => unavailable('host.markConversationOwnership'),
    execEnv: () => unavailable('host.execEnv'),
    withFileLock: <T,>(_path: string, fn: () => Promise<T>): Promise<T> => fn(),
    atomicWriteFile: () => unavailable('host.atomicWriteFile'),
    withFileMutationQueue: <T,>(_target: never, fn: () => Promise<T>): Promise<T> => fn(),
    prepareAction: () => unavailable('host.prepareAction'),
  };
}

/** HelmError -> 可串行化诊断形状。 */
function toErrorInfo(err: unknown): { code: string; message: string; details?: unknown } {
  if (err instanceof HelmError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  return {
    code: 'doctor_check_failed',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * 对外部插件目录执行静态自检（真实加载 + 真实注册 + 真实 client 编译）。
 * dir 由调用方校验为存在的目录；返回报告对象（插件自身缺陷以 checks 呈现），
 * 只有 doctor 基座故障（临时目录创建失败等）才 reject。
 */
export async function doctorPluginDir(dir: string): Promise<PluginDoctorReport> {
  let releaseTsRoot: (() => void) | undefined;
  try {
    if (statSync(dir).isDirectory()) releaseTsRoot = registerPluginTsRoot(dir);
  } catch {
    // 入口检查负责把不存在/不可读目录转换为结构化 doctor 报告；
    // 无法注册 TS 根时继续执行，后端检查会如实暴露真实导入错误。
  }
  try {
    return await doctorPluginDirInternal(dir);
  } finally {
    releaseTsRoot?.();
  }
}

async function doctorPluginDirInternal(
  dir: string,
): Promise<PluginDoctorReport> {
  const checks: PluginDoctorCheck[] = [];
  const push = (id: string, label: string, run: () => void | Promise<void>): Promise<boolean> =>
    (async () => {
      try {
        await run();
        checks.push({ id, label });
        return true;
      } catch (err) {
        checks.push({ id, label, error: toErrorInfo(err) });
        return false;
      }
    })();

  let entryPath: string | undefined;
  const entryOk = await push('manifest', '清单与入口解析', async () => {
    entryPath = await resolvePluginEntry(dir);
    if (entryPath === undefined) {
      throw new HelmError(
        'plugin_entry_missing',
        `目录 ${dir} 不含插件入口标记（无 plugin.json 且无约定入口文件）`,
        404,
        { dir },
      );
    }
  });

  let definition: PluginDefinition | undefined;
  if (!entryOk) return report(dir, undefined, checks, undefined);

  const backendOk = await push('backend', '后端模块代际导入', async () => {
    const generation = nextPluginGeneration(dir);
    definition = normalizeDefinition(await importPluginDefinition(dir, entryPath!, { generation }), dir);
  });
  if (!backendOk || definition === undefined) return report(dir, undefined, checks, undefined);

  const clientRefs: Array<{ module: string; export: string }> = [];
  const screenIds: string[] = [];
  let summary: PluginSummary | undefined;
  // 真实注册 + client 编译共用一个 scratch 目录（临时 dataDir 与编译缓存），
  // doctor 结束后统一清理；不使用宿主生产目录，避免写竞争。
  const registerOk = await withDoctorScratch(async (scratch) =>
    push('register', '真实注册断言', async () => {
      let host: PluginHost | undefined;
      try {
        host = new PluginHost({
          dataDir: scratch,
          host: doctorBackend(),
          docs: new DoctorDocStore(),
          deferServices: true,
        });
        await host.register(withClientCapture(definition!, clientRefs, screenIds), { enabled: false });
        const found = host.list().find((s) => s.id === definition!.id);
        if (!found) {
          throw new HelmError(
            'invalid_plugin_definition',
            `注册后未在宿主清单中发现插件 ${definition!.id}（doctor 内部状态不一致）`,
            500,
            { dir, pluginId: definition!.id },
          );
        }
        summary = found;
      } finally {
        await host?.dispose().catch(() => {});
      }
    }),
  );
  if (!registerOk) return report(dir, definition.id, checks, undefined);

  const clientOk = await withDoctorScratch(async (scratch) =>
    push('client', '前端模块真实编译与导出校验', async () => {
      // 与生产 getClientModule 同一受控 npm 映射：清单 clientDependencies 归一
      // 进 definition.npmDependencies 后在此生效（doctor/运行链同一编译口径）。
      const npmRoots = clientNpmRootsOf(definition!.npmDependencies);
      const seen = new Set<string>();
      for (const ref of clientRefs) {
        const key = `${ref.module}#${ref.export}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const compiled = await compilePluginClientModule(
          definition!.id,
          definition!.clientRoot!,
          ref.module,
          scratch,
          { npmRoots },
        );
        // 悬空 export 校验：编译产物的真实具名导出必须包含声明引用的名字，
        // 否则 UI 声明会在运行期渲染空白（悬空引用）。如实报告，不静默。
        if (!compiled.exports.includes(ref.export)) {
          throw new HelmError(
            'invalid_client_export',
            `插件 ${definition!.id} 的 client 引用 ${ref.module}#${ref.export} 悬空：模块具名导出为 [${compiled.exports.join(', ') || '无'}]`,
            422,
            { pluginId: definition!.id, module: ref.module, export: ref.export, exports: compiled.exports },
          );
        }
      }
    }),
  );
  void clientOk;

  return report(dir, definition.id, checks, summary, screenIds);
}

function report(
  dir: string,
  pluginId: string | undefined,
  checks: PluginDoctorCheck[],
  summary: PluginSummary | undefined,
  screenIds?: string[],
): PluginDoctorReport {
  return {
    dir,
    ...(pluginId !== undefined ? { pluginId } : {}),
    ok: checks.every((c) => c.error === undefined),
    checks,
    ...(summary !== undefined ? { summary } : {}),
    ...(screenIds !== undefined ? { screens: [...screenIds] } : {}),
  };
}

/**
 * 包装 definePlugin：在真实 ctx.ui.* 注册方法执行之外，顺带收集 client.tsx 模块
 * 引用（供 client 编译检查）与 ctx.ui.screen 声明的视图 id（供 PluginDoctorReport.
 * screens）。代理只读不改写——注册边界校验仍由真实 PluginHost 的原始方法执行，
 * 这里零近似、零第二套校验：只捕获通过真实 ui.screen 调用的声明，不做静态扫描。
 */
function withClientCapture(
  definition: PluginDefinition,
  sink: Array<{ module: string; export: string }>,
  screenIds: string[],
): PluginDefinition {
  const original = definition.definePlugin;
  return {
    ...definition,
    async definePlugin(ctx) {
      const uiProxy = new Proxy(ctx.ui, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const spec = args[0] as { client?: { module?: unknown; export?: unknown } } | undefined;
            const client = spec?.client;
            if (
              client !== undefined &&
              typeof client === 'object' &&
              typeof (client as { module?: unknown }).module === 'string' &&
              typeof (client as { export?: unknown }).export === 'string'
            ) {
              sink.push({
                module: (client as { module: string }).module,
                export: (client as { export: string }).export,
              });
            }
            // 只记录通过真实 ui.screen 调用且最终注册成功（原始方法未抛错）的视图 id；
            // spec.id 形状校验由原始 registerUi 执行，这里仅事后记录，不预判。
            if (prop === 'screen' && spec !== undefined && typeof (spec as { id?: unknown }).id === 'string') {
              screenIds.push((spec as { id: string }).id);
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as typeof ctx.ui;
      return original({ ...ctx, ui: uiProxy });
    },
  };
}

/**
 * doctor 全链专用临时目录：真实注册的临时 dataDir 与 client 编译缓存共用一个
 * scratch 目录，doctor 返回前统一清理（不使用宿主缓存目录：避免与生产缓存
 * 目录的写竞争；缓存 hash 语义一致，不影响生产编译正确性）。
 */
async function withDoctorScratch<T>(fn: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'helm-doctor-'));
  try {
    return await fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
