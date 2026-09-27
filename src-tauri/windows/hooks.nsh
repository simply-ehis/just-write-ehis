!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Just Write ehis"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Just Write ehis"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\JustWriteEhis"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\JustWriteEhis"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\JustWriteEhis"
  DeleteRegKey HKCU "Software\Classes\JustWriteEhis"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\JustWriteEhis" "" "Open with Just Write ehis"
  WriteRegStr HKCU "Software\Classes\Directory\shell\JustWriteEhis" "Icon" "$INSTDIR\Just Write ehis.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\JustWriteEhis\command" "" '"$INSTDIR\Just Write ehis.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\JustWriteEhis" "" "Open with Just Write ehis"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\JustWriteEhis" "Icon" "$INSTDIR\Just Write ehis.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\JustWriteEhis\command" "" '"$INSTDIR\Just Write ehis.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Drive\shell\JustWriteEhis" "" "Open with Just Write ehis"
  WriteRegStr HKCU "Software\Classes\Drive\shell\JustWriteEhis" "Icon" "$INSTDIR\Just Write ehis.exe,0"
  WriteRegStr HKCU "Software\Classes\Drive\shell\JustWriteEhis\command" "" '"$INSTDIR\Just Write ehis.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\JustWriteEhis" "" "Just Write ehis Document"
  WriteRegStr HKCU "Software\Classes\JustWriteEhis" "FriendlyTypeName" "Just Write ehis Document"
  WriteRegStr HKCU "Software\Classes\JustWriteEhis\DefaultIcon" "" "$INSTDIR\Just Write ehis.exe,0"
  WriteRegStr HKCU "Software\Classes\JustWriteEhis\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\JustWriteEhis\shell\open" "" "Open with Just Write ehis"
  WriteRegStr HKCU "Software\Classes\JustWriteEhis\shell\open\command" "" '"$INSTDIR\Just Write ehis.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\JustWriteEhis\shell\edit" "" "Edit with Just Write ehis"
  WriteRegStr HKCU "Software\Classes\JustWriteEhis\shell\edit\command" "" '"$INSTDIR\Just Write ehis.exe" "%1"'
!macroend
