## 0.3.2

**修复版：安装版语音合成全线失败的问题。如果你装过 0.3.0 / 0.3.1，请直接升级到这一版。**

### 致命修复：打包版找不到 ffmpeg

- **现象**：装好的应用第一次合成就报「音频解码失败：spawn …\app.asar\node_modules\ffmpeg-static\ffmpeg.exe ENOENT」，所有段全部失败，等于出不了声
- **原因**：`ffmpeg-static` 返回的是「依赖里的位置」，打包后这个位置落在 `app.asar` 归档里。归档不是目录，`spawn` 它必然 ENOENT，而二进制其实被 electron-builder 解到了旁边的 `app.asar.unpacked`
- **修复**：统一在 `getFfmpegPath()` 里把 `app.asar` 段换成 `app.asar.unpacked` 再校验文件存在；Windows / macOS / Linux 同一套处理，三种路径形态都验过（含带引号、带空格、中文用户名）
- 启动日志新增一行 `[YunCast] ffmpeg: <实际路径>`，以后这类问题一眼可见
- 为什么一直没被发现：只有**安装版**受影响，`npm run dev` 跑源码时 `node_modules` 是真实目录，一直是好的

### 升级说明

- 直接覆盖安装，数据与配置不受影响（数据库仍是 `yuncast.db`）
- 装完后可看启动日志里的 ffmpeg 行确认指向 `app.asar.unpacked`；能正常合成即修复

### 已知事项

- macOS 未公证构建，首次打开需右键「打开」；这与本次修复无关
- Linux 的 deb / AppImage 若出现 `EACCES`（而非 ENOENT），说明打包时丢了执行位，请反馈
