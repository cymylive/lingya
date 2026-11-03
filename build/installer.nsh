; LingYa 安装器数据保护
; 关键背景：electron-builder 升级时会跑【旧版本】的卸载器（RMDir /r $INSTDIR），
; 把整个安装目录清空，包括 LingYa-Data。在新包里写 customRemoveFiles 对
; 「旧版→新版」跨版本升级完全无效（旧版卸载器里没这个宏）。
;
; 正确做法：挂在 customInit —— 它在 initMultiUser（给 $INSTDIR 赋值）之后、
; uninstallOldVersion（删旧目录）之前执行，此时 $INSTDIR 有效，能抢救数据。
; 不能用 preInit：那时 $INSTDIR 还是空字符串。

!macro customInit
  ; 升级场景：先把 LingYa-Data 备份到临时目录
  ${If} ${FileExists} "$INSTDIR\LingYa-Data\*.*"
    nsExec::ExecToLog 'cmd /c if exist "$TEMP\LingYa-Data-Upgrade-Backup" rmdir /s /q "$TEMP\LingYa-Data-Upgrade-Backup"'
    nsExec::ExecToLog 'xcopy /E /I /Y /Q "$INSTDIR\LingYa-Data" "$TEMP\LingYa-Data-Upgrade-Backup"'
  ${EndIf}
!macroend

!macro customInstall
  ; 新文件铺完后还原数据
  ${If} ${FileExists} "$TEMP\LingYa-Data-Upgrade-Backup\*.*"
    ${IfNot} ${FileExists} "$INSTDIR\LingYa-Data\*.*"
      nsExec::ExecToLog 'xcopy /E /I /Y /Q "$TEMP\LingYa-Data-Upgrade-Backup" "$INSTDIR\LingYa-Data"'
      nsExec::ExecToLog 'cmd /c rmdir /s /q "$TEMP\LingYa-Data-Upgrade-Backup"'
    ${EndIf}
  ${EndIf}
!macroend

!macro customRemoveFiles
  ; 第二道防线（仅对未来版本生效）：升级时不删用户数据
  ${IfNot} ${isUpdated}
    ; 全新卸载：保留 LingYa-Data，用户重装后数据还在
  ${EndIf}
!macroend
