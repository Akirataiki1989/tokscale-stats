$ErrorActionPreference = "Stop"

# Always run relative to this script, so it works from any folder.
$repoRoot = $PSScriptRoot
Set-Location $repoRoot

# Get computer name and normalize it (lowercase, no spaces)
$computerName = $env:COMPUTERNAME.ToLower().Replace(" ", "")
$branchName = "stats/$computerName"

Write-Host "=== [Tokscale] Target branch: $branchName ==="

# Force checkout / create the computer-specific branch
& git checkout -B $branchName
if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }

# Export the token stats to my-data.json.
# This file is the only payload the webhook merge job needs.
Write-Host "=== [Tokscale] Exporting token statistics ==="
& tokscale graph --output (Join-Path $repoRoot "my-data.json")
if ($LASTEXITCODE -ne 0) { throw "tokscale graph failed" }

# Commit and push to its own branch
Write-Host "=== [Tokscale] Committing and pushing to branch: $branchName ==="
& git add my-data.json
if ($LASTEXITCODE -ne 0) { throw "git add failed" }

& git diff --cached --quiet --exit-code
if ($LASTEXITCODE -eq 0) {
    Write-Host "=== [Tokscale] No changes in my-data.json; nothing to push. ==="
    exit 0
}

& git commit -m "chore: update stats for $computerName" --no-verify
if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

& git push origin $branchName --force
if ($LASTEXITCODE -ne 0) { throw "git push failed" }

Write-Host "=== [Tokscale] Done! ==="
