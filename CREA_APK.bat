@echo off
setlocal
cd /d "%~dp0"
title LIPPOLIS PT - Crea APK

echo.
echo  [1/5] Controllo strumenti
where node >nul 2>nul || (echo  ERRORE: Node.js non trovato. Installalo da nodejs.org & goto :fine)
if "%JAVA_HOME%"=="" if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
if "%JAVA_HOME%"=="" (echo  ERRORE: Java non trovato. Serve Android Studio installato & goto :fine)
if "%ANDROID_HOME%"=="" if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if "%ANDROID_HOME%"=="" (echo  ERRORE: SDK Android non trovato. Apri Android Studio una volta & goto :fine)
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%"
echo        Java: %JAVA_HOME%
echo        SDK:  %ANDROID_HOME%

echo.
echo  [2/5] Dipendenze
rem sempre: installa anche i plugin locali aggiunti dopo il primo giro (plugin-timer)
call npm install
if errorlevel 1 goto :errore

echo.
echo  [3/5] Progetto Android
if exist android goto :sync
call npx cap add android
if errorlevel 1 goto :errore
call npx @capacitor/assets generate --android
:sync
call npx cap sync android
if errorlevel 1 goto :errore

echo.
echo  [4/5] Compilo l'APK - la prima volta ci mette qualche minuto
pushd android
call gradlew.bat assembleDebug
if errorlevel 1 (popd & goto :errore)
popd
copy /y "android\app\build\outputs\apk\debug\app-debug.apk" "LIPPOLIS-PT.apk" >nul

echo.
echo  [5/5] Installo sul telefono
adb get-state >nul 2>nul
if errorlevel 1 (echo  Telefono non collegato o debug USB non autorizzato. & echo  L'APK e' pronto qui: %cd%\LIPPOLIS-PT.apk & goto :fine)
adb install -r "LIPPOLIS-PT.apk"
if errorlevel 1 goto :errore
echo.
echo  FATTO. Apri LIPPOLIS PT sul telefono.
goto :fine

:errore
echo.
echo  ERRORE. Copia il messaggio qui sopra e mandamelo.

:fine
echo.
pause
