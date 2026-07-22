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
https://api.example.com/u/<朋友专属短地址>/v1
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

这里的“随机虚拟端点”指的是朋友专属短地址，例如 `/u/u_rm43p3oyjapo2jdl/`。整站域名必须来自 Render 默认域名或你已经绑定的自定义域名，不能随机生成一个互联网上真实可访问的新域名。创建通道时，服务端会真正生成可用的外接 API Key；管理弹窗会同时给出朋友控制台、API Base URL，以及可选的“一键登录统计页”链接。

## 两套界面

- 管理员界面：`https://admin.example.com/`。使用 `GATEWAY_ADMIN_KEY`，可创建/编辑/停用/轮换通道，选择任意已绑定账号的窗口，并查看全部通道的额度和日志。
- 用户界面：`https://api.example.com/u/<朋友专属短地址>/`。朋友使用自己的外接 API Key 登录，只能查看该通道的额度、有效期、模型、个人日志和 Token 预估，并可进行模型测试或最多三次总尝试的手动重试。管理员可在创建或编辑通道时自定义该短地址，或让网关生成一个不可预测的随机地址。

网页支持便捷登录：管理员可用 `https://admin.example.com/?key=<GATEWAY_ADMIN_KEY>` 打开后自动连接；朋友可用 `https://api.example.com/u/<朋友短地址>/?key=<朋友APIKey>` 打开后自动进入自己的统计页。页面会在登录后清理地址栏中的 Key，但这类链接仍会经过聊天记录、浏览器历史或代理日志，建议只发给非常信任的人；更稳妥的做法是分别发送朋友控制台地址和 API Key。

生产环境应使用两个不同的自定义域名，并将它们绑定到**同一个** Render Web Service：`admin.example.com` 仅提供管理员界面，`api.example.com` 仅提供用户门户和外接 API。创建通道后，管理后台生成并复制给朋友的地址固定为用户/API 域名，例如：

```text
朋友门户：https://api.example.com/u/u_9d7a2e6c4b18/
模型 API：https://api.example.com/u/u_9d7a2e6c4b18/v1
```

不要把管理员域名、管理员 Key 或 Render Dashboard 地址发给朋友。域名分离只是降低误发现的机会；管理员路由仍必须由服务端的管理员鉴权和主机路由限制保护，不能把地址保密当作权限控制。

用户界面不会返回窗口编号、上游地址、OAuth、管理员 Key、其他通道或修改入口。用户 Key 只保存在浏览器当前会话中；通道到期或停用后仍可查看自己的状态和历史，但不能继续调用模型。

## 环境变量

在 Render 控制台的服务设置中填写以下变量。不要把真实值写入 Git、截图或前端配置。

| 变量 | 用途 | 推荐设置 |
| --- | --- | --- |
| `PORT` | Web Service 监听端口 | Render 自动注入；本地可设置为 `3000` |
| `GATEWAY_ADMIN_KEY` | 管理界面/API 的管理员密钥 | Render Blueprint 会随机生成；可在控制台轮换 |
| `UPSTREAM_BRIDGE_URL` | 原 `zeabur-antigravity-bridge` 的完整基础 URL | Render Secret，例：`https://...onrender.com` |
| `UPSTREAM_BRIDGE_API_KEY` | 原 bridge 所需的 API Key | Render Secret，绝不提交 |
| `GATEWAY_DATA_DIR` | 网关状态、配额和日志数据目录 | Render 中设为 `/var/data` |
| `GATEWAY_ADMIN_BASE_URL` | 管理员界面的公开基础 URL | 生产环境填写 `https://admin.example.com` |
| `GATEWAY_USER_BASE_URL` | 用户门户和外接 API 的公开基础 URL | 生产环境填写 `https://api.example.com`；新建通道的门户/API 地址由此生成 |
| `GATEWAY_PUBLIC_BASE_URL` | 旧版单一公开基础 URL 的兼容回退 | 新部署不建议设置；仅在尚未拆分域名的旧部署中使用 |
| `GATEWAY_MAX_BODY_BYTES` | 单请求最大正文大小（字节） | 代码默认 `2097152`（2 MiB）；`render.yaml` 示例显式设为 `10485760`（10 MiB） |
| `GATEWAY_MAX_PENDING_BODY_READS` | 未配置通道并发上限时，单通道最多同时读取的请求正文数 | 默认 `2` |

`UPSTREAM_BRIDGE_URL` 和 `UPSTREAM_BRIDGE_API_KEY` 是唯一接触原服务的变量，应只在 Render 的 Environment 页面设置为 Secret。浏览器端、日志、JSON 导出和错误信息都不应回显它们。

URL 选择顺序如下：`GATEWAY_ADMIN_BASE_URL` 和 `GATEWAY_USER_BASE_URL` 分别优先用于管理员与用户/API 两个界面；缺少其中任一个时，才使用 `GATEWAY_PUBLIC_BASE_URL` 作为该界面的兼容回退；三个变量都未设置时，服务仅在本地或临时场景从当前请求推断地址。要获得真正分离的两个外部地址，生产环境必须同时设置前两个变量。

## Render 部署

1. 将本目录作为一个独立 GitHub 仓库推送，例如 `antigravity-external-gateway`。不要把原 bridge 的 `.env`、OAuth 文件或 Render 配置复制进来。
2. 在 Render 选择 **New + -> Blueprint**，连接这个 GitHub 仓库并使用根目录的 `render.yaml`。
3. Render 会自动生成 `GATEWAY_ADMIN_KEY`。在服务的 Environment 页面手动填写 `UPSTREAM_BRIDGE_URL` 与 `UPSTREAM_BRIDGE_API_KEY`，并确认它们显示为 Secret。
4. 部署完成后，先用管理员 Key 进入管理界面，创建一个低配额、短有效期的测试 Key，再测试转发和日志。
5. 只把生成的虚拟端点和该朋友自己的外接 Key 发给朋友；不要发送 Render Dashboard、原服务 URL、管理员 Key 或任何 OAuth 信息。

### 持久化要求

外接 Key、token 用量、频率计数和使用日志需要跨重启保留。`render.yaml` 已挂载 `/var/data` Persistent Disk，并将 `GATEWAY_DATA_DIR` 指向它。

不要使用 Render Free 的临时文件系统保存这些数据：重启、重新部署或实例替换会导致配额与日志丢失。挂载磁盘的 Render 计划通常需要付费实例；如改用托管数据库，也必须把网关状态迁移到数据库后再移除磁盘。

### 双自定义域名

在同一个 Render 服务的 **Custom Domains** 中添加并验证两个域名：

1. `admin.example.com`：只用于管理员登录和管理 API；
2. `api.example.com`：只用于朋友门户和外接 API。

随后在该服务的 Environment 页面设置：

```text
GATEWAY_ADMIN_BASE_URL=https://admin.example.com
GATEWAY_USER_BASE_URL=https://api.example.com
```

两个域名仍指向同一个 Render 服务和同一份持久化数据，不需要创建两台服务，也不会复制 OAuth 或上游配置。管理员在 `https://admin.example.com/` 创建通道后，网关会只生成 `https://api.example.com/u/<朋友专属短地址>/...` 形式的朋友门户与 API 地址。短地址可由管理员指定，也可留空让服务端随机生成；服务端会拒绝重复短地址。旧版只有一个域名时，可暂时只设置 `GATEWAY_PUBLIC_BASE_URL`；这会让两个界面共用同一基础地址，不能提供域名级隔离。

## 本地运行

需要 Node.js 20 或更高版本：

```powershell
npm install
$env:PORT = "3000"
$env:GATEWAY_ADMIN_KEY = "change-this-before-use"
$env:GATEWAY_ADMIN_BASE_URL = "http://127.0.0.1:3000"
$env:GATEWAY_USER_BASE_URL = "http://127.0.0.1:3000"
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

## Windows 桌面启动器

`tools/windows-admin-launcher/` 中提供了一个简易 Windows 管理启动器。它不会打包 OAuth、上游 API Key 或 Render Secret，只连接已经部署好的外接网关。

最简单的方式是直接双击：

```text
tools\windows-admin-launcher\AntigravityGatewayAdmin.bat
```

这个 `.bat` 使用 Windows 自带 PowerShell 打开 GUI，不需要先安装 .NET SDK。

可用于：

- 保存管理员域名和用户/API 域名；
- 可选地在本机保存 `GATEWAY_ADMIN_KEY`；
- 打开管理台和朋友门户；
- 复制朋友门户地址和 `/v1` API 地址；
- 检查 `/health` 与管理员概览接口。

如果仍然想生成独立 exe，可安装 .NET 8 SDK 后运行：

```powershell
cd tools\windows-admin-launcher
.\build.ps1
```

生成文件位于 `tools/windows-admin-launcher/dist/AntigravityGatewayAdmin.exe`。不要把本机生成的配置文件或管理员 Key 发给朋友。

## 部署后的两个网址怎么来

Render 只需要创建**一个** Web Service，但建议绑定**两个不同的自定义域名**到同一个服务：

```text
管理员网址：https://admin.example.com/
用户/API 网址：https://api.example.com/
```

在 Render 的 Environment 页面中填：

```text
GATEWAY_ADMIN_BASE_URL=https://admin.example.com
GATEWAY_USER_BASE_URL=https://api.example.com
```

这样管理后台创建通道后，生成给朋友的地址会是：

```text
朋友控制台：https://api.example.com/u/<朋友短地址>/
API Base URL：https://api.example.com/u/<朋友短地址>/v1
```

管理员自己访问：

```text
https://admin.example.com/
```

如果暂时没有自定义域名，也可以先用 Render 默认的 `https://xxx.onrender.com` 跑通流程：

```text
管理员：https://xxx.onrender.com/
朋友：https://xxx.onrender.com/u/<朋友短地址>/
API：https://xxx.onrender.com/u/<朋友短地址>/v1
```

但这种单域名模式下，用户理论上能猜到同一个站点的根路径，所以正式给朋友使用时更推荐双域名。双域名模式下，用户域名访问管理接口会返回 404，管理员域名访问用户接口也会返回 404。
