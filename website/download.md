---
title: 下载与安装
description: 下载小云播客坊 YunCast Windows 安装包：系统要求、SmartScreen 处理、自动更新、数据目录与备份说明。
---

# 下载与安装

前往 [Releases](https://github.com/xy200303/yuncast/releases/latest) 下载最新版：

| 平台 | 文件 |
| ---- | ---- |
| Windows x64 | `YunCast.Setup.<版本号>.exe` |

当前发布以 Windows x64 为主；macOS / Linux 可从源码自行构建。

## Windows

双击 exe 按向导安装，向导里可以改安装路径。

::: warning SmartScreen 提示
安装包没有代码签名。Windows 可能弹出「Windows 已保护你的电脑」——点「**更多信息**」→「**仍要运行**」即可。
:::

## 系统要求

软件本身是 Electron 44 应用，支持的系统版本跟随它：

| 项目 | 要求 |
| ---- | ---- |
| Windows | Windows 10 及以上（x64） |
| 网络 | 需要稳定网络：语言模型与语音合成都走你自配的云端 API |
| 内存 | 建议 4GB 以上；直推模式（FFmpeg 连续转码）建议 8GB 以上 |
| 磁盘 | 预制节目的音频与导出文件都存在本机，建议预留数 GB |

FFmpeg 随安装包分发（`ffmpeg-static`），不需要另外安装。软件运行本身不收费，但需要在「设置」里填自己的语言模型与语音合成 API Key，调用费用按服务商计价。

## 首次启动

第一次打开是项目启动页：新建项目 / 打开项目 / 打开文件夹，下面是最近项目。进入项目后先到「设置」配好语言模型与语音合成。

接下来做什么，见[快速上手](/guide/quickstart)。

## 更新

应用会向 GitHub Releases 查询新版本，有新版本时「设置 → 关于」里可以直接下载并重启安装。想手动确认就点那一栏的「检查更新」。也可以直接回 Releases 页下载新安装包覆盖安装，数据目录不受影响。

## 数据与备份

卸载程序**不会删除数据**。应用配置与音色库在用户数据目录；**项目内容在各自的目录里**（默认「文档 / YunCast Projects / <项目名>」），两处都要备份：

| 系统 | 目录 |
| ---- | ---- |
| Windows | `%APPDATA%\YunCast` |
| macOS | `~/Library/Application Support/YunCast` |
| Linux | `~/.config/YunCast` |

用户数据目录里有应用数据库、凭据加密密钥、音频缓存、克隆音色样本与崩溃日志。备份就是**把用户数据目录和项目目录一起拷走**；换机器时两边放回同一位置即可。
