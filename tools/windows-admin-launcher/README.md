# Windows Admin Launcher

这个目录提供一个简易 Windows 桌面启动器。它不会打包 OAuth、上游 API Key 或 Render Secret，只是连接已经部署好的外接网关。

最简单的用法：

```text
双击 AntigravityGatewayAdmin.bat
```

这个 `.bat` 会使用 Windows 自带 PowerShell 打开管理 GUI，不需要先安装 .NET SDK。

功能：

- 保存管理员域名、用户/API 域名；
- 可选地在本机用户配置目录保存 `GATEWAY_ADMIN_KEY`；
- 打开管理台或朋友门户；
- 复制朋友门户地址和 `/v1` API 地址；
- 填入网页管理台生成的朋友 API Key 后，打开或复制一键登录统计页；
- 调用 `/health` 和 `/api/admin/overview` 做连通性检查。

注意：有效的朋友 API Key 必须在网页管理台创建通道后由服务端生成。启动器里的“朋友短地址”可以随机生成，但如果没有在网页管理台创建对应通道，它只是一个地址草稿，不能直接登录。

如果仍然想生成独立 exe，可安装 .NET 8 SDK 后运行：

```powershell
cd tools\windows-admin-launcher
.\build.ps1
```

生成文件位于：

```text
tools\windows-admin-launcher\dist\AntigravityGatewayAdmin.exe
```

本机配置保存位置：

```text
%APPDATA%\AntigravityExternalGatewayAdmin\settings.json
```

如果勾选“在本机记住管理员 Key”，管理员 Key 会明文保存在该 Windows 用户的配置文件中。不要把这个配置文件发给朋友，也不要提交到 Git。
