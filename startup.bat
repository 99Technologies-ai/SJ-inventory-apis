@echo off
echo Forcing directory change...

REM PASTE YOUR FOLDER'S FULL PATH ON THE NEXT LINE
cd /d "C:\Users\99tech\Desktop\sj-inventory-api-staging"

echo Starting server from: %cd%

REM Now run the server
node server.js

pause