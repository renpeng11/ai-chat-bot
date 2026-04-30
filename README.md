# 飞书 AI 消息总结 Cloudflare Worker

这是一个可部署到 Cloudflare Workers 的应用，包含：

- 接收飞书事件回调并记录消息内容
- 收到飞书消息后调用智谱 AI 自动回复
- 使用智谱 AI 对当天消息生成总结
- 每天 18:00 中国时间自动推送一条飞书消息
- 提供 `/admin` 管理页查看收到的消息、总结内容和发出记录，并支持手动推送

## 1. 安装依赖

```bash
npm install
```

## 2. 创建 D1 数据库

```bash
npx wrangler d1 create feishu_ai_digest
```

把命令返回的 `database_id` 填到 `wrangler.toml` 的 `database_id`。

初始化数据库：

```bash
npm run db:init:remote
```

本地开发时可使用：

```bash
cp .dev.vars.example .dev.vars
npm run db:init
npm run dev
```

## 3. 配置密钥

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ZHIPU_API_KEY
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
npx wrangler secret put FEISHU_TARGET_RECEIVE_ID
```

可选：如果飞书事件订阅配置了 Verification Token，也设置它：

```bash
npx wrangler secret put FEISHU_VERIFICATION_TOKEN
```

`ADMIN_USERNAME`、`ZHIPU_MODEL`、`TZ`、`AUTO_REPLY_ENABLED` 和 `FEISHU_TARGET_RECEIVE_ID_TYPE` 在 `wrangler.toml` 的 `[vars]` 中配置。默认管理账号是 `admin`。

`FEISHU_TARGET_RECEIVE_ID_TYPE` 默认是 `chat_id`。如果你要发给个人，也可以改成飞书消息 API 支持的 `open_id`、`user_id`、`union_id` 或 `email`，并让 `FEISHU_TARGET_RECEIVE_ID` 使用对应的值。

## 4. 配置飞书

### 接收消息

在飞书开放平台应用的事件订阅里配置请求地址：

```text
https://你的-worker域名/feishu/webhook
```

应用需要订阅接收消息相关事件。首次保存时，飞书会发送 `url_verification` 请求，本 Worker 会返回 `challenge`。

当前实现支持常见的文本消息事件格式，会把原始 payload 一并保存到 D1，便于后续排查和扩展。

收到消息后，Worker 会先快速保存并响应飞书，再在后台调用智谱生成回复，最后通过飞书应用消息 API 发回同一个 `chat_id`。如果暂时不想自动回复，可以把 `wrangler.toml` 中的 `AUTO_REPLY_ENABLED` 改为 `"false"` 后重新部署。

部署并配置事件订阅后，你可以直接给机器人发一条消息。管理页的“收到的消息”会显示这条消息对应的 `chat_id` 和发送者 ID。若要让每日总结发回你和机器人的这个会话，推荐把该 `chat_id` 设置为：

```bash
npx wrangler secret put FEISHU_TARGET_RECEIVE_ID
```

并保持 `FEISHU_TARGET_RECEIVE_ID_TYPE = "chat_id"`。

### 推送消息

推荐使用飞书自建应用的 `App ID` / `App Secret` 推送消息。每日总结和管理页手动消息都会通过飞书消息 API 发送到 `FEISHU_TARGET_RECEIVE_ID`。

如果你更想使用群自定义机器人，也可以额外配置：

```bash
npx wrangler secret put FEISHU_BOT_WEBHOOK
```

当 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TARGET_RECEIVE_ID` 同时存在时，应用会优先使用自建应用发送。

## 5. 部署

```bash
npm run deploy
```

Cloudflare Cron 使用 UTC。`wrangler.toml` 中的 `0 10 * * *` 等于中国时间每天 18:00。

## 管理页面

部署后访问：

```text
https://你的-worker域名/admin
```

浏览器会弹出 Basic Auth 登录框：

- 用户名：`ADMIN_USERNAME`，默认 `admin`
- 密码：`ADMIN_PASSWORD`

页面可查看收到的消息、AI 总结、发出记录，并支持手动生成今日总结、重发总结、发送自定义飞书消息。

管理页使用页面内登录表单和 HttpOnly Cookie 会话，适合微信内置浏览器访问，不依赖浏览器 Basic Auth 弹窗。
