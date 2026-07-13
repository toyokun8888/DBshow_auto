param(
    [string]$CsvPath = "",
    [int]$BatchSize = 10,
    [int]$StartAt = 1
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CsvPath)) {
    $CsvPath = Join-Path $PSScriptRoot "project_scripts\google_image_thumbnail_logs\google_image_thumb_20260621002903_29804_targets.csv"
}

if (-not (Test-Path -LiteralPath $CsvPath)) {
    throw "CSV not found: $CsvPath"
}

if ($BatchSize -lt 1) {
    $BatchSize = 10
}

if ($StartAt -lt 1) {
    $StartAt = 1
}

$rows = Import-Csv -LiteralPath $CsvPath
if (-not $rows -or $rows.Count -eq 0) {
    Write-Host "No records found in CSV: $CsvPath"
    exit 0
}

$rowsWithUrl = @($rows | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_.search_url)
})

if ($rowsWithUrl.Count -eq 0) {
    Write-Host "No search_url values found in CSV: $CsvPath"
    exit 0
}

$index = $StartAt - 1
if ($index -ge $rowsWithUrl.Count) {
    Write-Host "StartAt is beyond row count: $StartAt / $($rowsWithUrl.Count)"
    exit 0
}

Write-Host "CSV       : $CsvPath"
Write-Host "Records   : $($rowsWithUrl.Count)"
Write-Host "Batch size: $BatchSize"
Write-Host "Start at  : $StartAt"
Write-Host ""

while ($index -lt $rowsWithUrl.Count) {
    $end = [Math]::Min($index + $BatchSize - 1, $rowsWithUrl.Count - 1)
    $currentRows = $rowsWithUrl[$index..$end]

    Write-Host "Next tabs: $($index + 1)-$($end + 1) / $($rowsWithUrl.Count)"
    foreach ($row in $currentRows) {
        Write-Host "  $($row.product_id)  $($row.search_url)"
    }
    Write-Host ""

    $answer = Read-Host "Press Enter to open these tabs, or type q to quit"
    if ($answer -match "^(q|quit|exit)$") {
        Write-Host "Stopped by user."
        exit 0
    }

    foreach ($row in $currentRows) {
        Start-Process ([string]$row.search_url)
        Start-Sleep -Milliseconds 400
    }

    $index = $end + 1
    Write-Host ""
}

Write-Host "All search tabs opened."
