# Tokscale stats push workflow

This repo stores one `my-data.json` per machine branch.
The NAS webhook watches those branches, merges them, and writes the result into the Tokscale frontend.

## Branch layout

- `main`
  - project overview
  - how to run the update script
  - webhook / deployment notes
- `stats/<computername>`
  - one machine's exported `my-data.json`
  - pushed by `update_stats.ps1`

## How it works

1. On each computer, run `update_stats.ps1`.
2. The script generates `my-data.json` from the local Tokscale CLI.
3. The script commits that file to a machine-specific branch:

   - `stats/<computername>`

4. The script pushes that branch to GitHub.
5. The NAS webhook pulls all `origin/stats/*` branches, merges them, and updates:

   - `\\192.168.0.104\docker\Tokscale\tokscale\packages\frontend\public\my-data.json`

6. Open:

   - `https://tokscale.guieunuch.cc/local`

   Log in with `auth.guieunuch.cc` if prompted.

## Requirements

- Git
- PowerShell
- The `tokscale` CLI available in `PATH`
- Permission to push to this GitHub repo

## First-time setup on a new computer

1. Clone this repo.

   ```powershell
   git clone https://github.com/Akirataiki1989/tokscale-stats.git
   cd tokscale-stats
   ```

2. Confirm the Tokscale CLI works.

   ```powershell
   tokscale --help
   ```

3. Run the update script.

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\update_stats.ps1
   ```

If that succeeds, the script will create or update:

- `my-data.json`
- branch `stats/<computername>`

## Optional: automatic push hook

If you want the update to run automatically before every `git push`, install the provided hook as `.git/hooks/pre-push`.

On Windows, the easiest way is usually to copy the `pre-push` file into:

- `.git/hooks/pre-push`

Then make sure Git can execute it in your environment.

## Verify the result

After pushing:

1. Wait for the NAS webhook to merge the branches.
2. Check the webhook logs if needed.
3. Open:

   - `https://tokscale.guieunuch.cc/local`

4. The page should reflect the latest merged `my-data.json`.

## Notes

- Do not hand-edit `my-data.json` unless you know exactly what you are changing.
- The webhook merge is branch-based, so each computer keeps its own `stats/<computername>` branch.
- The live dashboard only needs the merged output; it does not read from the GitHub repo directly.
