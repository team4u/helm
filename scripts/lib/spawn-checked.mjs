/**
 * 受管子进程执行器：check-changed 顺序执行 typecheck / 测试命令的唯一进程通道。
 *
 * 为什么不用裸 spawn + child.kill：本仓库测试纪律要求「全部脚本进程不留孤儿」。
 * 与 scripts/run-tests.mjs 同机制保证整棵进程树可终止，但语义更严格：
 *   - leader 退出 ≠ 整组停止：POSIX 下持续轮询 owned 进程组（detached PGID）存活性，
 *     组内仍有成员（如忽略 SIGTERM 的孙进程）时绝不提前结算；
 *   - 子进程自身也是 supervisor（如 run-tests.mjs 会再建自己的 detached 子组 G2 并在
 *     收到信号后先排空 G2 才退出）：外层只监督自己的 owned 组 G1，G1 在子进程完成其
 *     G2 排空前不会空（leader 退出不结算）；外层给足自清理窗口（默认 25s，覆盖子进程
 *     内部 5s 宽限 + 15s last-resort）后对 G1 升级 SIGKILL；仍不空则有限 last-resort：
 *     最终 SIGKILL + unref 后按信号码结算（绝不仅 resolve 而保留活 child 句柄挂住进程）；
 *   - Windows：无进程组信号，用 taskkill /PID <pid> /T /F 杀 owned ChildProcess 的
 *     整棵树，等待 taskkill 完成并如实报告其退出码与输出（失败诊断不吞）；
 *   - 重复 SIGINT/SIGTERM 幂等：只建一轮定时器。
 * 退出码如实透传：子进程按码退出原样返回；被信号终止按 128+signal（GNU timeout 惯例）。
 *
 * 包管理器调用解析（resolvePackageManagerInvoke）：Windows 下 spawn('pnpm') 因 .cmd
 * 解析问题在 shell:false 时不可用；优先用 pnpm 注入的 npm_execpath（包管理器 JS 入口，
 * 校验 .js/.cjs/.mjs 后缀）+ 当前 Node 可执行文件构造 argv，绝不拼 shell 字符串。
 */
import { spawn } from 'node:child_process';

/** 默认终止时间线（毫秒）；测试可通过 timings 参数注入更短值。 */
export const DEFAULT_KILL_TIMINGS = {
  pollMs: 100, // owned 组存活性轮询间隔
  cleanupGraceMs: 25_000, // 留给子进程 supervisor 自清理（run-tests: 5s 宽限 + 15s last-resort）后升级 SIGKILL
  lastResortMs: 45_000, // 总兜底：到点强制结算，绝不无限等待
};

/**
 * @typedef {{ cmd: string, args: string[], label: string }} ManagedCommand
 * @typedef {{ pollMs?: number, cleanupGraceMs?: number, lastResortMs?: number }} KillTimings
 */

/**
 * 解析本项目可用的包管理器调用 argv（跨平台，不经过 shell）。
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ cmd: string, args: string[] }}
 */
export function resolvePackageManagerInvoke(env = process.env) {
  const execPath = env.npm_execpath;
  // pnpm run 子进程必带 npm_execpath 指向包管理器 JS 入口；校验后缀后用当前 Node 运行，
  // 避免 Windows .cmd 解析问题与 shell 字符串注入面。异常值一律回退 PATH 上的 pnpm
  // （POSIX shebang 可直接 spawn；直接 node 调用脚本的 Windows 场景请通过 pnpm script 进入）。
  if (typeof execPath === 'string' && /\.(cjs|mjs|js)$/.test(execPath)) {
    return { cmd: process.execPath, args: [execPath] };
  }
  return { cmd: 'pnpm', args: [] };
}

/**
 * 执行单条命令，返回其真实退出码（0 为成功）。
 * @param {ManagedCommand} command
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, timings?: KillTimings }} opts
 * @returns {Promise<number>}
 */
export function runManagedCommand(command, { cwd, env, timings }) {
  const t = { ...DEFAULT_KILL_TIMINGS, ...timings };
  return new Promise((resolve) => {
    const child = spawn(command.cmd, command.args, {
      cwd,
      env: env ?? process.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32', // POSIX 独立进程组，才能 kill(-pid) 杀整组
    });
    const label = command.label;

    let terminating = false; // 已收到外部信号，进入终止流程
    let forcedExitCode = null;
    let finished = false;
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    const timers = new Set();
    let pollTimer = null;

    const later = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timers.add(timer);
      return timer;
    };
    const clearAllTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    /** owned 组是否仍有存活成员：leader 退出不代表整组停止（孙进程可能忽略信号）。 */
    const groupAlive = () => {
      if (process.platform === 'win32') {
        return child.exitCode === null && child.signalCode === null;
      }
      if (child.pid == null) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (err) {
        return err?.code !== 'ESRCH'; // EPERM 等异常仍按「存在」保守处理
      }
    };

    const killGroup = (signal) => {
      if (process.platform === 'win32' || child.pid == null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // 组已消失则无事可做。
      }
    };

    /** Windows：taskkill 杀整棵树，等待完成并如实报告失败诊断。 */
    const windowsKillTree = () =>
      new Promise((res) => {
        if (child.pid == null) {
          res();
          return;
        }
        const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        tk.stdout?.on('data', (d) => {
          out += String(d);
        });
        tk.stderr?.on('data', (d) => {
          out += String(d);
        });
        tk.on('error', (err) => {
          console.error(`[${label}] taskkill 启动失败: ${err.message}`);
          res();
        });
        tk.on('exit', (code) => {
          if (code !== 0) {
            console.error(`[${label}] taskkill 退出码 ${code}: ${out.trim() || '(无输出)'}`);
          }
          res();
        });
      });

    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearAllTimers();
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      // last-resort 兜底时 child 可能仍存活：unref 避免活句柄把宿主进程挂住
      //（owned 组已吃 SIGKILL，残余由 OS 收尾）。
      if (child.exitCode === null && child.signalCode === null) child.unref();
      resolve(code);
    };

    /** 外部信号（Ctrl+C / SIGTERM）：转发 owned 组，等子进程自清理与组排空，重复信号幂等。 */
    const onSignal = (signal) => {
      if (finished || terminating) return;
      terminating = true;
      forcedExitCode = signal === 'SIGINT' ? 130 : 143;
      console.error(`[${label}] 收到 ${signal}，终止子进程树（pid ${child.pid}）并等待其完成自身清理`);
      if (child.pid == null) {
        finish(forcedExitCode);
        return;
      }
      if (process.platform === 'win32') {
        windowsKillTree().then(() => {
          if (!finished) startGroupWatch();
        });
      } else {
        killGroup(signal);
        // 先给足 supervisor 子进程自清理窗口（其可能还需杀它自己的 detached 子组），
        // 超窗仍存活才升级 SIGKILL——绝不 leader 一退出就当作整组停止。
        later(() => killGroup('SIGKILL'), t.cleanupGraceMs);
        startGroupWatch();
      }
      later(() => {
        console.error(`[${label}] 终止后 owned 组 ${t.lastResortMs}ms 内未排空，last-resort 强制结算。`);
        killGroup('SIGKILL');
        finish(forcedExitCode);
      }, t.lastResortMs);
    };
    /** 轮询 owned 组直到排空；仅组完全消失才结算（POSIX），Windows 以 child 退出为准。 */
    const startGroupWatch = () => {
      if (pollTimer || finished) return;
      pollTimer = setInterval(() => {
        if (!groupAlive()) finish(forcedExitCode);
      }, t.pollMs);
    };

    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    child.on('error', (err) => {
      if (finished) return;
      console.error(`[${label}] 启动失败: ${err.message}`);
      finish(127);
    });

    child.on('exit', (code, signal) => {
      if (finished) return;
      if (terminating) return; // 终止路径由组存活性轮询收尾，leader 退出不结算、不清定时器
      if (code !== null) {
        finish(code);
        return;
      }
      const signalExit = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 }[signal] ?? 1;
      finish(signalExit);
    });
  });
}

/**
 * 顺序执行命令列表，首个失败即停并原样返回其退出码；全部通过返回 0。
 * @param {ManagedCommand[]} commands
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, timings?: KillTimings }} opts
 * @returns {Promise<number>}
 */
export async function runSequentially(commands, opts) {
  for (const cmd of commands) {
    console.error(`\n[check-changed] ▶ ${cmd.label}`);
    const code = await runManagedCommand(cmd, opts);
    if (code !== 0) {
      console.error(`[check-changed] ✗ ${cmd.label} 失败，退出码 ${code}（后续命令跳过）`);
      return code;
    }
    console.error(`[check-changed] ✓ ${cmd.label} 通过`);
  }
  return 0;
}
