@echo off
title Compilar APK - TreinoFit
cd /d "%~dp0"

echo ========================================================
echo   Compilador do TreinoFit Mobile
echo ========================================================
echo.

set "RAIZ=%~dp0"
set "CC_DIR=C:\Trabalho\IA\Projetos\Sistemas\Sistema - Command Center\projeto"
set "JAVA_HOME=%CC_DIR%\tools\jdk\jdk-17.0.20+8"
set "ANDROID_HOME=%CC_DIR%\android-sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "GRADLE=%CC_DIR%\tools\gradle\gradle-8.7\bin\gradle.bat"

if not exist "%JAVA_HOME%\bin\java.exe" (
  echo [ERRO] JDK nao encontrado em: "%JAVA_HOME%"
  exit /b 1
)

if not exist "%ANDROID_HOME%\platform-tools\adb.exe" (
  echo [ERRO] Android SDK nao encontrado em: "%ANDROID_HOME%"
  exit /b 1
)

echo [1/3] Sincronizando catalogo de exercicios e treinos predefinidos...
copy /y "%RAIZ%exercises.json" "%RAIZ%android\app\src\main\assets\exercises.json" >nul
copy /y "%RAIZ%presets.json" "%RAIZ%android\app\src\main\assets\presets.json" >nul
copy /y "%RAIZ%default_custom_workouts.json" "%RAIZ%android\app\src\main\assets\default_custom_workouts.json" >nul

echo [2/3] Atualizando android\local.properties...
powershell -NoProfile -Command "Set-Content -Path '%RAIZ%android\local.properties' -Value 'sdk.dir=C:\\Trabalho\\IA\\Projetos\\Sistemas\\Sistema - Command Center\\projeto\\android-sdk'"

echo [3/3] Compilando TreinoFit APK com Gradle 8.7...
echo.
cd android
call "%GRADLE%" assembleDebug --console=plain
set RC=%errorlevel%
cd ..

if %RC% neq 0 (
  echo.
  echo [ERRO] A compilacao falhou com codigo %RC%.
  exit /b %RC%
)

set "APK_ORIGEM=%RAIZ%android\app\build\outputs\apk\debug\app-debug.apk"
set "APK_DESTINO=%RAIZ%TreinoFit.apk"

if exist "%APK_ORIGEM%" (
  copy /y "%APK_ORIGEM%" "%APK_DESTINO%" >nul
  echo.
  echo ========================================================
  echo  SUCESSO! APK gerado com exito:
  echo  %APK_DESTINO%
  echo ========================================================
)
