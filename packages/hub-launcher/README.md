# 本地 Hub 生命周期

`@helm/hub-launcher` 是 `helm update` 使用的内部包。`helm update --watch` 前台启动本机 Hub，默认每 15 分钟查询所选 npm 通道。更新策略和进程交接在本包实现，下载校验、不可变版本目录及原子状态由 `@helm/update` 提供。

- `HELM_HUB_INSTALL_ROOT` 默认 `~/.helm-hub`，存放程序版本、启动配置、日志、PID 和更新锁。
- `HELM_DATA_DIR` 默认 `~/.helm`，存放会话、凭据和插件。两个目录必须互相独立。
- 候选先安全解包并在候选根补齐依赖，执行 `start.mjs check`。发现 Hub 忙碌或无法确认空闲时保留候选版本，延期切换。换版时进程串行使用同一数据目录。就绪检查按子进程报告的监听地址确认。失败时恢复旧版本指针，并尝试重启旧进程。
- 前台由启动该 Hub 的 `helm` 进程负责关停。Linux 上 `helm update --stop` 可通过 `/proc` 验证已记录的进程身份。无法验证时显式拒绝跨进程停止。Windows 的前台管理通过进程树关停。

用户命令见 [安装指南](../../docs/getting-started/installation.md)。
