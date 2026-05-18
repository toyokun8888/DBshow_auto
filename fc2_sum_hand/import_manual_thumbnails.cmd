@echo off
setlocal

cd /d "%~dp0\.."

echo ============================================================
echo FC2 Manual Thumbnail Import
echo Input : %CD%\fc2_sum_hand
echo Output: %CD%\fc2_sum
echo ============================================================
echo.
echo This will MOVE valid jpg/jpeg files from fc2_sum_hand to fc2_sum
echo and register them in PostgreSQL as collected thumbnails.
echo.
pause

node fc2_manual_thumbnail_import_operational.js --mode execute --confirm-execute YES

echo.
echo Finished. Check the result above.
pause
