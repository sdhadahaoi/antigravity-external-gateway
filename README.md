# Antigravity External Gateway

这是一个**独立于原始 `zeabur-antigravity-bridge` 的访问网关**。它部署在自己的 Render Web Service 上，对朋友发放可随时撤销、限量、限时、限频的外接 API Key；真正的 Antigravity OAuth/上游 API Key 始终只保存在网关服务的 Render 环境变量中。

外部用户只会看到网关生成的地址和自己的 Key，不会看到：

- 原始 Render 服务地址；
- `UPSTREAM_BRIDGE_API_KEY`；
- OAuth 凭证、刷新令牌或 Cookie；
- 管理员 Key；
- 其他用户的 Key、配额或日志。

## 架构

```text
朋友的客户端
    |  X-API-Key: egw_... / Authorization: Bearer egw_...
    v
本项目（独立 Render Gateway）
    |  验证外接 Key、配额、到期时间、频率和窗口选择
    |  使用仅存于 Render Secret 的 UPSTREAM_BRIDGE_API_KEY
    v
原 zeabur-antigravity-bridge（原 Render 服务）
    |  使用自己的 OAuth 凭证
    v
Antigravity
```

网关可为每个外接用户生成不同的 API 路径和 Key。路径只是网关的虚拟入口，例如：

```text
https://gateway.example.com/access/<随机通道 ID>/v1
```

该地址会转发到真实上游，但绝不是原服务地址的重定向或泄露。外接 Key 也不会等同于上游 Key。

## 凭证与窗口选择

原 bridge 中每个已经绑定账号的固定窗口都可以被映射为外接配置档案（profile）。管理员为某个朋友选择窗口后，网关只会把该朋友请求转发至对应的固定窗口路由。

- 可选择任意已配置并已绑定账号的窗口，例如 `w1` 到 `w50`；
- 管理员可禁用某个通道，或把一个外接 Key 重新指定到另一个窗口；
- 朋友不能从请求参数自行切换到未获授权的 profile。

因此，你可以明确指定「哪一个凭证/窗口」提供给外接用户。仍请注意：如果这些窗口背后是你的个人账号资源，应只分享给可信的人，并设置严格的配额和撤销策略。

## 管理界面能力

启动后使用 `GATEWAY_ADMIN_KEY` 登录管理界面。管理界面应提供：

- 一键随机生成外接 API Key 和随机虚拟端点；
- 创建、编辑、禁用、删除和轮换外接 Key；
- 选择任意已配置的账号窗口；
- 设置总 Token 上限、每次请求 Token 上限、开始/结束时间、每分钟请求数和并发数；
- 查看已用 token、剩余 token、请求次数、最近活动和估算 token；
- 查询调用日志（时间、Key、profile、模型、输入/输出 token、状态、失败原因）；
- 复制外接地址与示例请求；管理员 Key 和上游 Key 不会显示在页面中。

## 环境变量

在 Render 控制台的服务设置中填写以下变量。不要把真实值写入 Git、截图或前端配置。

| 变量 | 用途 | 推荐设置 |
| --- | --- | --- |
| `PORT` | Web Service 监听端口 | Render 自动注入；本地可设置为 `3000` |
| `GATEWAY_ADMIN_KEY` | 管理界面/API 的管理员密钥 | Render Blueprint 会随机生成；可在控制台轮换 |
| `UPSTREAM_BRIDGE_URL` | 原 `zeabur-antigravity-bridge` 的完整基础 URL | Render Secret，例：`https://...onrender.com` |
| `UPSTREAM_BRIDGE_API_KEY` | 原 bridge 所需的 API Key | Render Secret，绝不提交 |
| `GATEWAY_DATA_DIR` | 网关状态、配额和日志数据目录 | Render 中设为 `/var/data` |
| `GATEWAY_PUBLIC_BASE_URL` | 对外公布的网关基础 URL | 可留空；绑定自定义域名后填写 `https://api.example.com` |
| `GATEWAY_MAX_BODY_BYTES` | 单请求最大正文大小（字节） | 默认 `10485760`（10 MiB） |

`UPSTREAM_BRIDGE_URL` 和 `UPSTREAM_BRIDGE_API_KEY` 是唯一接触原服务的变量，应只在 Render 的 Environment 页面设置为 Secret。浏览器端、日志、JSON 导出和错误信息都不应回显它们。

## Render 部署

1. 将本目录作为一个独立 GitHub 仓库推送，例如 `antigravity-external-gateway`。不要把原 bridge 的 `.env`、OAuth 文件或 Render 配置复制进来。
2. 在 Render 选择 **New + -> Blueprint**，连接这个 GitHub 仓库并使用根目录的 `render.yaml`。
3. Render 会自动生成 `GATEWAY_ADMIN_KEY`。在服务的 Environment 页面手动填写 `UPSTREAM_BRIDGE_URL` 与 `UPSTREAM_BRIDGE_API_KEY`，并确认它们显示为 Secret。
4. 部署完成后，先用管理员 Key 进入管理界面，创建一个低配额、短有效期的测试 Key，再测试转发和日志。
5. 只把生成的虚拟端点和该朋友自己的外接 Key 发给朋友；不要发送 Render Dashboard、原服务 URL、管理员 Key 或任何 OAuth 信息。

### 持久化要求

外接 Key、token 用量、频率计数和使用日志需要跨重启保留。`render.yaml` 已挂载 `/var/data` Persistent Disk，并将 `GATEWAY_DATA_DIR` 指向它。

不要使用 Render Free 的临时文件系统保存这些数据：重启、重新部署或实例替换会导致配额与日志丢失。挂载磁盘的 Render 计划通常需要付费实例；如改用托管数据库，也必须把网关状态迁移到数据库后再移除磁盘。

### 自定义域名（可选）

Render 默认会提供一个 `onrender.com` 地址，已经足够作为对外网关入口。需要更稳定、易记的地址时，在 Render 服务的 **Custom Domains** 中绑定域名，例如 `api.example.com`，然后把：

```text
GATEWAY_PUBLIC_BASE_URL=https://api.example.com
```

设置为该公开地址。该变量只影响网关生成给朋友的虚拟地址，不会暴露上游地址。

## 本地运行

需要 Node.js 20 或更高版本：

```powershell
npm install
$env:PORT = "3000"
$env:GATEWAY_ADMIN_KEY = "change-this-before-use"
$env:UPSTREAM_BRIDGE_URL = "https://your-original-bridge.example"
$env:UPSTREAM_BRIDGE_API_KEY = "your-upstream-key"
$env:GATEWAY_DATA_DIR = ".\\data"
npm start
```

生产环境请使用 Render Secret，不要把这类变量保存进仓库。测试命令：

```powershell
npm test
```

## 安全边界

- 外接 Key 只应拥有转发调用权限，不能读取管理、配置或日志接口；
- 每个 Key 都应独立设置 profile、额度、有效期和频率，并可立即禁用；
- 转发失败时只返回通用错误，内部日志避免记录 `Authorization`、Cookie 和上游 URL；
- 管理员 Key 应高熵、独立保存并定期轮换；
- 原 bridge 的上游认证信息仅由 Render 服务端读取，绝不能传给浏览器或外部调用者。

这不是匿名化或绕过上游服务条款的工具。请确保你的分享方式、账号权限和实际用途符合 Antigravity、Render 及相关服务的使用条款。
