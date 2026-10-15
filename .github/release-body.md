## 0.1.1

首个三端公开版本（Windows / macOS / Linux）。

- 智能主播 Agent：人设卡、编剧模式、老粉记忆、下播复盘；可自己决定回不回评论
- 节目化播出：一个人讲 / 多人聊天 / 照着稿子读 / 分角色表演四种内容形态；现场发挥 / 边播边准备 / 全部做好再播三种播出方式
- 播出链路：话术池单一出口、TTS 多服务商（火山引擎 / 阿里云百炼 / 播客专用大模型）、声音克隆、麦克风接管、急停
- 评论互动：平台连接器（本地事件流）+ 事件收件箱自适应聚合，高频评论不刷屏、低频评论不掉
- 节目音频导出 MP3/WAV（分章或合并、响度归一），用量看板统计 LLM tokens 与 TTS 字符
- 设置新增「关于」页：版本信息、GitHub / 官网入口、检查更新（走 GitHub Releases）

| 平台 | 文件 |
| ---- | ---- |
| Windows x64 | `YunCast.Setup.0.1.1.exe` |
| macOS（Apple Silicon） | `YunCast-0.1.1-arm64.dmg`、`YunCast-0.1.1-arm64.zip` |
| Linux x64 | `YunCast-0.1.1-x64.AppImage`、`YunCast-0.1.1-x64.deb` |

安装包没有代码签名。Windows SmartScreen 提示「未知发布者」时，点「更多信息」→「仍要运行」；macOS 提示「应用已损坏」时执行 `xattr -cr /Applications/小云播客坊.app`。macOS / Linux 尚未真机验证，遇到问题欢迎提 [Issue](https://github.com/xy200303/yuncast/issues)。
