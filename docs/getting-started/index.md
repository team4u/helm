# 安装并发出第一条消息

## 启动 Hub

安装 Node.js 24.12 或更新版本，再运行：

```bash
npm install -g @helmx/cli
helmx update --watch
```

`helmx update --watch` 会安装并启动 Hub。保持终端开着，然后用浏览器打开 <http://127.0.0.1:3202>。首次访问时设置管理员密码并登录。Docker、源码开发和 CLI 登录的步骤也可以单独查阅。 [安装与配置](installation.md)

## 配置模型

打开「模型与凭证中心」，为要用的模型供应商配置凭据，再选一个默认模型。会话也可以单独选模型。用 CLI 操作时，先登录 Hub，再设置凭据和默认模型。 [命令行配置](installation.md#用-cli-登录和配置模型)

## 在项目目录里开一个会话

打开个人助理，确认工作节点和工作目录。Hub 和代码在同一台机器上时，可以选 `local`。如果代码在另一台机器，就选那台节点并填写它上面的绝对路径。 [接入远端节点](installation.md#接入远端节点)

可以先问「请读一下这个项目的 README，告诉我该从哪里开始跑测试。」这一步能同时确认模型可用、助手读到的是你想看的目录。

以后经常使用同一目录时，可以为它建一个 Profile，保存默认节点、目录、模型和技能。 [Profile 参考](../plugins/profile.md)

## 接下来

- 需要让成员边做边商量、互相审查时，试试 [Swarm 实战](orchestration-guide.md)。
- 想把一组步骤反复运行时，试试 [第一个工作流](first-workflow.md)。
