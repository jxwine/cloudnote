# 一次性装好出 APK 需要的 Android SDK，不装 Android Studio。
#
#   powershell -ExecutionPolicy Bypass -File android/scripts/setup-sdk.ps1
#
# 装到 %LOCALAPPDATA%\Android\Sdk（Android Studio 的默认位置，以后装了 Studio 也能共用）：
#   cmdline-tools/latest   sdkmanager 本体
#   platform-tools         adb
#   platforms;android-35   编译目标
#   build-tools;35.0.0     aapt2 / apksigner / zipalign
# 需要 JDK 17+（本机是 jdk-23），Gradle 会自己下。全部约 700 MB，走系统代理。

$ErrorActionPreference = 'Stop'
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$tools = Join-Path $sdk 'cmdline-tools\latest'
$sdkmanager = Join-Path $tools 'bin\sdkmanager.bat'

if (-not (Test-Path $sdkmanager)) {
  $zip = Join-Path $env:TEMP 'commandlinetools-win.zip'
  $url = 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip'
  Write-Host "下载 cmdline-tools：$url"
  Invoke-WebRequest -Uri $url -OutFile $zip
  $stage = Join-Path $env:TEMP 'cmdline-tools-stage'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $stage
  New-Item -ItemType Directory -Force (Split-Path $tools) | Out-Null
  if (Test-Path $tools) { Remove-Item $tools -Recurse -Force }
  # 压缩包里的顶层目录叫 cmdline-tools，sdkmanager 要求它住在 cmdline-tools\latest 下
  Move-Item (Join-Path $stage 'cmdline-tools') $tools
  Remove-Item $zip, $stage -Recurse -Force
}

$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

# sdkmanager 只认 JAVA_HOME，不看 PATH。没设的话从 java.exe 的位置反推
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin/java.exe'))) {
  $java = Get-Command java -ErrorAction SilentlyContinue
  $candidates = @()
  if ($java) {
    # javapath 里的是个转发器，真身在 Program Files\Java 下
    $candidates += Get-ChildItem 'C:\Program Files\Java' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'jdk*' } | Sort-Object Name -Descending | ForEach-Object { $_.FullName }
  }
  $jdk = $candidates | Where-Object { Test-Path (Join-Path $_ 'bin/javac.exe') } | Select-Object -First 1
  if (-not $jdk) { throw '找不到 JDK（需要 17+）。装一个，或者设好 JAVA_HOME 再跑。' }
  $env:JAVA_HOME = $jdk
  [Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk, 'User')
  Write-Host "JAVA_HOME = $jdk"
}
# sdkmanager.bat 那段版本检查解析不了 "java version 23" 这种新格式，会误报「需要 17+」，跳过它
$env:SKIP_JDK_VERSION_CHECK = '1'
# 接受 license：sdkmanager 会逐条问，全部回 y
Write-Host '接受 license…'
$yes = ('y' + [Environment]::NewLine) * 20
$yes | & $sdkmanager --sdk_root="$sdk" --licenses | Out-Null
Write-Host '安装 platform-tools / platforms;android-35 / build-tools;35.0.0…'
& $sdkmanager --sdk_root="$sdk" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
if ($LASTEXITCODE -ne 0) { throw "sdkmanager 失败：$LASTEXITCODE" }
foreach ($d in 'platform-tools/adb.exe', 'platforms/android-35/android.jar', 'build-tools/35.0.0/aapt2.exe') {
  if (-not (Test-Path (Join-Path $sdk $d))) { throw "装完了但没看到 $d，上面的输出里找原因" }
}

# 记到当前用户的环境变量里，新开的终端 / Gradle 直接能找到
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User')
Write-Host "完成。ANDROID_HOME = $sdk"
