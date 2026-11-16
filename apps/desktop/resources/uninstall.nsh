; The Windows uninstaller's "Remove all connections the app created" (PLAN.md §3.8 S12, IMPLEMENTATION.md §2.6): the
; app's no-window mode removes every instance's links, marked blocks, exclude entries and copies. Library folders stay.
; Not on an update: the new version keeps everything.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Remove all connections the app created?$\r$\nYour library folders stay where they are." /SD IDYES IDNO skipRemoveEverything
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --device-operation=remove-everything'
    skipRemoveEverything:
  ${endIf}
!macroend
