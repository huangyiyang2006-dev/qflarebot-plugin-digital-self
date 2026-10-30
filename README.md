# 数字分身（QFlareBot 插件）

在 QQ 私聊里和模仿本人风格的 DeepSeek 分身聊天。只对**机器人管理员**的私聊生效，其他人发消息既不回复，也不会调用 DeepSeek 花钱。

## 行为

- 监听 `qq.c2c.message`。只有 `scene === 'c2c'` 且 `session.isBotAdmin` 才处理，其余直接忽略。
- 管理员名单在机器人面板「设置 → 权限」里按 **openid** 添加——不是 QQ 号码。
- `/分身重置`：删除该用户的近期对话（最近 6 轮）。人格与长期记忆是插件配置，不受影响。
- 其他以 `/` 开头的消息不接，避免抢走框架自带的 `/sid` 等命令。
- 单个用户同时只处理一条消息。上一条没回来时再发，会收到「上一条消息还在处理中」，不会并发调用模型、也不会互相覆盖历史。
- 模型调用超时 20 秒。框架给一次事件约 30 秒（25 秒时告警、30 秒被平台掐断），留出写库和发送的时间。

## 配置

| 字段 | 说明 |
| --- | --- |
| `apiKey` | DeepSeek API Key，`writeOnly`——面板里填，存进去后不再回显。不要写进源码、README 或提交历史 |
| `model` | 默认 `deepseek-flash`；请求关闭思考模式，以降低聊天延迟 |
| `persona` | 人格与说话风格，最多取前 5000 字 |
| `memory` | 长期记忆摘要，最多取前 5000 字 |

人格和记忆每次对话都会拼进 system prompt 发给 DeepSeek。它们属于私密资料：别提交进公开仓库，也别贴进 issue。

## 存储

两个 D1 表，由 `onInstall` / `onBoot` 幂等创建，命名由框架加 `p_digital_self_` 前缀：

- `{history}`：`chat_key`（`botId:userId`）→ 最近 12 条消息的 JSON
- `{locks}`：按用户的处理锁，`ts` 超过 60 秒视为上次处理被中断，允许接管

## 开发

SDK 与构建工具不发 npm，从 QFlareBot 源码构建。把 QFlareBot 克隆到本仓库旁边（`devDependencies` 里是 `file:../QFlareBot/packages/*`）：

```bash
git clone https://github.com/QFlareBot/QFlareBot
(cd QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)
npm install
```

```bash
npm test          # vitest，用 @qqbot/sdk/testing 驱动处理器，不需要真实机器人
npm run typecheck # tsc --noEmit
npm run build     # 生成 dist/plugin.js 与 dist/manifest.json
npm run sync      # 构建并把 dist/manifest.json 复制到仓库根目录
```

改了插件定义（权限、事件、配置字段）要跑 `npm run sync` 并提交根目录的 `manifest.json`，CI 会校验它有没有过期。

## 装到机器人

推到**公开** GitHub 仓库（面板只支持公开仓库），在面板「插件 → 安装插件」里粘贴仓库链接，预检后安装并触发构建。安装后：

1. 填 `apiKey`、模型名、人格与记忆，保存。
2. 面板「设置 → 权限」里加上你自己的 openid，否则一条都不会回。
3. QQ 私聊机器人发一句话，确认真的收到回复，并核对面板日志与 DeepSeek 用量。

## 已知限制

- 没有速率限制：连续快速发消息时只靠单用户锁挡住并发，不限制总量。
- 历史只保留 6 轮，超出即截断，不做摘要或长期记忆自动写入。
- 失败时会明确告知原因（模型名错误、余额不足、超时、数据库异常），但不重试——被动回复窗口有限，重试容易撞上平台限制。
- 插件与框架同进程运行，`{表名}` 前缀只防撞名和误删，不是安全边界。
