$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$port = 5202
$baseUrl = "http://127.0.0.1:$port"

Write-Output "[verify] start dev server on $baseUrl"
$devProc = Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c", "npm.cmd run dev -- --host 127.0.0.1 --port $port" `
  -WorkingDirectory $projectRoot `
  -PassThru

try {
  Start-Sleep -Seconds 6

  $root = Invoke-WebRequest -UseBasicParsing "$baseUrl/"
  Write-Output "[verify] ROOT_STATUS=$($root.StatusCode)"

  $itemsRes = Invoke-WebRequest -UseBasicParsing "$baseUrl/api/library/items"
  Write-Output "[verify] API_STATUS=$($itemsRes.StatusCode)"
  $itemsJson = $itemsRes.Content | ConvertFrom-Json
  $itemsCount = @($itemsJson.items).Count
  Write-Output "[verify] ITEMS_COUNT=$itemsCount"
  if ($itemsCount -le 0) {
    throw "items empty"
  }

  $first = $itemsJson.items[0]
  $payload = @{
    ownedFileId = $first.ownedFileId
    productId = $first.productId
  } | ConvertTo-Json

  $openFileRes = Invoke-WebRequest -UseBasicParsing `
    -Method Post `
    -Uri "$baseUrl/api/library/open-file" `
    -ContentType "application/json" `
    -Body $payload
  Write-Output "[verify] OPEN_FILE_STATUS=$($openFileRes.StatusCode)"
  Write-Output "[verify] OPEN_FILE_BODY=$($openFileRes.Content)"

  $openFolderRes = Invoke-WebRequest -UseBasicParsing `
    -Method Post `
    -Uri "$baseUrl/api/library/open-folder" `
    -ContentType "application/json" `
    -Body $payload
  Write-Output "[verify] OPEN_FOLDER_STATUS=$($openFolderRes.StatusCode)"
  Write-Output "[verify] OPEN_FOLDER_BODY=$($openFolderRes.Content)"

  Write-Output "[verify] runtime verification passed"
}
finally {
  if ($devProc -and !$devProc.HasExited) {
    Stop-Process -Id $devProc.Id -Force -ErrorAction SilentlyContinue
  }
}
