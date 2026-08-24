param(
  [int]$Port = 8000,
  [string]$Root = ""
)

# Minimal static file server for the Silhouette Gallery.
# Runs on any Windows machine (no Python / Node.js required).

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = Split-Path -Parent $PSScriptRoot
}

# Normalize root to an absolute path with a trailing backslash.
$root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + '\'

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
  '.gif'  = 'image/gif'
  '.bmp'  = 'image/bmp'
  '.ico'  = 'image/x-icon'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
  '.bat'  = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try {
  $listener.Start()
  Write-Host ("Silhouette Gallery server is running: http://127.0.0.1:" + $Port + "/")
  Write-Host ("Serving folder: " + $root)
  Write-Host "Close this window to stop the server."
} catch {
  Write-Host ("Cannot use port " + $Port + ": " + $_.Exception.Message)
  Write-Host "Please close programs that may be using this port and try again."
  exit 1
}

function Send-Response {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$Status,
    [string]$StatusText,
    [string]$ContentType,
    [byte[]]$Body
  )
  $header = "HTTP/1.1 $Status $StatusText`r`n" +
            "Content-Type: $ContentType`r`n" +
            "Content-Length: $($Body.Length)`r`n" +
            "Cache-Control: no-cache`r`n" +
            "Connection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
  $Stream.Flush()
}

while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)

    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { continue }

    $parts = $requestLine.Split(' ')
    if ($parts.Count -lt 2 -or $parts[0] -ne 'GET') {
      $body = [System.Text.Encoding]::UTF8.GetBytes('405 Method Not Allowed')
      Send-Response -Stream $stream -Status 405 -StatusText 'Method Not Allowed' `
                    -ContentType 'text/plain; charset=utf-8' -Body $body
      continue
    }

    # Consume request headers up to the blank line.
    while (($line = $reader.ReadLine()) -ne $null -and $line -ne '') { }

    $raw = $parts[1]
    $queryIndex = $raw.IndexOf('?')
    if ($queryIndex -ge 0) { $raw = $raw.Substring(0, $queryIndex) }

    $urlPath = [System.Uri]::UnescapeDataString($raw)
    if ($urlPath -eq '/') { $urlPath = '/index.html' }

    $rel = $urlPath.TrimStart('/').Replace('/', '\')
    $full = [System.IO.Path]::GetFullPath($root + $rel)
    $isInside = $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)

    if (-not $isInside) {
      $body = [System.Text.Encoding]::UTF8.GetBytes('403 Forbidden')
      Send-Response -Stream $stream -Status 403 -StatusText 'Forbidden' `
                    -ContentType 'text/plain; charset=utf-8' -Body $body
    } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      if (-not $mime.ContainsKey($ext)) { $ext = '.bin' }
      $type = $mime[$ext]
      if ($ext -eq '.bin') { $type = 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      Send-Response -Stream $stream -Status 200 -StatusText 'OK' `
                    -ContentType $type -Body $bytes
      Write-Host ("GET " + $urlPath + " -> 200")
    } else {
      $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      Send-Response -Stream $stream -Status 404 -StatusText 'Not Found' `
                    -ContentType 'text/plain; charset=utf-8' -Body $body
      Write-Host ("GET " + $urlPath + " -> 404")
    }
  } catch {
    # Ignore per-request errors so the server keeps running.
  } finally {
    if ($client) { $client.Close() }
  }
}
