# icons/icon.svg から PNG アイコンを作り直す（Windows の Edge を headless で使う。追加のインストール不要）
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
# 出力: icons/icon-192.png, icons/icon-512.png（背景透明）, icons/maskable-512.png（淡い緑の背景・中央 66%。Android の丸型マスクでも欠けない範囲）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$icons = Join-Path $root 'icons'
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge が見つかりません' }

$svg = Get-Content (Join-Path $icons 'icon.svg') -Raw -Encoding UTF8
$tmp = Join-Path ([IO.Path]::GetTempPath()) "make-icons-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null

function Render($name, $size, $bg, $scale) {
  $html = "<!doctype html><style>html,body{margin:0;width:${size}px;height:${size}px;background:$bg;display:grid;place-items:center;overflow:hidden}svg{width:$($size*$scale)px;height:$($size*$scale)px}</style>$svg"
  $page = Join-Path $tmp "$name.html"
  Set-Content $page $html -Encoding UTF8
  $out = Join-Path $icons $name
  & $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 `
    --default-background-color=00000000 "--window-size=$size,$size" "--screenshot=$out" `
    ("file:///" + ($page -replace '\\', '/')) 2>$null | Out-Null
  Write-Host "$name ($size px)"
}

Render 'icon-192.png' 192 'transparent' 0.94
Render 'icon-512.png' 512 'transparent' 0.94
Render 'maskable-512.png' 512 '#e6f2ec' 0.66
Remove-Item -Recurse -Force $tmp
