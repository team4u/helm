/**
 * @helm/env-io：kernel 与 @helm/node 共享的执行实现包。
 *
 * protocol 只保留可串行化 RPC 形状（NodePathUsage 等）；真实文件系统 /
 * 进程表访问、环境变量大小写原语与宿主机 Shell 探测归属本包，由两端
 * （Hub 本机与远端节点 daemon）依赖同一实现，绝不各复制一套语义。
 */
export * from './path-usage.js'
export * from './node-path-usage-io.js'
export * from './process-env.js'
export * from './shell-config.js'
export * from './node-shell-config-io.js'
