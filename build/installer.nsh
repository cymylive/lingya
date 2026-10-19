; ===== LingYa 自定义安装脚本 =====
; 在「选择安装目录」之后插入「选择数据目录」页面。
; 数据目录写入 $INSTDIR\data-location.txt，主进程启动时读取。
;
; 注意 1：整体包在 !ifndef BUILD_UNINSTALLER 内。
;   卸载器编译时 assistedInstaller.nsh 会跳过 customPageAfterChangeDir 宏，
;   若 Var 声明在块外会触发 NSIS warning 6001（变量未使用），而 electron-builder 把 warning 当错误。
; 注意 2：宏插入位置在顶层，不能直接写 StrCpy（NSIS 限制：StrCpy 只能在 Section/Function 内），
;   默认值初始化放进 DataDirPageCreate 函数开头。

!ifndef BUILD_UNINSTALLER

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var DataDirDialog
Var DataDirEdit
Var DataDirBrowseBtn
Var DataDirValue

!macro customPageAfterChangeDir
  Function DataDirPageCreate
    ${If} $DataDirValue == ""
      StrCpy $DataDirValue "$APPDATA\lingya-ai-pro-session"
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "选择数据目录" "选择存放记忆、会话、配置等用户数据的位置"
    nsDialogs::Create 1018
    Pop $DataDirDialog
    ${If} $DataDirDialog == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "数据目录将保存你的记忆、技能、会话、窗口配置等。$\r$\n建议不要放在程序安装目录，方便升级或卸载时保留数据。"
    Pop $0
    ${NSD_CreateLabel} 0 32u 100% 12u "数据目录："
    Pop $0
    ${NSD_CreateDirRequest} 0 46u -60u 14u "$DataDirValue"
    Pop $DataDirEdit
    ${NSD_CreateBrowseButton} -58u 46u 58u 14u "浏览…"
    Pop $DataDirBrowseBtn
    ${NSD_OnClick} $DataDirBrowseBtn DataDirBrowse
    ${NSD_CreateLabel} 0 68u 100% 24u "默认：%APPDATA%\lingya-ai-pro-session（C 盘用户目录）$\r$\n如需放到 D 盘，直接修改路径或点「浏览」。"
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function DataDirBrowse
    ${NSD_GetText} $DataDirEdit $0
    nsDialogs::SelectFolderDialog "选择数据目录" "$0"
    Pop $1
    ${If} $1 != error
      ${NSD_SetText} $DataDirEdit "$1"
    ${EndIf}
  FunctionEnd

  Function DataDirPageLeave
    ${NSD_GetText} $DataDirEdit $DataDirValue
    ${If} $DataDirValue == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "请填写数据目录路径。"
      Abort
    ${EndIf}
  FunctionEnd

  Page custom DataDirPageCreate DataDirPageLeave
!macroend

!macro customInstall
  CreateDirectory "$DataDirValue"
  FileOpen $0 "$INSTDIR\data-location.txt" w
  FileWrite $0 "$DataDirValue"
  FileClose $0
  DetailPrint "数据目录：$DataDirValue"
!macroend

!endif
