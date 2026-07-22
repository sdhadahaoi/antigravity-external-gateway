param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($Check) {
  Write-Output "AntigravityGatewayAdmin.ps1 syntax ok"
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
    Set-Status "Please enter the User/API URL first."
    return ""
  }
  if (-not (Test-Slug $slug)) {
    Set-Status "Friend slug must be 3-64 chars: lowercase letters, numbers, '-' or '_', starting with a letter/number."
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
  Set-Status "Copied:`r`n$Text"
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
    Set-Status "Settings saved. Admin key is stored only in your Windows user profile."
  } else {
    Set-Status "Settings saved. Admin key was not written to disk."
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
    Set-Status ("Failed to load settings: " + $_.Exception.Message)
  }
}

function Invoke-HealthCheck {
  $adminUrl = Normalize-BaseUrl $adminBaseUrlBox.Text
  if (-not $adminUrl) {
    Set-Status "Please enter the Admin URL first."
    return
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$adminUrl/health" -TimeoutSec 20
    Set-Status ("Health check ok: HTTP " + [int]$response.StatusCode)
  } catch {
    Set-Status ("Health check failed: " + $_.Exception.Message)
  }
}

function Invoke-Overview {
  $adminUrl = Normalize-BaseUrl $adminBaseUrlBox.Text
  $adminKey = ($adminKeyBox.Text + "").Trim()
  if (-not $adminUrl -or -not $adminKey) {
    Set-Status "Please enter the Admin URL and Admin Key first."
    return
  }
  try {
    $headers = @{ Authorization = "Bearer $adminKey" }
    $overview = Invoke-RestMethod -Uri "$adminUrl/api/admin/overview" -Headers $headers -TimeoutSec 30
    $channelCount = @($overview.channels).Count
    $accountCount = @($overview.accounts).Count
    $modelCount = @($overview.models).Count
    $upstream = "no"
    if ($overview.config.upstream_configured) { $upstream = "yes" }
    Set-Status "Overview loaded.`r`nChannels: $channelCount`r`nCredential windows: $accountCount`r`nModels: $modelCount`r`nUpstream configured: $upstream"
  } catch {
    Set-Status ("Overview failed: " + $_.Exception.Message)
  }
}

function Open-AdminPortal {
  $adminUrl = Normalize-BaseUrl $adminBaseUrlBox.Text
  if (-not $adminUrl) {
    Set-Status "Please enter the Admin URL first."
    return
  }
  $adminKey = ($adminKeyBox.Text + "").Trim()
  if ($adminKey) {
    [System.Windows.Forms.Clipboard]::SetText($adminKey)
    Set-Status "Admin key copied to clipboard. Paste it into the admin page."
  } else {
    Set-Status "Opening admin page."
  }
  Open-Url "$adminUrl/"
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Antigravity Gateway Admin"
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
$title.Text = "Antigravity External Gateway Launcher"
$title.AutoSize = $true
$title.Font = New-Object System.Drawing.Font($form.Font.FontFamily, 15, [System.Drawing.FontStyle]::Bold)
$title.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 14)
[void]$root.Controls.Add($title)

$settingsGroup = New-Object System.Windows.Forms.GroupBox
$settingsGroup.Text = "Gateway Settings"
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
$rememberKeyBox.Text = "Remember admin key on this computer"
$rememberKeyBox.AutoSize = $true
$rememberKeyBox.Margin = New-Object System.Windows.Forms.Padding(0, 8, 0, 0)

Add-Row $settingsGrid "Admin URL" $adminBaseUrlBox
Add-Row $settingsGrid "User/API URL" $userBaseUrlBox
Add-Row $settingsGrid "Admin Key" $adminKeyBox
[void]$settingsGrid.Controls.Add((New-Object System.Windows.Forms.Label))
[void]$settingsGrid.Controls.Add($rememberKeyBox)
[void]$root.Controls.Add($settingsGroup)

$friendGroup = New-Object System.Windows.Forms.GroupBox
$friendGroup.Text = "Friend Portal"
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

$friendSlugBox = New-TextBox "friend-preview or u_xxxxx"
[void]$friendGrid.Controls.Add((New-Label "Friend slug"))
[void]$friendGrid.Controls.Add($friendSlugBox)
[void]$friendGrid.Controls.Add((New-Button "Random" { $friendSlugBox.Text = New-RandomSlug }))
[void]$root.Controls.Add($friendGroup)

$buttonBar = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonBar.Dock = "Top"
$buttonBar.AutoSize = $true
$buttonBar.Margin = New-Object System.Windows.Forms.Padding(0, 12, 0, 0)
[void]$buttonBar.Controls.Add((New-Button "Save" { Save-Config }))
[void]$buttonBar.Controls.Add((New-Button "Health" { Invoke-HealthCheck }))
[void]$buttonBar.Controls.Add((New-Button "Overview" { Invoke-Overview }))
[void]$buttonBar.Controls.Add((New-Button "Open Admin" { Open-AdminPortal }))
[void]$buttonBar.Controls.Add((New-Button "Open Friend" { $url = Get-FriendPortalUrl; if ($url) { Open-Url $url } }))
[void]$buttonBar.Controls.Add((New-Button "Copy API URL" { Copy-Text (Get-ApiBaseUrl) }))
[void]$buttonBar.Controls.Add((New-Button "Copy Portal URL" { Copy-Text (Get-FriendPortalUrl) }))
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
Set-Status "Ready. This launcher never stores upstream OAuth or upstream API keys."
[void]$form.ShowDialog()
