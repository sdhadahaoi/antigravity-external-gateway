$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outputDir = Join-Path $projectDir "dist"

dotnet publish (Join-Path $projectDir "AntigravityGatewayAdmin.csproj") `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:PublishTrimmed=false `
  -o $outputDir

Write-Host "Built:" (Join-Path $outputDir "AntigravityGatewayAdmin.exe")
