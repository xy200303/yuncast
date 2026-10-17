; YunCast 安装钩子：把 CLI（resources\bin\yuncast.exe）注册进用户 PATH，卸载时摘除。
; per-machine 安装关闭（perMachine: false），所以写 HKCU；装完广播 WM_SETTINGCHANGE，
; 之后新开的终端/PowerShell 直接敲 yuncast 就能用。
!include "StrFunc.nsh"
; StrFunc 的函数要先零参声明生成，后面才能带参调用；卸载脚本里用 Un 前缀的版本
${StrStr}
${StrRep}
${UnStrRep}

!macro customInstall
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrStr} $1 $0 "$INSTDIR\resources\bin"
  StrCmp $1 "" yuncast_path_add yuncast_path_done
  yuncast_path_add:
    StrLen $2 $0
    IntCmp $2 0 yuncast_path_empty yuncast_path_append yuncast_path_empty
    yuncast_path_empty:
      StrCpy $0 "$INSTDIR\resources\bin"
      Goto yuncast_path_write
    yuncast_path_append:
      StrCpy $3 $0 1 -1
      StrCmp $3 ";" yuncast_path_join yuncast_path_semi
    yuncast_path_semi:
      StrCpy $0 "$0;"
    yuncast_path_join:
      StrCpy $0 "$0$INSTDIR\resources\bin"
    yuncast_path_write:
      WriteRegExpandStr HKCU "Environment" "Path" $0
      System::Call 'user32::SendMessageTimeoutW(i 0xffff, i 0x001A, i 0, w "Environment", i 2, i 5000, *i .r1)'
  yuncast_path_done:
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Environment" "Path"
  ${UnStrRep} $1 $0 "$INSTDIR\resources\bin;" ""
  ${UnStrRep} $1 $1 ";$INSTDIR\resources\bin" ""
  ${UnStrRep} $1 $1 "$INSTDIR\resources\bin" ""
  StrCmp $1 $0 yuncast_unpath_done
  WriteRegExpandStr HKCU "Environment" "Path" $1
  System::Call 'user32::SendMessageTimeoutW(i 0xffff, i 0x001A, i 0, w "Environment", i 2, i 5000, *i .r1)'
  yuncast_unpath_done:
!macroend
