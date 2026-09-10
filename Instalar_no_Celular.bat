@echo off
title Instalar TreinoFit no Celular (ADB Wi-Fi / USB)
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================================
echo   Instalador Automático — TreinoFit Mobile
echo ========================================================
echo.

set "CC_DIR=C:\Trabalho\IA\Projetos\Sistemas\Sistema - Command Center\projeto"
set "ADB=%CC_DIR%\android-sdk\platform-tools\adb.exe"

if not exist "%ADB%" (
  echo [ERRO] adb.exe nao encontrado em "%ADB%"
  pause & exit /b 1
)

set "APK=%~dp0TreinoFit.apk"
if not exist "%APK%" (
  echo [ERRO] APK nao encontrado em "%APK%"
  echo Compile primeiro executando Compilar_APK.bat
  pause & exit /b 1
)

echo Verificando dispositivos conectados via ADB...
"%ADB%" devices
echo.

set /p IP_PORTA="Digite o IP:PORTA da Depuração sem fio do celular (ou aperte ENTER se já estiver conectado): "

if not "%IP_PORTA%"=="" (
  echo.
  echo Conectando ao aparelho em %IP_PORTA%...
  "%ADB%" connect %IP_PORTA%
  timeout /t 2 >nul
)

echo.
echo [1/4] Instalando TreinoFit.apk no celular...
"%ADB%" install -r -d "%APK%"
if errorlevel 1 (
  echo.
  echo [ERRO] Falha ao instalar o APK. Verifique se a tela do celular está desbloqueada
  echo e se a permissao de depuracao USB/Wi-Fi foi autorizada no aparelho.
  pause & exit /b 1
)

echo.
echo [2/4] Criando pasta de midia interna no celular...
"%ADB%" shell "mkdir -p /sdcard/Android/data/br.com.treinofit/files/gifs"

echo.
echo [3/4] Enviando 963 GIFs para o celular via ADB (2,5 GB)...
echo Isso pode levar de 1 a 3 minutos dependendo da velocidade da rede Wi-Fi...
"%ADB%" push "%~dp0gifs" "/sdcard/Android/data/br.com.treinofit/files/"

echo.
echo [4/4] Abrindo o TreinoFit no seu aparelho...
"%ADB%" shell "am start -n br.com.treinofit/.MainActivity"

echo.
echo ========================================================
echo  PARABÉNS! TreinoFit instalado com todos os 963 GIFs!
echo  O app está pronto e 100%% offline no seu celular.
echo ========================================================
pause
