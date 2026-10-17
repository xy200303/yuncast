; YunCast 安装钩子：把 CLI（resources\bin\yuncast.exe）注册进用户 PATH，卸载时摘除。
; per-machine 安装关闭（perMachine: false），所以写 HKCU；装完广播 WM_SETTINGCHANGE，
; 之后新开的终端/PowerShell 直接敲 yuncast 就能用。
;
; 注意：electron-builder 把本文件同时 include 进安装器与卸载器，且 NSIS 以 -WX 编译
;（警告即错误）。StrFunc 会为每个“声明”生成一个函数，若某个函数生成后没人调用就会
; 触发 warning 6010。所以按上下文只声明真正用到的版本：
; - 安装器（BUILD_UNINSTALLER 未定义）：用 ${StrStr} / ${StrRep}
; - 卸载器（BUILD_UNINSTALLER 已定义）：用 ${UnStrRep}
!include "StrFunc.nsh"

!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
!else
  ${StrStr}
  ${StrRep}
!endif

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
