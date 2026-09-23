param(
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$JavaHome = $env:JAVA_HOME
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = $PSScriptRoot
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'oba-accessibility-build'
$sourceRoot = Join-Path $workRoot 'source'
if (Test-Path -LiteralPath $workRoot) {
    Remove-Item -LiteralPath $workRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'AndroidManifest.xml') -Destination $sourceRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'res') -Destination $sourceRoot -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'src') -Destination $sourceRoot -Recurse
if (-not $AndroidSdk) {
    $AndroidSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
}
if (-not (Test-Path -LiteralPath $AndroidSdk)) {
    throw "Android SDK not found: $AndroidSdk"
}

$platform = Get-ChildItem -LiteralPath (Join-Path $AndroidSdk 'platforms') -Directory |
    Where-Object { $_.Name -match '^android-(\d+)$' } |
    Sort-Object { [int]($_.Name -replace 'android-', '') } -Descending |
    Select-Object -First 1
$buildTools = Get-ChildItem -LiteralPath (Join-Path $AndroidSdk 'build-tools') -Directory |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
if (-not $platform -or -not $buildTools) {
    throw 'Android platform or build-tools is missing.'
}

if (-not $JavaHome) {
    $javacCommand = Get-Command javac.exe -ErrorAction Stop
    $JavaHome = Split-Path -Parent (Split-Path -Parent $javacCommand.Source)
}

$androidJar = Join-Path $platform.FullName 'android.jar'
$aapt2 = Join-Path $buildTools.FullName 'aapt2.exe'
$zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
$d8 = Join-Path $buildTools.FullName 'd8.bat'
$javac = Join-Path $JavaHome 'bin\javac.exe'
$jar = Join-Path $JavaHome 'bin\jar.exe'
$keytool = Join-Path $JavaHome 'bin\keytool.exe'

$buildRoot = Join-Path $workRoot 'build'
$classesDir = Join-Path $buildRoot 'classes'
$generatedDir = Join-Path $buildRoot 'generated'
$dexDir = Join-Path $buildRoot 'dex'
$compiledResources = Join-Path $buildRoot 'compiled-resources.zip'
$unsignedApk = Join-Path $buildRoot 'unsigned.apk'
$alignedApk = Join-Path $buildRoot 'aligned.apk'
$classesJar = Join-Path $buildRoot 'classes.jar'
$signingDir = Join-Path $workRoot 'signing'
$keystore = Join-Path $signingDir 'oba-accessibility.jks'
$savedSigningDir = Join-Path $projectRoot '.signing'
$savedKeystore = Join-Path $savedSigningDir 'oba-accessibility.jks'
$outputApk = Join-Path $projectRoot 'oba-accessibility.apk'

if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $classesDir, $generatedDir, $dexDir, $signingDir, $savedSigningDir | Out-Null
if (Test-Path -LiteralPath $savedKeystore) {
    Copy-Item -LiteralPath $savedKeystore -Destination $keystore
}

& $aapt2 compile --dir (Join-Path $sourceRoot 'res') -o $compiledResources
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed.' }

& $aapt2 link `
    -o $unsignedApk `
    -I $androidJar `
    --manifest (Join-Path $sourceRoot 'AndroidManifest.xml') `
    --java $generatedDir `
    --min-sdk-version 24 `
    --target-sdk-version 28 `
    --version-code 2 `
    --version-name '0.2.0' `
    $compiledResources
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed.' }

$javaSources = @(
    Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'src') -Filter '*.java' -Recurse
    Get-ChildItem -LiteralPath $generatedDir -Filter '*.java' -Recurse
) | ForEach-Object { $_.FullName }

& $javac -encoding UTF-8 -source 8 -target 8 -classpath $androidJar -d $classesDir $javaSources
if ($LASTEXITCODE -ne 0) { throw 'javac failed.' }

& $jar cf $classesJar -C $classesDir .
if ($LASTEXITCODE -ne 0) { throw 'jar failed.' }

& $d8 --lib $androidJar --min-api 24 --output $dexDir $classesJar
if ($LASTEXITCODE -ne 0) { throw 'd8 failed.' }

& $jar uf $unsignedApk -C $dexDir classes.dex
if ($LASTEXITCODE -ne 0) { throw 'Unable to add classes.dex to APK.' }

& $zipalign -f 4 $unsignedApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed.' }

if (-not (Test-Path -LiteralPath $keystore)) {
    & $keytool -genkeypair `
        -keystore $keystore `
        -storetype JKS `
        -storepass 'oba-local-control' `
        -keypass 'oba-local-control' `
        -alias 'oba-accessibility' `
        -dname 'CN=OBA Live Tool, OU=Local Companion, O=OBA, C=CN' `
        -keyalg RSA `
        -keysize 2048 `
        -validity 10000 `
        -noprompt
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create signing key.' }
    Copy-Item -LiteralPath $keystore -Destination $savedKeystore -Force
}

& $apksigner sign `
    --ks $keystore `
    --ks-key-alias 'oba-accessibility' `
    --ks-pass 'pass:oba-local-control' `
    --key-pass 'pass:oba-local-control' `
    --out (Join-Path $workRoot 'oba-accessibility.apk') `
    $alignedApk
if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }

$workingApk = Join-Path $workRoot 'oba-accessibility.apk'
& $apksigner verify --verbose $workingApk
if ($LASTEXITCODE -ne 0) { throw 'APK verification failed.' }

Copy-Item -LiteralPath $workingApk -Destination $outputApk -Force
Get-Item -LiteralPath $outputApk | Select-Object FullName, Length, LastWriteTime
