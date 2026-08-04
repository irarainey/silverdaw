<#
.SYNOPSIS
    Lint the Silverdaw backend C++ sources with clang-tidy.

.DESCRIPTION
    Runs clang-tidy over every *.cpp under backend/src/ using the
    compile_commands.json produced by the CMake configure step
    (CMAKE_EXPORT_COMPILE_COMMANDS=ON). Checks are controlled by
    backend/.clang-tidy.

    Intended to be invoked from inside the Visual Studio developer shell
    (see Invoke-DevShell.ps1) so the clang-tidy that ships with the
    "C++ Clang tools for Windows" component is on PATH. If clang-tidy is
    not found, the script prints an actionable message and exits 2.

.PARAMETER Fix
    Pass --fix to clang-tidy so suggested code-mods are applied in place.
    Also passes --fix-notes, because many checks (the performance-* family in
    particular) attach their replacement to a note rather than the warning,
    and would otherwise be reported but never fixed. Pair this with
    clang-format afterwards to tidy up resulting whitespace, and always
    rebuild and run the tests: a code-mod is a change like any other.

.PARAMETER Strict
    Treat every warning as an error (clang-tidy --warnings-as-errors=*).
    Useful for CI; off by default so a fresh `backend: lint` run is
    informative rather than immediately failing.

.PARAMETER BuildDir
    The CMake build directory containing compile_commands.json. When not
    given, the script searches the known build trees and uses the first that
    has one — only the Ninja/Makefile generators emit a compile database, so
    the Visual Studio tree in backend/build usually does not have one.

.PARAMETER SrcDir
    The directory to scan for *.cpp files. Defaults to <repo>/backend/src.

.PARAMETER ReportPath
    Where to write the full clang-tidy output. Defaults to
    <repo>/clang-tidy-report.txt, which is gitignored. The console gets a
    per-check summary instead, because the raw output runs to thousands of
    lines and scrolls the findings out of the terminal buffer.

.PARAMETER Filter
    Only report warnings whose check name matches this regex. Handy when
    working through one check at a time, e.g. -Filter 'modernize-use-scoped'.

.PARAMETER Checks
    Override the check list from backend/.clang-tidy for this run only, e.g.
    -Checks '-*,modernize-use-scoped-lock'. Mainly for use with -Fix, so a
    code-mod can be applied and reviewed one check at a time.

.PARAMETER Jobs
    How many clang-tidy processes to run in parallel, via run-clang-tidy.
    Defaults to the CPU count. Parallelism is the single biggest win available
    here: clang-tidy re-parses every header of every translation unit, so the
    work is large but embarrassingly parallel. Ignored for -Fix, which is
    always serial. Use -Jobs 1 to force the serial path.

.PARAMETER NoSystemHeaders
    Lint against the build's own compile_commands.json instead of the derived
    copy that marks third-party include directories as system headers. Only
    useful for diagnosing a difference between the two.

.PARAMETER Changed
    Lint only the sources affected by the current changes rather than the whole
    tree. A changed .cpp lints itself; a changed header lints every translation
    unit that includes it, resolved from the dependency graph Ninja recorded
    during the last build. Anything that cannot be resolved confidently — no
    Ninja, no dependency record, an unrecognised header, or a change to the
    check configuration itself — falls back to linting everything, because a
    partial run that wrongly reports clean is worse than a slow one.

.PARAMETER Since
    The git ref -Changed compares against. Defaults to HEAD, i.e. uncommitted
    work. Pass a branch point such as origin/main to lint a whole branch.

.PARAMETER ClangTidyPath
    Use this clang-tidy executable instead of searching PATH. Different
    clang-tidy releases disagree about what to warn on, so a gate that must
    reproduce an established baseline needs to name its binary rather than
    inherit whichever one happens to be first on PATH — the MSVC developer
    shell, for instance, puts Visual Studio's copy ahead of everything else.
#>
[CmdletBinding()]
param(
    [switch]$Fix,
    [switch]$Strict,
    [string]$BuildDir,
    [string]$SrcDir = (Join-Path $PSScriptRoot '..\backend\src'),
    [string]$ReportPath = (Join-Path $PSScriptRoot '..\clang-tidy-report.txt'),
    [string]$Filter,
    [string]$Checks,
    [int]$Jobs = [Environment]::ProcessorCount,
    [switch]$NoSystemHeaders,
    [switch]$Changed,
    [string]$Since = 'HEAD',
    [string]$ClangTidyPath
)

$ErrorActionPreference = 'Stop'

$SrcDir = (Resolve-Path -LiteralPath $SrcDir).Path
$ReportPath = [System.IO.Path]::GetFullPath($ReportPath)

function Resolve-CompileDb([string]$dir) {
    if (-not $dir) { return $null }
    $full = (Resolve-Path -LiteralPath $dir -ErrorAction SilentlyContinue)?.Path
    if (-not $full) { return $null }
    $db = Join-Path $full 'compile_commands.json'
    if (Test-Path -LiteralPath $db) { return $full }
    return $null
}

# An explicit -BuildDir is taken at face value so a mistyped path is an error
# rather than a silent fall-back to some other tree. Without one, search: the
# compile database only exists under a single-config generator, so which tree
# holds it depends on how the repo was last configured.
$candidates = if ($PSBoundParameters.ContainsKey('BuildDir')) {
    @($BuildDir)
} else {
    @('..\backend\build', '..\backend\build-release', '..\backend\build-debug') |
        ForEach-Object { Join-Path $PSScriptRoot $_ }
}

$BuildDir = $candidates | ForEach-Object { Resolve-CompileDb $_ } | Select-Object -First 1

if (-not $BuildDir) {
    Write-Host 'compile_commands.json not found in any known build tree:' -ForegroundColor Yellow
    foreach ($c in $candidates) { Write-Host "  $c" -ForegroundColor Yellow }
    Write-Host '' -ForegroundColor Yellow
    Write-Host 'Only a single-config generator writes one, so configure a Ninja tree:' -ForegroundColor Yellow
    Write-Host '  pwsh -NoProfile -File scripts/Invoke-DevShell.ps1 "cmake -S backend -B backend/build-release -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo"' -ForegroundColor Yellow
    exit 2
}

$compileDb = Join-Path $BuildDir 'compile_commands.json'

# CMake passes every dependency's include directory as a plain -I, so clang
# treats JUCE, rubberband, ixwebsocket and friends as first-party code: it runs
# the full check set over all of it, and HeaderFilterRegex then throws those
# diagnostics away. That work is pure waste. Re-tagging those directories as
# system includes lets clang skip them early and roughly halves a run. It was
# verified diagnostic-for-diagnostic against the unmodified database over a
# 5173-finding check set before being made the default; -NoSystemHeaders opts
# out if that ever needs re-testing.
function New-SystemHeaderDb {
    param([string]$SourceDb, [string]$DestDir)

    $destDb = Join-Path $DestDir 'compile_commands.json'
    $srcInfo = Get-Item -LiteralPath $SourceDb
    if ((Test-Path -LiteralPath $destDb) -and
        (Get-Item -LiteralPath $destDb).LastWriteTimeUtc -ge $srcInfo.LastWriteTimeUtc) {
        return $DestDir
    }

    # Anything pulled in by FetchContent (_deps) or vendored under third_party.
    $pattern = '(?<= |^)[-/]I(?<p>\S*(?:[\\/]_deps[\\/]|[\\/]third_party[\\/])\S*)'
    $entries = Get-Content -LiteralPath $SourceDb -Raw | ConvertFrom-Json
    $rewrites = 0

    foreach ($entry in $entries) {
        if (-not $entry.command) { continue }
        $hits = [regex]::Matches($entry.command, $pattern).Count
        if ($hits -eq 0) { continue }
        # clang-cl spells a system include /imsvc; the GCC-style driver -isystem.
        $flag = if ($entry.command -match '(?i)\bcl\.exe') { '/imsvc' } else { '-isystem' }
        $entry.command = [regex]::Replace($entry.command, $pattern, ($flag + '${p}'))
        $rewrites += $hits
    }

    if ($rewrites -eq 0) { return $null }

    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    $entries | ConvertTo-Json -Depth 5 -Compress |
        Set-Content -LiteralPath $destDb -Encoding utf8
    return $DestDir
}

function ConvertTo-CanonicalPath {
    param([string]$Path, [string]$BasePath)

    if (-not [System.IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $BasePath $Path }
    return [System.IO.Path]::GetFullPath($Path).ToLowerInvariant()
}

# Find the translation units that include any of the given headers, from the
# dependency graph Ninja recorded while compiling — exact, unlike re-scanning
# #include lines. Returns $null when the record cannot be trusted, which the
# caller must treat as "lint everything".
function Get-SourcesIncludingHeaders {
    param([string]$BuildPath, [object[]]$DbEntries, [string[]]$Headers)

    if (-not (Get-Command ninja -ErrorAction SilentlyContinue)) { return $null }

    $objectToSource = @{}
    foreach ($entry in $DbEntries) {
        if (-not $entry.output) { continue }
        $objectToSource[(ConvertTo-CanonicalPath $entry.output $BuildPath)] =
            ConvertTo-CanonicalPath $entry.file $BuildPath
    }
    if ($objectToSource.Count -eq 0) { return $null }

    $depsOutput = & ninja -C $BuildPath -t deps 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $depsOutput) { return $null }

    # The graph runs to ~100k lines. Resolving every one of them to a full path
    # costs far more than the lint this is meant to save, so compare the cheap
    # file name first and only resolve the few lines that could be a match.
    $wantedPaths = @{}
    $wantedNames = @{}
    foreach ($header in $Headers) {
        $wantedPaths[$header] = $true
        $wantedNames[[System.IO.Path]::GetFileName($header)] = $true
    }

    $sources = [System.Collections.Generic.HashSet[string]]::new()
    $matchedHeaders = [System.Collections.Generic.HashSet[string]]::new()
    $currentSource = $null

    foreach ($line in $depsOutput) {
        if (-not $line) { continue }
        if ($line[0] -ne ' ') {
            # A stale record describes a build that no longer matches the tree,
            # so its include list cannot be relied on.
            if ($line -match '^(?<obj>\S.*?):\s+#deps\s+\d+.*\((?<state>\w+)\)\s*$') {
                $currentSource = if ($Matches['state'] -eq 'VALID') {
                    $objectToSource[(ConvertTo-CanonicalPath $Matches['obj'] $BuildPath)]
                } else { $null }
            }
            continue
        }
        if (-not $currentSource) { continue }

        $dep = $line.TrimStart()
        if (-not $wantedNames.ContainsKey([System.IO.Path]::GetFileName($dep).ToLowerInvariant())) { continue }
        $full = ConvertTo-CanonicalPath $dep $BuildPath
        if (-not $wantedPaths.ContainsKey($full)) { continue }
        [void]$matchedHeaders.Add($full)
        [void]$sources.Add($currentSource)
    }

    foreach ($header in $Headers) {
        if ($matchedHeaders.Contains($header)) { continue }
        # A header the build has never seen: its blast radius is unknown.
        Write-Host "Header not in dependency graph: $([System.IO.Path]::GetFileName($header))" -ForegroundColor Yellow
        return $null
    }
    return $sources
}

# Work out which sources the current changes can affect. Returns $null to mean
# "could not narrow this down safely, lint everything" — every uncertain case
# takes that route, because a partial run that wrongly reports clean would
# quietly undermine the zero-warning baseline the gate depends on.
function Get-AffectedSources {
    param(
        [string]$BaseRef,
        [string]$SourceRoot,
        [string]$BuildPath,
        [object[]]$DbEntries,
        [string[]]$AllSources
    )

    $repoRoot = & git -C $SourceRoot rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $repoRoot) {
        Write-Host 'Not a git work tree' -ForegroundColor Yellow
        return $null
    }
    $repoRoot = [System.IO.Path]::GetFullPath($repoRoot)

    $tracked = & git -C $repoRoot diff --name-only $BaseRef -- 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Cannot diff against '$BaseRef'" -ForegroundColor Yellow
        return $null
    }
    $untracked = & git -C $repoRoot ls-files --others --exclude-standard 2>$null
    $changed = @($tracked) + @($untracked) | Where-Object { $_ }

    $sourceRootCanonical = ConvertTo-CanonicalPath $SourceRoot $repoRoot
    $knownSources = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($source in $AllSources) {
        [void]$knownSources.Add((ConvertTo-CanonicalPath $source $repoRoot))
    }

    $affected = [System.Collections.Generic.HashSet[string]]::new()
    $headers = [System.Collections.Generic.List[string]]::new()

    foreach ($relative in $changed) {
        $full = ConvertTo-CanonicalPath $relative $repoRoot

        # The check configuration decides what every file is measured against,
        # so a change to it invalidates any narrowing.
        if ($full -match '[\\/]\.clang-tidy$' -or $full -match '[\\/]\.clangd$') {
            Write-Host 'Check configuration changed' -ForegroundColor Yellow
            return $null
        }

        if (-not $full.StartsWith($sourceRootCanonical)) { continue }

        if ($full -match '\.(cpp|cc|cxx)$') {
            if ($knownSources.Contains($full)) { [void]$affected.Add($full) }
        } elseif ($full -match '\.(h|hpp|hxx|inl)$') {
            $headers.Add($full)
        }
    }

    if ($headers.Count -gt 0) {
        $includers = Get-SourcesIncludingHeaders -BuildPath $BuildPath `
            -DbEntries $DbEntries -Headers $headers
        if ($null -eq $includers) { return $null }
        foreach ($source in $includers) {
            if ($knownSources.Contains($source)) { [void]$affected.Add($source) }
        }
    }

    # Return the original casing rather than the canonical lower-case form.
    return @($AllSources | Where-Object {
        $affected.Contains((ConvertTo-CanonicalPath $_ $repoRoot))
    })
}

# The directory handed to clang-tidy's -p, which is the derived database when
# there is one and the build's own otherwise.
$tidyDbDir = $BuildDir
if (-not $NoSystemHeaders) {
    $derived = New-SystemHeaderDb -SourceDb $compileDb -DestDir (Join-Path $BuildDir 'clang-tidy')
    if ($derived) { $tidyDbDir = $derived }
}

function Find-ClangTidy {
    # An explicit path wins outright: this is how a caller pins a version.
    if ($ClangTidyPath) {
        if (-not (Test-Path -LiteralPath $ClangTidyPath)) {
            throw "clang-tidy not found at the path given by -ClangTidyPath: $ClangTidyPath"
        }
        return (Resolve-Path -LiteralPath $ClangTidyPath).Path
    }

    $cmd = Get-Command clang-tidy -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # Fall back to the copy that ships with the VS "C++ Clang tools for
    # Windows" component, so the script also works from a plain shell that
    # hasn't sourced the VS dev environment.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { return $null }

    $vsPath = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
    if (-not $vsPath) { return $null }

    $candidate = Join-Path $vsPath 'VC\Tools\Llvm\x64\bin\clang-tidy.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    return $null
}

$clangTidyExe = Find-ClangTidy
if (-not $clangTidyExe) {
    Write-Host 'clang-tidy was not found on PATH or in the latest Visual Studio install.' -ForegroundColor Yellow
    Write-Host 'Install the "C++ Clang tools for Windows" individual component via' -ForegroundColor Yellow
    Write-Host 'the Visual Studio Installer, or install standalone LLVM (winget' -ForegroundColor Yellow
    Write-Host 'install LLVM.LLVM) and ensure clang-tidy.exe is on PATH.' -ForegroundColor Yellow
    exit 2
}

# run-clang-tidy fans the work out across processes. It ships beside
# clang-tidy in some distributions but not all — the PyPI package omits it —
# and the run still works without it, just serially.
#
# Only the copy beside the chosen clang-tidy counts. Searching PATH as well
# would risk pairing one release's driver with another's linter, and on a
# Visual Studio install it resolves to an extensionless Python script that
# PowerShell cannot execute ("cannot run a document in the middle of a
# pipeline") — a confusing failure in place of a clean serial run.
function Find-RunClangTidy {
    $beside = Join-Path (Split-Path -Parent $clangTidyExe) 'run-clang-tidy.exe'
    if (Test-Path -LiteralPath $beside) { return $beside }
    return $null
}

$runClangTidyExe = Find-RunClangTidy

$files = Get-ChildItem -Path $SrcDir -Recurse -Include '*.cpp' |
    Select-Object -ExpandProperty FullName

if ($files.Count -eq 0) {
    Write-Host "No .cpp files found under '$SrcDir'." -ForegroundColor Yellow
    exit 0
}

Write-Host "clang-tidy: $clangTidyExe"
Write-Host "compile DB: $compileDb"
if ($tidyDbDir -ne $BuildDir) {
    Write-Host 'third-party includes: tagged as system headers'
}

$narrowed = $false
if ($Changed) {
    $dbEntries = Get-Content -LiteralPath $compileDb -Raw | ConvertFrom-Json
    $affected = Get-AffectedSources -BaseRef $Since -SourceRoot $SrcDir `
        -BuildPath $BuildDir -DbEntries $dbEntries -AllSources $files

    if ($null -eq $affected) {
        Write-Host '  -> cannot narrow safely, linting everything.' -ForegroundColor Yellow
    } elseif ($affected.Count -eq 0) {
        Write-Host "No backend sources affected by changes since '$Since'." -ForegroundColor Green
        exit 0
    } else {
        Write-Host "Changes since '$Since' affect $($affected.Count) of $($files.Count) source(s)."
        $files = $affected
        $narrowed = $true
    }
}

# Fix mode stays serial on purpose. run-clang-tidy would have several
# processes rewriting the same shared header at once, and clang-tidy applies
# its edits by byte offset — concurrent writers corrupt each other.
$useParallel = (-not $Fix) -and $runClangTidyExe -and $Jobs -gt 1

if ($useParallel) {
    # Match the compile database's own paths, which may use either separator.
    # run-clang-tidy takes a regex over source paths, so a narrowed run becomes
    # an alternation of the exact files rather than the whole directory.
    $toPattern = {
        param($path)
        ($path -split '[\\/]' | ForEach-Object { [regex]::Escape($_) }) -join '[\\/]'
    }
    $sourceFilter = if ($narrowed) {
        '(?i)^(?:' + (($files | ForEach-Object { & $toPattern $_ }) -join '|') + ')$'
    } else {
        '(?i)^' + (& $toPattern $SrcDir) + '[\\/]'
    }

    $exe = $runClangTidyExe
    $tidyArgs = @('-p', $tidyDbDir, '-j', $Jobs, '-quiet', '-source-filter', $sourceFilter)
    # run-clang-tidy resolves .clang-tidy from the working directory, not from
    # the files it lints, so the backend config has to be named explicitly.
    $configFile = Join-Path (Split-Path -Parent $SrcDir) '.clang-tidy'
    if (Test-Path -LiteralPath $configFile) { $tidyArgs += @('-config-file', $configFile) }
    # -checks=VALUE, not -checks VALUE: a check list almost always starts with
    # "-*", which run-clang-tidy's argument parser would read as another flag.
    if ($Checks) { $tidyArgs += "-checks=$Checks" }
    if ($Strict) { $tidyArgs += @('-warnings-as-errors', '*') }
    Write-Host "Linting $($files.Count) file(s) across $Jobs parallel jobs..."
} else {
    $exe = $clangTidyExe
    $tidyArgs = @('-p', $tidyDbDir, '--quiet')
    if ($Checks) { $tidyArgs += "--checks=$Checks" }
    if ($Fix) { $tidyArgs += '--fix'; $tidyArgs += '--fix-notes' }
    if ($Strict) { $tidyArgs += '--warnings-as-errors=*' }
    $tidyArgs += $files
    $reason = if ($Fix) { 'serial: fix mode applies edits by byte offset' }
              else { 'serial: run-clang-tidy not found' }
    Write-Host "Linting $($files.Count) file(s) ($reason)..."
}

# Stream the full output to the report file and show only progress on the
# console. clang-tidy emits several thousand lines over a run of this size,
# which is unreadable live and overflows the terminal scrollback.
$reportDir = Split-Path -Parent $ReportPath
if ($reportDir -and -not (Test-Path -LiteralPath $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
$writer = [System.IO.StreamWriter]::new($ReportPath, $false, [System.Text.UTF8Encoding]::new($false))
# Deduplicate on the diagnostic's own location. A single clang-tidy process
# suppresses repeats itself, but parallel processes each analyse their own
# translation unit, so a warning in a shared header is reported once per
# includer. Keyed by "file:line:col [check]" those collapse back to one.
$seen = [System.Collections.Generic.HashSet[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$compileErrors = [System.Collections.Generic.List[string]]::new()
# Under -Strict a check finding is printed as `error:` rather than `warning:`,
# so severity cannot be used to tell the two apart. The check name in brackets
# can: a real compile error is tagged clang-diagnostic-*.
$diagPattern = '^(.*?):(\d+):(\d+): (?:warning|error): .*\[([a-z0-9\-]+(?:,[a-z0-9\-]+)*)\]\s*$'
$bareErrorPattern = '^(.*?):(\d+):(\d+): error: (?!.*\[[a-z0-9\-,]+\]\s*$)'
$progressPattern = '^\[\s*(\d+)/(\d+)\]'

try {
    & $exe @tidyArgs 2>&1 | ForEach-Object {
        $line = [string]$_
        $writer.WriteLine($line)
        if ($line -match $progressPattern) {
            Write-Host "`r  $($Matches[1])/$($Matches[2]) files" -NoNewline
        } elseif ($line -match $diagPattern) {
            $location = "$($Matches[1]):$($Matches[2]):$($Matches[3])"
            # Drop the trailing ,-warnings-as-errors that -Strict appends.
            $check = @($Matches[4] -split ',' | Where-Object { $_ -ne '-warnings-as-errors' })[0]
            if (-not $seen.Add("$location [$check]")) { return }
            if ($check -like 'clang-diagnostic-*') { $compileErrors.Add($line) }
            else { $warnings.Add($check) }
        } elseif ($line -match $bareErrorPattern) {
            if ($seen.Add("compile:$line")) { $compileErrors.Add($line) }
        }
    }
    $tidyExit = $LASTEXITCODE
} finally {
    $writer.Dispose()
}

Write-Host ''
Write-Host ''

if ($Filter) {
    $warnings = @($warnings | Where-Object { $_ -match $Filter })
}

if ($warnings.Count -eq 0) {
    Write-Host 'No clang-tidy warnings.' -ForegroundColor Green
} else {
    Write-Host "$($warnings.Count) finding(s) by check:" -ForegroundColor Yellow
    $warnings | Group-Object | Sort-Object Count, Name -Descending |
        ForEach-Object { '{0,6}  {1}' -f $_.Count, $_.Name } | Write-Host
}

# clang-tidy stops analysing a translation unit at its first compile error, so
# errors actively hide findings. Never let them scroll past unremarked.
if ($compileErrors.Count -gt 0) {
    Write-Host ''
    Write-Host "$($compileErrors.Count) compile error(s) — the affected files were only partially" -ForegroundColor Red
    Write-Host 'analysed, so findings in them are being hidden. Fix these first:' -ForegroundColor Red
    $compileErrors | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
}

Write-Host ''
Write-Host "Full output: $ReportPath"
exit $tidyExit
