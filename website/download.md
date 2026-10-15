# 下载与安装

前往 [Releases](https://github.com/xy200303/yuncast/releases/latest) 下载最新版：

| 平台 | 文件 |
| ---- | ---- |
| Windows x64 | `YunCast.Setup.<版本号>.exe` |
| macOS（Apple Silicon） | `YunCast-<版本号>-arm64.dmg`、`YunCast-<版本号>-arm64.zip` |
| Linux x64 | `YunCast-<版本号>-x64.AppImage`、`YunCast-<版本号>-x64.deb` |

## Windows

双击 exe 按向导安装即可。

::: warning SmartScreen 提示
安装包没有代码签名。Windows 可能弹出「Windows 已保护你的电脑」——点「**更多信息**」→「**仍要运行**」即可。
:::

## macOS

打开 dmg 拖进「应用程序」，或使用 zip 解压。首次打开提示「应用已损坏」时执行：

```bash
xattr -cr /Applications/小云播客坊.app
```

真人接管播报用到麦克风，首次使用时系统会弹权限申请，允许即可。

## Linux

- AppImage：chmod +x 后直接运行
- deb：`sudo dpkg -i YunCast-<版本号>-x64.deb`

::: warning 注意
macOS 与 Linux 版本暂未真机验证，窗口细节与音频设备路由如有问题欢迎到 [Issue](https://github.com/xy200303/yuncast/issues) 反馈。
:::

## 系统要求

- 稳定的网络（LLM 与 TTS 走云端 API）
- 需要直播推流时，建议 8GB 以上内存

## 卸载与数据

卸载程序不会删除你的数据。主播、节目、音色库等数据保存在用户数据目录（Windows 是 `%APPDATA%\YunCast`，macOS 是 `~/Library/Application Support/YunCast`，Linux 是 `~/.config/YunCast`），需要彻底清空时手动删除该目录。
