param(
    [string]$CsvPath = "",
    [int]$BatchSize = 10,
    [string]$Prefix = "fc2"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CsvPath)) {
    $CsvPath = Join-Path $PSScriptRoot "manual_master_import.csv"
}

if (-not (Test-Path -LiteralPath $CsvPath)) {
    throw "CSV not found: $CsvPath"
}

if ($BatchSize -lt 1) {
    $BatchSize = 10
}

$rows = Import-Csv -LiteralPath $CsvPath
if (-not $rows -or $rows.Count -eq 0) {
    Write-Host "No records found in CSV: $CsvPath"
    exit 0
}

$firstColumn = ($rows[0].PSObject.Properties.Name | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($firstColumn)) {
    throw "Could not determine the first CSV column."
}

$values = foreach ($row in $rows) {
    $value = [string]$row.$firstColumn
    $value = $value.Trim()
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        $value
    }
}

if (-not $values -or $values.Count -eq 0) {
    Write-Host "No searchable values found in first column: $firstColumn"
    exit 0
}

Write-Host "CSV       : $CsvPath"
Write-Host "Column    : $firstColumn"
Write-Host "Records   : $($values.Count)"
Write-Host "Batch size: $BatchSize"
Write-Host ""

$index = 0
while ($index -lt $values.Count) {
    $end = [Math]::Min($index + $BatchSize - 1, $values.Count - 1)
    $currentValues = $values[$index..$end]

    Write-Host "Next searches: $($index + 1)-$($end + 1) / $($values.Count)"
    foreach ($value in $currentValues) {
        Write-Host "  $Prefix $value"
    }
    Write-Host ""

    $answer = Read-Host "Press Enter to open these tabs, or type q to quit"
    if ($answer -match "^(q|quit|exit)$") {
        Write-Host "Stopped by user."
        exit 0
    }

    foreach ($value in $currentValues) {
        $query = "$Prefix $value"
        $encodedQuery = [System.Uri]::EscapeDataString($query)
        $url = "https://www.google.com/search?q=$encodedQuery"
        Start-Process $url
        Start-Sleep -Milliseconds 250
    }

    $index = $end + 1
    Write-Host ""
}

Write-Host "All searches opened."
