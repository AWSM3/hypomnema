[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = 'Stop'
$enginePath = Join-Path $PSScriptRoot 'workspace.mjs'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCommand) {
    throw 'Node.js 22+ was not found in PATH.'
}

& $nodeCommand.Source --no-warnings=ExperimentalWarning $enginePath @Arguments
exit $LASTEXITCODE
