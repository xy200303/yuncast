## 0.1.2

修复版本。

- 修复：结束节目后播放循环仍继续播存货——现在结束节目会同时停掉播放循环，掐断当前音频、正在播的退回就绪，存货保留不再续播
- Debian 包元数据补全作者邮箱

| 平台 | 文件 |
| ---- | ---- |
| Windows x64 | `YunCast.Setup.0.1.2.exe` |
| macOS（Apple Silicon） | `YunCast-0.1.2-arm64.dmg`、`YunCast-0.1.2-arm64.zip` |
| Linux x64 | `YunCast-0.1.2-x86_64.AppImage`、`YunCast-0.1.2-amd64.deb` |

安装包没有代码签名。Windows SmartScreen 提示「未知发布者」时，点「更多信息」→「仍要运行」；macOS 提示「应用已损坏」时执行 `xattr -cr /Applications/小云播客坊.app`。macOS / Linux 尚未真机验证，遇到问题欢迎提 [Issue](https://github.com/xy200303/yuncast/issues)。
