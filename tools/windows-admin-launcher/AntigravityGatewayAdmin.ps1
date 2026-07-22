param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($Check) {
  Write-Output "AntigravityGatewayAdmin.ps1 语法检查通过"
  return
}

$configDir = Join-Path $env:APPDATA "AntigravityExternalGatewayAdmin"
$configPath = Join-Path $configDir "settings.json"

function Normalize-BaseUrl {
  param([string]$Value)
  $raw = ($Value + "").Trim().TrimEnd("/")
  if (-not $raw) { return "" }
  try {
    $uri = [Uri]$raw
    if ($uri.Scheme -ne "http" -and $uri.Scheme -ne "https") { return "" }
    return $uri.GetLeftPart([System.UriPartial]::Authority)
  } catch {
    return ""
  }
}

function Test-Slug {
  param([string]$Value)
  return (($Value + "") -match "^[a-z0-9][a-z0-9_-]{2,63}$")
}

function New-RandomSlug {
  $alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $suffix = ""
  foreach ($byte in $bytes) {
    $suffix += $alphabet[$byte % $alphabet.Length]
  }
  return "u_$suffix"
}

function Open-Url {
  param([string]$Url)
  Start-Process $Url
}

function Set-Status {
  param([string]$Text)
  $statusBox.Text = ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Text)
}

function New-Label {
  param([string]$Text)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.AutoSize = $true
  $label.Margin = New-Object System.Windows.Forms.Padding(0, 8, 8, 0)
  return $label
}

function New-TextBox {
  param([string]$Placeholder)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Width = 500
  $box.Margin = New-Object System.Windows.Forms.Padding(0, 5, 0, 0)
  try { $box.PlaceholderText = $Placeholder } catch {}
  return $box
}

function Add-Row {
  param(
    [System.Windows.Forms.TableLayoutPanel]$Grid,
    [string]$Label,
    [System.Windows.Forms.Control]$Control
  )
  [void]$Grid.Controls.Add((New-Label $Label))
  [void]$Grid.Controls.Add($Control)
}

function New-Button {
  param(
    [string]$Text,
    [scriptblock]$OnClick
  )
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.AutoSize = $true
  $button.Padding = New-Object System.Windows.Forms.Padding(10, 5, 10, 5)
  $button.Margin = New-Object System.Windows.Forms.Padding(0, 0, 8, 8)
  [void]$button.Add_Click($OnClick)
  return $button
}

function Get-FriendPortalUrl {
  $userUrl = Normalize-BaseUrl $userBaseUrlBox.Text
  $slug = ($friendSlugBox.Text + "").Trim().ToLowerInvariant()
  if (-not $userUrl) {
    Set-Status "请先填写用户/API 网址。"
    return ""
  }
  if (-not (Test-Slug $slug)) {
    Set-Status "朋友短地址必须是 3-64 位：小写字母、数字、连字符或下划线，并以字母/数字开头。"
    return ""
  }
  return "$userUrl/u/$([Uri]::EscapeDataString($slug))/"
}

function Get-ApiBaseUrl {
  $portal = Get-FriendPortalUrl
  if (-not $portal) { return "" }
  return "${portal}v1"
}

function Copy-Text {
  param([string]$Text)
  if (-not $Text) { return }
  [System.Windows.Forms.Clipboard]::SetText($Text)
  Set-Status "已复制：`r`n$Text"
}

function Save-Config {
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $config = [ordered]@{
    adminBaseUrl = Normalize-BaseUrl $adminBaseUrlBox.Text
    userBaseUrl = Normalize-BaseUrl $userBaseUrlBox.Text
    rememberAdminKey = [bool]$rememberKeyBox.Checked
    adminKey = ""
  }
  if ($rememberKeyBox.Checked) {
    $config.adminKey = ($adminKeyBox.Text + "").Trim()
  }
  $config | ConvertTo-Json | Set-Content -Encoding UTF8 -Path $configPath
  if ($rememberKeyBox.Checked) {
    Set-Status "设置已保存。管理员 Key 只保存在当前 Windows 用户配置目录。"
  } else {
    Set-Status "设置已保存。管理员 Key 未写入磁盘。"
  }
}

function Load-Config {
  if (-not (Test-Path $configPath)) { return }
  try {
    $config = Get-Content -Raw -Path $configPath | ConvertFrom-Json
    $adminBaseUrlBox.Text = $config.adminBaseUrl
    $userBaseUrlBox.Text = $config.userBaseUrl
    $rememberKeyBox.Checked = [bool]$config.rememberAdminKey
    if ($rememberKeyBox.Checked) {
      $adminKeyBox.Text = $config.adminKey
    }
  } catch {
    Set-Status ("读取设置失败：" + $_.Exception.Message)
  }
}

function Invoke-HealthCheck {
  $adminUrl = Normalize-BaseUrl $adminBaseUrlBox.Text
  if (-not $adminUrl) {
    Set-Status "请先填写管理员网址。"
    return
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$adminUrl/health" -TimeoutSec 20
    Set-Status ("健康检查通过：HTTP " + [int]$response.StatusCode)
  } catch {
    Set-Status ("健康检查失败：" + $_.Exception.Message)
  }
}

function Invoke-Overview {
  $adminUrl = Normalize-BaseUrl $adminBaseUrlBox.Text
  $adminKey = ($adminKeyBox.Text + "").Trim()
  if (-not $adminUrl -or -not $adminKey) {
    Set-Status "请先填写管理员网址和管理员 Key。"
    return
  }
  try {
    $headers = @{ Authorization = "Bearer $adminKey" }
    $overview = Invoke-RestMethod -Uri "$adminUrl/api/admin/overview" -Headers $headers -TimeoutSec 30
    $channelCount = @($overview.channels).Count
    $accountCount = @($overview.accounts).Count
    $modelCount = @($overview.models).Count
    $upstream = "否"
    if ($overview.config.upstream_configured) { $upstream = "是" }
    Set-Status "概览读取成功。`r`n外接通道：$channelCount`r`n可用凭证窗口：$accountCount`r`n可用模型：$modelCount`r`n上游已配置：$upstream"
  } catch {
    Set-Status ("读取概览失败：" + $_.Exception.Message)
  }
}

function Open-AdminPortal {
  $adminUrl = Normalize-BaseUrl $adminBaseUrlBox.Text
  if (-not $adminUrl) {
    Set-Status "请先填写管理员网址。"
    return
  }
  $adminKey = ($adminKeyBox.Text + "").Trim()
  if ($adminKey) {
    [System.Windows.Forms.Clipboard]::SetText($adminKey)
    Set-Status "管理员 Key 已复制到剪贴板。打开管理台后请粘贴登录。"
  } else {
    Set-Status "正在打开管理台。"
  }
  Open-Url "$adminUrl/"
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Antigravity 外接网关管理器"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(760, 560)
$form.MinimumSize = New-Object System.Drawing.Size(680, 500)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = "Fill"
$root.Padding = New-Object System.Windows.Forms.Padding(18)
$root.ColumnCount = 1
$root.RowCount = 5
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
[void]$form.Controls.Add($root)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Antigravity 外接网关管理器"
$title.AutoSize = $true
$title.Font = New-Object System.Drawing.Font($form.Font.FontFamily, 15, [System.Drawing.FontStyle]::Bold)
$title.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 14)
[void]$root.Controls.Add($title)

$settingsGroup = New-Object System.Windows.Forms.GroupBox
$settingsGroup.Text = "网关设置"
$settingsGroup.Dock = "Top"
$settingsGroup.AutoSize = $true
$settingsGroup.Padding = New-Object System.Windows.Forms.Padding(12)
$settingsGrid = New-Object System.Windows.Forms.TableLayoutPanel
$settingsGrid.Dock = "Top"
$settingsGrid.AutoSize = $true
$settingsGrid.ColumnCount = 2
$settingsGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 120))) | Out-Null
$settingsGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
[void]$settingsGroup.Controls.Add($settingsGrid)

$adminBaseUrlBox = New-TextBox "https://admin.example.com"
$userBaseUrlBox = New-TextBox "https://api.example.com"
$adminKeyBox = New-TextBox "GATEWAY_ADMIN_KEY"
$adminKeyBox.UseSystemPasswordChar = $true
$rememberKeyBox = New-Object System.Windows.Forms.CheckBox
$rememberKeyBox.Text = "在这台电脑上记住管理员 Key"
$rememberKeyBox.AutoSize = $true
$rememberKeyBox.Margin = New-Object System.Windows.Forms.Padding(0, 8, 0, 0)

Add-Row $settingsGrid "管理员网址" $adminBaseUrlBox
Add-Row $settingsGrid "用户/API 网址" $userBaseUrlBox
Add-Row $settingsGrid "管理员 Key" $adminKeyBox
[void]$settingsGrid.Controls.Add((New-Object System.Windows.Forms.Label))
[void]$settingsGrid.Controls.Add($rememberKeyBox)
[void]$root.Controls.Add($settingsGroup)

$friendGroup = New-Object System.Windows.Forms.GroupBox
$friendGroup.Text = "朋友入口"
$friendGroup.Dock = "Top"
$friendGroup.AutoSize = $true
$friendGroup.Padding = New-Object System.Windows.Forms.Padding(12)
$friendGroup.Margin = New-Object System.Windows.Forms.Padding(0, 12, 0, 0)
$friendGrid = New-Object System.Windows.Forms.TableLayoutPanel
$friendGrid.Dock = "Top"
$friendGrid.AutoSize = $true
$friendGrid.ColumnCount = 3
$friendGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 120))) | Out-Null
$friendGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$friendGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 120))) | Out-Null
[void]$friendGroup.Controls.Add($friendGrid)

$friendSlugBox = New-TextBox "例如 friend-preview 或 u_xxxxx"
[void]$friendGrid.Controls.Add((New-Label "朋友短地址"))
[void]$friendGrid.Controls.Add($friendSlugBox)
[void]$friendGrid.Controls.Add((New-Button "随机生成" { $friendSlugBox.Text = New-RandomSlug }))
[void]$root.Controls.Add($friendGroup)

$buttonBar = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonBar.Dock = "Top"
$buttonBar.AutoSize = $true
$buttonBar.Margin = New-Object System.Windows.Forms.Padding(0, 12, 0, 0)
[void]$buttonBar.Controls.Add((New-Button "保存设置" { Save-Config }))
[void]$buttonBar.Controls.Add((New-Button "健康检查" { Invoke-HealthCheck }))
[void]$buttonBar.Controls.Add((New-Button "读取概览" { Invoke-Overview }))
[void]$buttonBar.Controls.Add((New-Button "打开管理台" { Open-AdminPortal }))
[void]$buttonBar.Controls.Add((New-Button "打开朋友页" { $url = Get-FriendPortalUrl; if ($url) { Open-Url $url } }))
[void]$buttonBar.Controls.Add((New-Button "复制 API 网址" { Copy-Text (Get-ApiBaseUrl) }))
[void]$buttonBar.Controls.Add((New-Button "复制朋友页" { Copy-Text (Get-FriendPortalUrl) }))
[void]$root.Controls.Add($buttonBar)

$statusBox = New-Object System.Windows.Forms.TextBox
$statusBox.Multiline = $true
$statusBox.ReadOnly = $true
$statusBox.ScrollBars = "Vertical"
$statusBox.Dock = "Fill"
$statusBox.Font = New-Object System.Drawing.Font("Consolas", 10)
$statusBox.Margin = New-Object System.Windows.Forms.Padding(0, 14, 0, 0)
[void]$root.Controls.Add($statusBox)

Load-Config
Set-Status "就绪。这个启动器不会保存上游 OAuth 或上游 API Key。"
[void]$form.ShowDialog()
