# APIGate — AI 图像生成网关服务

> 一套完整的 AI 图像生成网关平台，提供文生图、图生图能力，以及用户管理、余额计费、队列调度、日志查询等功能。支持多个上游图像生成 API 接入。

---

## 目录

- [功能概览](#功能概览)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [环境变量说明](#环境变量说明)
- [启动方式](#启动方式)
- [详细使用说明](#详细使用说明)
  - [用户注册与登录](#用户注册与登录)
  - [文生图（Text to Image）](#文生图text-to-image)
  - [图生图（Image to Image）](#图生图image-to-image)
  - [图片上传](#图片上传)
  - [任务状态查询](#任务状态查询)
  - [余额查询](#余额查询)
  - [提示词模板](#提示词模板)
  - [批量下载（ZIP）](#批量下载zip)
- [管理员操作说明](#管理员操作说明)
  - [用户管理](#用户管理)
  - [余额充值](#余额充值)
  - [API Key 配置](#api-key-配置)
  - [队列配置](#队列配置)
- [日志查询服务（12004）](#日志查询服务12004)
- [支持的上游模型](#支持的上游模型)
- [运行时目录说明](#运行时目录说明)
- [数据文件说明](#数据文件说明)
- [注意事项](#注意事项)

---

## 功能概览

| 功能模块 | 说明 |
|----------|------|
| 🎨 文生图 | 根据提示词调用上游 AI 接口生成图片 |
| 🖼️ 图生图 | 上传参考图进行风格迁移或局部编辑 |
| 👤 用户系统 | 注册（需邀请码）、登录、Token 鉴权 |
| 🔑 管理员面板 | 用户管理、API Key 配置、队列调度 |
| 💰 余额计费 | 按图计费，生成失败自动退款 |
| 📝 提示词模板 | 预设模板管理，支持文生图/图生图两种模式 |
| 📊 日志查询（12004） | 分页查询生成记录，支持成功率/消耗统计 |
| 📦 批量下载 | 将生成结果打包为 ZIP 文件下载 |
| 🗜️ 图片压缩 | 上传时自动压缩超大图片（最大边 1920px） |
| 🔗 图片代理 | 代理下载外部图片 URL，解决跨域问题 |
| 📂 图片归档 | 生成结果自动下载并归档到本地 |
| ⚡ 并发队列 | Sub2 接口支持多并发队列调度（最多 20 并发） |
| 🔄 自动重试 | Agnes 接口支持失败自动重试（指数退避） |

---

## 技术栈

| 组件 | 版本 / 说明 |
|------|------------|
| Node.js | 20 LTS |
| Express | 5.x（主服务 12003） |
| http 模块 | 原生（查询服务 12004，无额外依赖） |
| sharp | 图片压缩、格式转换、尺寸调整 |
| axios | 调用上游 AI API，支持重试 |
| multer | multipart/form-data 文件上传 |
| cors | 跨域资源共享 |
| crypto | Token 生成、密码 MD5 哈希 |
| Docker | 容器化部署 |
| Docker Compose | 双服务编排 |
| 数据存储 | 本地 JSON 文件，无需数据库 |

---

## 目录结构

```
APIGate/
├── server.js                  # 主服务（端口 12003）
├── query-server.js            # 查询服务（端口 12004）
├── public/
│   └── index.html             # 前端单页应用
├── Dockerfile                 # 12003 服务镜像（Node 20 Alpine）
├── log-query-Dockerfile       # 12004 服务镜像（可选）
├── docker-compose.yml         # 双服务本地编排
├── .env.example               # 环境变量模板
├── package.json               # 依赖声明
└── runtime/                   # 运行时数据目录（首次启动自动创建）
    ├── data/                  # 用户、余额、Token、API Key、配置
    ├── logs/                  # 生成日志、接口响应日志
    ├── uploads/               # 用户上传的参考图片
    ├── results/               # 生成结果图片（部分接口）
    └── archive/               # 归档结果图（按用户/日期分类）
```

---

## 快速开始

### 1. 克隆项目

```bash
git clone <仓库地址>
cd APIGate
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，**必须修改以下两项**：

```env
ADMIN_PASSWORD=你的管理员密码（至少4个字符）
INVITE_CODE=你的邀请码（用户注册时需填写）
```

### 3. 启动服务

```bash
docker compose up -d --build
```

### 4. 首次配置

1. 访问 `http://localhost:12003`，用管理员账号（`admin` / 你设置的密码）登录
2. 进入 **管理员面板 → API Key 管理**，填写一个或多个上游 AI 服务的 API Key
3. 进入 **管理员面板 → 用户管理**，为需要使用的账号充值余额并**启用账户**（新注册账户默认禁用）
4. 即可开始生成图片

---

## 环境变量说明

| 变量名 | 默认值 | 必改 | 说明 |
|--------|--------|:----:|------|
| `PORT` | `12003` | | 主服务监听端口 |
| `APP_PUBLIC_BASE` | `http://localhost:12003` | | 对外访问的公网基础 URL，影响归档图片 URL 的拼接 |
| `APP_12003_BASE_URL` | `http://localhost:12003` | | 12004 服务访问 12003 的内部地址 |
| `ADMIN_USERNAME` | `admin` | | 管理员用户名 |
| `ADMIN_PASSWORD` | `change-me-now` | ✅ | 管理员密码（首次启动创建管理员账号） |
| `INVITE_CODE` | `CHANGE_ME_INVITE_CODE` | ✅ | 用户自助注册时填写的邀请码 |
| `DATA_DIR` | `./runtime/data` | | 数据文件根目录 |
| `LOG_DIR` | `./runtime/logs` | | 日志文件根目录 |
| `UPLOADS_DIR` | `./runtime/uploads` | | 用户上传图片目录 |
| `RESULTS_DIR` | `./runtime/results` | | 生成结果图目录 |
| `ARCHIVE_BASE` | `./runtime/archive` | | 归档目录根路径 |
| `IO_DATA_DIR` | `./runtime/data` | | 12004 服务读取数据的目录（与 12003 共享） |
| `IO_LOG_DIR` | `./runtime/logs` | | 12004 服务读取日志的目录（与 12003 共享） |
| `SYNC_12005_URL` | （空） | | 可选：从远端 12005 服务同步日志的 URL |

> **生产环境提示**：部署到公网时，`APP_PUBLIC_BASE` 需改为实际域名，例如 `https://img.example.com`

---

## 启动方式

### Docker Compose（推荐）

```bash
# 首次构建并启动（后台运行）
docker compose up -d --build

# 查看运行状态
docker compose ps

# 实时查看所有服务日志
docker compose logs -f

# 只查看主服务日志
docker compose logs -f app12003

# 停止服务（保留数据）
docker compose down

# 停止并删除所有数据卷
docker compose down -v
```

**访问地址：**

| 服务 | 地址 |
|------|------|
| 主服务（图像生成 / 用户管理） | http://localhost:12003 |
| 日志查询服务 | http://localhost:12004 |

---

### Node.js 本地启动

**安装依赖：**

```bash
npm install
```

**启动 12003 主服务（终端 1）：**

```bash
npm run start:12003
# 等效于：node server.js
```

**启动 12004 查询服务（终端 2）：**

PowerShell：
```powershell
$env:IO_DATA_DIR="./runtime/data"
$env:IO_LOG_DIR="./runtime/logs"
$env:APP_12003_BASE_URL="http://localhost:12003"
npm run start:12004
```

Linux / macOS / Git Bash：
```bash
IO_DATA_DIR=./runtime/data \
IO_LOG_DIR=./runtime/logs \
APP_12003_BASE_URL=http://localhost:12003 \
npm run start:12004
```

---

## 详细使用说明

所有 API 请求均发往主服务 `http://localhost:12003`，除特别标注外。

### 用户注册与登录

#### 自助注册

```http
POST /api/register
Content-Type: application/json

{
  "username": "alice",
  "password": "mypassword",
  "inviteCode": "你设置的INVITE_CODE"
}
```

响应：
```json
{
  "token": "xxxxxxxxxxxxxxxx",
  "username": "alice",
  "role": "user"
}
```

> ⚠️ 注册后账户默认**禁用**，需管理员在面板中手动启用并充值余额后才能使用。

---

#### 登录

```http
POST /api/login
Content-Type: application/json

{
  "username": "alice",
  "password": "mypassword"
}
```

响应：
```json
{
  "token": "xxxxxxxxxxxxxxxx",
  "username": "alice",
  "role": "user"
}
```

保存返回的 `token`，后续所有需要鉴权的请求都需要在 Header 中携带：

```http
Authorization: Bearer <token>
```

---

#### 获取当前用户信息

```http
GET /api/me
Authorization: Bearer <token>
```

响应：
```json
{
  "username": "alice",
  "role": "user",
  "balance": 10.00,
  "enabled": true,
  "totalCalls": 42,
  "successCalls": 40
}
```

---

#### 退出登录

```http
POST /api/logout
Authorization: Bearer <token>
```

---

### 文生图（Text to Image）

```http
POST /api/generate
Authorization: Bearer <token>
Content-Type: application/json

{
  "prompt": "A cute cat sitting on a wooden table, professional product photography, white background",
  "model": "gpt-image-2-sub2",
  "size": "1024x1024",
  "count": 1
}
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `prompt` | string | ✅ | 图片描述提示词（建议英文，Agnes 接口支持中文自动翻译） |
| `model` | string | | 使用的模型，默认 `gpt-image-2-sub2`，见[支持的上游模型](#支持的上游模型) |
| `size` | string | | 输出尺寸，如 `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048` |
| `count` | number | | 生成数量（1-4，默认 1，仅部分模型支持多图） |

**响应（立即返回任务 ID）：**

```json
{
  "success": true,
  "localId": "gen_1720000000000_abc",
  "status": "pending",
  "message": "任务已提交，请通过 /api/task-status 查询结果"
}
```

---

### 图生图（Image to Image）

```http
POST /api/generate
Authorization: Bearer <token>
Content-Type: application/json

{
  "prompt": "Make the background pure white, keep the product unchanged",
  "model": "gpt-image-2-sub2",
  "size": "1024x1024",
  "images": ["/uploads/filename.jpg"]
}
```

**额外参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `images` | array | 参考图路径数组（先通过 `/api/upload` 上传，获取路径后填入；也支持外部 URL 或 base64 data URI） |

---

### 图片上传

上传参考图，获取路径后可用于图生图。上传时自动压缩超过最大边 1920px 的图片。

```http
POST /api/upload
Authorization: Bearer <token>
Content-Type: multipart/form-data

image: <文件>
```

响应：
```json
{
  "success": true,
  "url": "/uploads/1720000000000-image.jpg",
  "filename": "1720000000000-image.jpg",
  "size": 204800,
  "compression": {
    "compressed": true,
    "originalSize": 5242880,
    "compressedSize": 204800,
    "originalMaxSide": 4096,
    "finalMaxSide": 1920
  }
}
```

---

### 任务状态查询

生成任务为异步执行，提交后需轮询状态接口：

```http
GET /api/task-status?localId=gen_1720000000000_abc
Authorization: Bearer <token>
```

响应示例：

**生成中：**
```json
{
  "status": "pending",
  "queueStatus": "queued",
  "queuePosition": 2
}
```

**成功：**
```json
{
  "status": "success",
  "resultUrls": [
    "/archive/alice/20240701/alice_Sub2接口_1720000000000.jpg"
  ],
  "completedAt": "2024-07-01T10:00:30.000Z"
}
```

**失败：**
```json
{
  "status": "error",
  "error": "上游服务暂时不可用，请稍后重试",
  "statusCode": 503
}
```

> **推荐轮询间隔：** 每 3-5 秒查询一次，前端可设置最长等待 10 分钟（超时后任务自动标记失败并退款）。

---

### 余额查询

```http
GET /api/me
Authorization: Bearer <token>
```

返回字段中的 `balance` 即为当前余额（单位：元）。

**提前检查余额是否足够（防止扣款失败）：**

```http
POST /api/check-balance
Authorization: Bearer <token>
Content-Type: application/json

{
  "count": 4,
  "unitPrice": 0.025
}
```

响应：
```json
{
  "ok": true,
  "balance": 10.00,
  "required": 0.100,
  "remaining": 9.900
}
```

---

### 提示词模板

获取预设的提示词列表（用于快速填入 prompt）：

```http
GET /api/prompts
Authorization: Bearer <token>
```

响应：
```json
{
  "prompts": [
    {
      "name": "产品图优化",
      "mode": "dual",
      "prompt": "Enhance this product image with professional lighting, clean white background..."
    },
    {
      "name": "海报设计",
      "mode": "single",
      "prompt": "Create a visually striking promotional poster with bold typography..."
    }
  ]
}
```

> `mode: "dual"` 表示同时支持文生图和图生图；`mode: "single"` 仅支持文生图。

---

### 批量下载（ZIP）

将多张生成结果图打包成 ZIP 下载：

```http
POST /api/download-zip
Authorization: Bearer <token>
Content-Type: application/json

{
  "urls": [
    "/archive/alice/20240701/image1.jpg",
    "/archive/alice/20240701/image2.jpg"
  ]
}
```

响应为 `application/zip` 二进制流，浏览器会自动触发下载。

---

### 图片代理下载

将外部 URL 的图片通过服务端代理返回（解决前端跨域问题）：

```http
GET /api/proxy-download?url=https://example.com/image.jpg
```

---

## 管理员操作说明

所有管理员接口需使用具有 `admin` 角色的账号 Token，请求头携带：
```http
Authorization: Bearer <admin_token>
```

---

### 用户管理

**查询所有用户：**

```http
GET /api/admin/users
Authorization: Bearer <admin_token>
```

响应：
```json
{
  "users": [
    {
      "username": "alice",
      "role": "user",
      "balance": 10.00,
      "enabled": true,
      "totalCalls": 42,
      "successCalls": 40,
      "totalSpent": 1.050,
      "createdAt": "2024-07-01T08:00:00.000Z",
      "lastCall": "2024-07-01T10:00:00.000Z"
    }
  ]
}
```

**创建用户（管理员直接创建，无需邀请码）：**

```http
POST /api/admin/users
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "username": "bob",
  "password": "bobpassword"
}
```

**启用 / 禁用用户：**

```http
POST /api/admin/users/alice/toggle
Authorization: Bearer <admin_token>
```

> 新注册用户默认禁用，必须由管理员启用后才能调用生成接口。

**删除用户：**

```http
DELETE /api/admin/users/alice
Authorization: Bearer <admin_token>
```

**重置用户统计数据：**

```http
POST /api/admin/users/alice/reset-stats
Authorization: Bearer <admin_token>
```

---

### 余额充值

**为用户充值（或扣款）：**

```http
POST /api/admin/users/alice/recharge
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "amount": 10.00
}
```

> `amount` 为正数时充值，为负数时扣款。充值记录会保存在 `recharge_logs.json` 中（最近 500 条）。

**查询充值记录：**

```http
GET /api/admin/recharge-logs
Authorization: Bearer <admin_token>
```

---

### API Key 配置

系统支持多个上游接口，分别配置各自的 API Key：

**Sub2 接口（默认，推荐）：**
```http
POST /api/admin/sub2-apikey
Authorization: Bearer <admin_token>
Content-Type: application/json

{ "apiKey": "sk-xxxx" }
```

**贞贞接口（gpt-image-2）：**
```http
POST /api/admin/zhenzhen-apikey
Authorization: Bearer <admin_token>
Content-Type: application/json

{ "apiKey": "sk-xxxx" }
```

**漫小白接口（gpt-image-2-manxiaobai）：**
```http
POST /api/admin/manxiaobai-apikey
Authorization: Bearer <admin_token>
Content-Type: application/json

{ "apiKey": "sk-xxxx" }
```

**Agnes 接口（agnes-image-2.1-flash，支持中文 prompt）：**
```http
POST /api/admin/agnes-apikey
Authorization: Bearer <admin_token>
Content-Type: application/json

{ "apiKey": "sk-xxxx" }
```

> Agnes 接口支持配置多个 Key（每行一个），系统会自动做速率限制轮转（每 Key 每分钟最多 18 次请求）。

---

### 队列配置

Sub2 接口支持并发队列，可调整并发数和超时时间：

**查询当前队列状态：**

```http
GET /api/admin/sub2-queue-config
Authorization: Bearer <admin_token>
```

响应：
```json
{
  "config": {
    "maxConcurrent": 3,
    "runningTimeoutMs": 180000
  },
  "status": {
    "queued": 2,
    "running": 3
  }
}
```

**修改队列配置：**

```http
POST /api/admin/sub2-queue-config
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "maxConcurrent": 5,
  "timeoutSeconds": 300
}
```

| 参数 | 范围 | 默认值 | 说明 |
|------|------|--------|------|
| `maxConcurrent` | 1-20 | 3 | 最大并发数 |
| `timeoutSeconds` | 30-3600 | 180 | 单任务超时时间（秒） |

---

### 提示词模板管理

```http
POST /api/admin/prompts
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "prompts": [
    {
      "name": "白底图",
      "mode": "dual",
      "prompt": "Clean white background, professional product photography, even studio lighting"
    }
  ]
}
```

> 传入空数组 `[]` 时重置为系统默认模板。

---

## 日志查询服务（12004）

12004 是一个独立的日志查询服务，使用与 12003 相同的用户认证系统，通过浏览器访问 `http://localhost:12004`。

### 前端页面

| 路径 | 功能 |
|------|------|
| `http://localhost:12004/` | 日志列表主页（登录后访问） |
| `http://localhost:12004/login` | 登录页 |
| `http://localhost:12004/consumption` | 消耗统计页（仅管理员） |

### 日志查询 API

**分页查询生成日志：**

```http
GET /api/logs?page=1&pageSize=20&status=success
X-Token: <token>
```

支持的查询参数：

| 参数 | 说明 |
|------|------|
| `page` | 页码（默认 1） |
| `pageSize` | 每页条数（默认 20） |
| `id` | 按任务 ID 或 API 请求 ID 搜索（支持模糊匹配） |
| `status` | 按状态过滤：`success` / `error` / `pending` |
| `model` | 按模型过滤：如 `gpt-image-2-sub2` |
| `prompt` | 按提示词关键词搜索 |
| `error` | 按错误信息关键词搜索 |
| `user` | 按用户名过滤（仅管理员可用） |

**查询单条日志详情：**

```http
GET /api/log-detail?id=gen_1720000000000_abc
X-Token: <token>
```

**获取统计汇总：**

```http
GET /api/stats
X-Token: <token>
```

响应包含：总请求数、成功数、失败数、进行中数量、按模型分组的成功率和平均耗时。

**消耗统计（仅管理员）：**

```http
GET /api/consumption?startDate=2024-07-01&endDate=2024-07-31
X-Token: <token>
```

返回按日期和按用户分组的 API 消耗金额，以及充值记录汇总。

---

## 支持的上游模型

| 模型标识 | 上游接口 | 单价（元/张） | 特性 |
|----------|---------|:------------:|------|
| `gpt-image-2-sub2` | Sub2 接口（默认） | ¥0.025 | 支持并发队列、多图生成 |
| `gpt-image-2` | 贞贞接口 | ¥0.054 | 高质量，返回 URL |
| `gpt-image-2-manxiaobai` | 漫小白接口 | ¥0.055~0.077 | 按分辨率阶梯定价 |
| `gpt-image-2-flatfee` | 6789 接口 | ¥0.035 | 固定价 |
| `agnes-image-2.1-flash` | Agnes 接口 | ¥0.010 | 支持中文 prompt 自动翻译、Key 池轮转 |

> **漫小白接口定价说明：**
> - 最大边 ≤ 1024px：¥0.055/张
> - 最大边 1025-2048px：¥0.066/张
> - 最大边 > 2048px：¥0.077/张

---

## 运行时目录说明

所有运行时数据保存在 `runtime/` 目录，Docker 挂载后容器重启数据持久保存：

```
runtime/
├── data/                     # 结构化数据（JSON 文件）
│   ├── users.json            # 用户账号信息
│   ├── tokens.json           # 登录 Token 映射
│   ├── balances.json         # 用户余额
│   ├── stats.json            # 调用统计
│   ├── prompts.json          # 提示词模板
│   ├── recharge_logs.json    # 充值记录（最近 500 条）
│   ├── apikey.txt            # 默认 API Key
│   ├── zhenzhen_apikey.txt   # 贞贞接口 Key
│   ├── manxiaobai_apikey.txt # 漫小白接口 Key
│   ├── sub2_apikey.txt       # Sub2 接口 Key
│   ├── agnes_apikey.txt      # Agnes 接口 Key（支持多行多 Key）
│   └── sub2_queue_config.json # Sub2 队列配置
├── logs/
│   ├── generate-log.json     # 生成任务日志（JSON 数组，append-only）
│   ├── api-responses.log     # API 接口响应日志（JSONL 格式）
│   └── requests.log          # 请求文本日志
├── uploads/                  # 用户上传的参考图片
├── results/                  # 部分接口的结果图（URL 形式返回时不使用）
└── archive/                  # 生成结果归档
    └── {username}/
        └── {yyyyMMdd}/       # 按日期分目录
            └── *.jpg / *.png / *.webp
```

---

## 数据文件说明

### generate-log.json 字段

| 字段 | 说明 |
|------|------|
| `id` | 本地任务 ID（唯一标识） |
| `user` | 发起用户名 |
| `model` | 使用的模型标识 |
| `prompt` | 提示词（最多 300 字符） |
| `status` | `pending` / `success` / `error` |
| `submittedAt` | 提交时间（ISO 8601） |
| `completedAt` | 完成时间 |
| `resultUrls` | 结果图 URL 数组 |
| `archiveUrls` | 归档本地路径数组 |
| `error` | 错误信息（失败时） |
| `statusCode` | 上游响应状态码 |
| `queueStatus` | 队列状态：`queued` / `running` / `done` |

---

## 注意事项

1. **密码存储**：使用 MD5 哈希存储密码（适合内网/私有部署场景），不建议在公网直接暴露。
2. **Token 安全**：登录 Token 为随机 64 位十六进制字符串，存储在 `tokens.json` 文件中，重启服务不失效。
3. **日志持久化**：`generate-log.json` 持续追加，长期运行后文件较大，建议定期归档清理旧记录。
4. **余额精度**：余额保留 2 位小数，单次消耗保留 3 位小数，失败任务自动退款。
5. **图片过期**：上游返回 URL 形式的图片通常数天后失效，系统会自动尝试下载归档到本地。
6. **超时处理**：超过 10 分钟未返回结果的 pending 任务会自动标记为失败并退款。
7. **生产部署**：建议在前端加 Nginx/Caddy 反向代理，配置 HTTPS 和访问限制。

---

## License

ISC
