# setlog mini program MVP

这是一个 Setlog 风格的微信小程序 + 后端 MVP，重点放在这几条约束上：

- 每条视频限制在 2 秒以内
- 每小时只能上传一次
- 采用“上传意图 + 直传 + 服务端落库”的流程
- 按日汇总 clip，生成每日 vlog 的拼接计划

## 三张核心表

### 1. 用户系统

- 微信登录：`POST /api/auth/wechat-login`
- 会话查询：`GET /api/auth/session`
- 用户列表：`GET /api/users`
- 当前用户：`GET /api/users/me`
- 用户详情：`GET /api/users/:id`

返回里会包含 `userId` 和 `sessionId`，小程序会把 `sessionId` 放到 `x-session-id` 请求头中。

### 2. 圈子系统

- 创建圈子：`POST /api/circles`
- 圈子列表：`GET /api/circles`
- 加入圈子：`POST /api/circles/:id/join`
- 成员列表：`GET /api/circles/:id/members`
- 成员管理：`PATCH /api/circles/:id/members/:userId`
- 移除成员：`DELETE /api/circles/:id/members/:userId`

### 3. 内容系统

- 内容列表：`GET /api/contents`
- 视频上传意图：`POST /api/upload-intents`
- 上传直传：`PUT /api/uploads/:uploadId`
- 上传补传：`POST /api/uploads/:uploadId`
- 时间线：`GET /api/timeline`
- 每日 vlog：`POST /api/daily-vlogs/generate` 和 `GET /api/daily-vlogs`

内容表记录的是“谁、在哪个圈子、什么时候发”，并把媒体存储信息一起带上。当前默认是本地存储，但接口已经按云存储元数据的方式组织好了。

现有的 `logs` / `logMembers` / `clips` 还保留着，作为兼容入口和历史数据视图。

## 项目结构

- `app.js` / `app.json` / `app.wxss`：小程序根入口
- `pages/index/`：当前可直接运行的首页
- `utils/api.js`：小程序侧请求封装
- `server.js`：后端 API
- `lib/policy.js`：2 秒和 1 小时冷却校验
- `lib/db.js`：轻量 JSON 存储
- `lib/composer.js`：日终 vlog 拼接计划，环境可用时会尝试 FFmpeg
- `public/`：旧网页原型
- `setlog/miniprogram/`：保留的历史小程序副本，当前以根目录入口为准

## 怎么跑

1. 启动后端：

```bash
cd setlog
npm run dev
```

2. 在微信开发者工具里导入仓库根目录 `/Volumes/PortableSSD/wechatSetlog`

3. 开发阶段使用本地 HTTP，`app.js` 里默认是 `http://127.0.0.1:3000`

4. 如果后端不在本机，把 `app.js` 里的 `baseUrl` 改成你的服务地址

## 页面能力

- 录制 2 秒视频并上传
- 创建 log
- 生成每日 vlog
- 查看时间线

## API

- `POST /api/auth/wechat-login`
- `GET /api/auth/session`
- `GET /api/users`
- `GET /api/users/me`
- `GET /api/users/:id`
- `GET /api/circles`
- `POST /api/circles`
- `POST /api/circles/:id/join`
- `GET /api/circles/:id/members`
- `PATCH /api/circles/:id/members/:userId`
- `DELETE /api/circles/:id/members/:userId`
- `GET /api/contents`
- `GET /api/bootstrap`
- `GET /api/logs`
- `POST /api/logs`
- `POST /api/log-members`
- `POST /api/upload-intents`
- `PUT /api/uploads/:uploadId`
- `POST /api/uploads/:uploadId`
- `GET /api/timeline`
- `POST /api/daily-vlogs/generate`
- `GET /api/daily-vlogs`

## 重要说明

- 小程序上传现在支持 `wx.uploadFile` 的 `multipart/form-data`，后端已经兼容。
- 生产环境里仍然建议把上传改成对象存储直传，把 `POST /api/uploads/:uploadId` 改成真正的 pre-signed URL。

## 下一步建议

1. 接入微信登录和用户体系
2. 接入对象存储直传，把 `POST /api/uploads/:uploadId` 改成真正的 pre-signed URL
3. 接入任务队列，把 `daily vlog` 生成改成异步 worker
4. 接入微信订阅消息，把“每小时提醒”补上
