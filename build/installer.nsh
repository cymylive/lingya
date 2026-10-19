; LingYa 自定义 NSIS 脚本
;
; 目的：升级安装时不要删除用户数据目录 <安装目录>\LingYa-Data
;
; 背景：
;   0.6.88 起数据目录从 %APPDATA%\lingya-ai-pro-session 改为 <安装目录>\LingYa-Data
;   （便携版和安装版统一，便于整个目录打包迁移）。
;   但 electron-builder 默认的卸载逻辑是 RMDir /r $INSTDIR，升级时会连带删掉用户数据。
;
; 为什么用 customInit 而不是 preInit：
;   升级时执行的是【旧版本】的卸载器，旧版本里没有我们的 customRemoveFiles 宏，
;   所以那道防线对「0.6.87 -> 0.6.88」这种跨版本升级完全无效。
;
;   而 preInit 虽然也在旧卸载器之前，但它挂在 .onInit 最开头（installer.nsi 第 48 行），
;   那时 $INSTDIR 还没被赋值 —— multiUser.nsh 的 initMultiUser 要到第 190 行才
;   从注册表读出旧安装路径。preInit 阶段 $INSTDIR 是空字符串，备份必然失败。
;
;   customInit 挂在 initMultiUser 之后（installer.nsi 第 192 行），此时 $INSTDIR
;   已是旧安装目录，且仍在 installSection.nsh 的 uninstallOldVersion（第 52 行）之前。
;
; 执行顺序（见 node_modules/app-builder-lib/templates/nsis/）：
;   installer.nsi .onInit -> initMultiUser (第 190 行，设 $INSTDIR)
;     -> customInit (第 192 行，此时备份旧数据)
;     -> installSection.nsh uninstallOldVersion (第 52 行，跑旧卸载器，删 $INSTDIR)
;     -> installApplicationFiles (第 66 行，铺新文件)
;     -> customInstall (第 81 行，还原数据)

!define LINGYA_DATA_DIRNAME "LingYa-Data"
!define LINGYA_BACKUP_DIR "$TEMP\LingYa-Data-Upgrade-Backup"

; ===== customInit：$INSTDIR 已确定、旧卸载器尚未动手，先把数据备份到 %TEMP% =====
!macro customInit
  ; 只在升级场景生效（全新安装时 $INSTDIR 下没有 LingYa-Data）
  ${if} ${FileExists} "$INSTDIR\${LINGYA_DATA_DIRNAME}\*.*"
    DetailPrint "Backing up existing user data before upgrade..."
    ; 清掉可能残留的旧备份（上次升级中断等）
    RMDir /r "${LINGYA_BACKUP_DIR}"
    CreateDirectory "${LINGYA_BACKUP_DIR}"

    ; 用 xcopy 递归复制（NSIS 的 CopyFiles 不递归子目录）
    nsExec::ExecToLog 'xcopy /E /I /Y /Q "$INSTDIR\${LINGYA_DATA_DIRNAME}" "${LINGYA_BACKUP_DIR}"'
    Pop $0
    ${if} ${FileExists} "${LINGYA_BACKUP_DIR}\*.*"
      DetailPrint "User data backed up successfully (xcopy exit=$0)"
    ${else}
      DetailPrint "WARNING: user data backup failed (xcopy exit=$0), continuing anyway"
    ${endif}
  ${endif}
!macroend

; ===== customInstall：新版本文件铺完后，把数据还原回去 =====
!macro customInstall
  ${if} ${FileExists} "${LINGYA_BACKUP_DIR}\*.*"
    DetailPrint "Restoring user data..."
    CreateDirectory "$INSTDIR\${LINGYA_DATA_DIRNAME}"

    nsExec::ExecToLog 'xcopy /E /I /Y /Q "${LINGYA_BACKUP_DIR}" "$INSTDIR\${LINGYA_DATA_DIRNAME}"'
    Pop $0
    ${if} ${FileExists} "$INSTDIR\${LINGYA_DATA_DIRNAME}\*.*"
      DetailPrint "User data restored successfully (xcopy exit=$0)"
      RMDir /r "${LINGYA_BACKUP_DIR}"
    ${else}
      DetailPrint "WARNING: user data restore failed (xcopy exit=$0); backup kept at ${LINGYA_BACKUP_DIR}"
    ${endif}
  ${endif}
!macroend

; ===== customRemoveFiles：保护「0.6.88 及以后版本之间的升级」=====
; preInit 已经覆盖所有升级场景（跑在旧卸载器之前），这里再加一道防线：
; 万一将来 preInit 因某种原因没跑成，卸载器自己也不删数据。
!macro customRemoveFiles
  ${if} ${isUpdated}
    DetailPrint "Upgrade detected: preserving user data directory"
    RMDir /r "${LINGYA_BACKUP_DIR}-uninst"
    ${if} ${FileExists} "$INSTDIR\${LINGYA_DATA_DIRNAME}\*.*"
      nsExec::ExecToLog 'xcopy /E /I /Y /Q "$INSTDIR\${LINGYA_DATA_DIRNAME}" "${LINGYA_BACKUP_DIR}-uninst"'
      Pop $0
    ${endif}
    RMDir /r $INSTDIR
    ${if} ${FileExists} "${LINGYA_BACKUP_DIR}-uninst\*.*"
      CreateDirectory "$INSTDIR\${LINGYA_DATA_DIRNAME}"
      nsExec::ExecToLog 'xcopy /E /I /Y /Q "${LINGYA_BACKUP_DIR}-uninst" "$INSTDIR\${LINGYA_DATA_DIRNAME}"'
      Pop $0
      RMDir /r "${LINGYA_BACKUP_DIR}-uninst"
    ${endif}
  ${else}
    ; 全新卸载：保持 electron-builder 默认行为（用户主动卸载，数据一起删）
    RMDir /r $INSTDIR
  ${endif}
!macroend
