---
title: 下载与安装
description: 下载小云播客坊 YunCast：Windows 安装包、macOS（Apple Silicon）dmg 与 zip、Linux AppImage 与 deb，含系统要求、SmartScreen 与「应用已损坏」的处理办法、自动更新、用户数据目录与备份卸载说明。
---

# 下载与安装

前往 [Releases](https://github.com/xy200303/yuncast/releases/latest) 下载最新版：

| 平台 | 文件 |
| ---- | ---- |
| Windows x64 | `YunCast.Setup.<版本号>.exe` |
| macOS（Apple Silicon） | `YunCast-<版本号>-arm64.dmg`、`YunCast-<版本号>-arm64.zip` |
| Linux x64 | `YunCast-<版本号>-x86_64.AppImage`、`YunCast-<版本号>-amd64.deb` |

只发布 x64 的 Windows / Linux 包与 arm64（Apple Silicon）的 macOS 包，没有 32 位、也没有 Intel Mac 版本。

## Windows

双击 exe 按向导安装，向导里可以改安装路径。

::: warning SmartScreen 提示
安装包没有代码签名。Windows 可能弹出「Windows 已保护你的电脑」——点「**更多信息**」→「**仍要运行**」即可。
:::

## macOS

打开 dmg 拖进「应用程序」，或使用 zip 解压。macOS 会拦截未签名应用，提示「应用已损坏」或「无法验证开发者」时执行：

```bash
xattr -cr /Applications/小云播客坊.app
```

音色库里的「现场录音」要用麦克风，首次录制时系统会弹权限申请，允许即可。

## Linux

- AppImage：`chmod +x` 后直接运行
- deb：`sudo dpkg -i YunCast-<版本号>-amd64.deb`

::: warning 注意
macOS 与 Linux 版本暂未真机验证，窗口细节与音频设备路由如有问题欢迎到 [Issue](https://github.com/xy200303/yuncast/issues) 反馈。
:::

## 系统要求

软件本身是 Electron 44 应用，支持的系统版本跟随它：

| 项目 | 要求 |
| ---- | ---- |
| Windows | Windows 10 及以上（x64） |
| macOS | macOS 13 Ventura 及以上，仅 Apple Silicon（arm64） |
| Linux | x64，主流发行版（Ubuntu / Fedora / Debian 等受 Chromium 支持的版本）；AppImage 免安装 |
| 网络 | 需要稳定网络：语言模型与语音合成都走你自配的云端 API |
| 内存 | 建议 4GB 以上；直推模式（FFmpeg 连续转码）建议 8GB 以上 |
| 磁盘 | 预制节目的音频与导出文件都存在本机，建议预留数 GB |

FFmpeg 随安装包分发（`ffmpeg-static`），不需要另外安装。软件运行本身不收费，但需要在「设置」里填自己的语言模型与语音合成 API Key，调用费用按服务商计价。

## 首次启动

第一次打开会进「新手指引」，一张「还差几步就能开播」的清单，四项：给导演配大脑（语言模型）、配语音合成、建一张主播卡、建第一个节目。点每一项右边的按钮直达对应页面。这份清单随时可以从「设置 → 关于」重新打开。

接下来做什么，见[快速上手](/guide/quickstart)。

## 更新

应用会向 GitHub Releases 查询新版本，有新版本时「设置 → 关于」里可以直接下载并重启安装。想手动确认就点那一栏的「检查更新」。也可以直接回 Releases 页下载新安装包覆盖安装，数据目录不受影响。

## 数据与备份

卸载程序**不会删除数据**。主播、节目、音色库、知识库、场次记录都保存在用户数据目录：

| 系统 | 目录 |
| ---- | ---- |
| Windows | `%APPDATA%\YunCast` |
| macOS | `~/Library/Application Support/YunCast` |
| Linux | `~/.config/YunCast` |

目录里有数据库文件、凭据加密密钥、音频缓存、克隆音色样本、知识库文件与崩溃日志。备份就是**把整个目录拷走**，恢复时拷回同一位置即可；换机器时整目录带过去，节目、场次、音色都会跟着走。想彻底清空也只需删除这个目录——在那之前先确认里面没有你要留的东西。
