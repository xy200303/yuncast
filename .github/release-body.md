## 0.3.1

收尾版：数据库文件名与结构迁移都归到产品名下，并修掉一个只在全新安装上出现的问题。

### 数据库文件跟随产品名

- `userData/agentanchor.db` → `userData/yuncast.db`：升级后首次启动自动改名，`-wal` / `-shm` 一起搬，数据一行不动
- 改名失败（旧版进程还占着文件）时退回老文件名继续用，下次启动再搬——不会因为改名起不来

### 迁移改由 umzug 统管，一个版本一个文件

- 结构迁移从 `StorageService` 里 300 多行的 `migratePrograms()` 拆到 `src/main/db/migrations/`：`0001-programize` … `0015-material-content`，清单集中在 `migrations/index.ts`
- 执行器 `src/main/db/migrator.ts` 用 umzug：整批一个事务、失败整体回滚；执行明细落 `_migrations` 表，同时回写 `PRAGMA user_version` 便于排查
- 老库按 `user_version` 做基线：第一次跑新迁移器时把历史迁移登记为已执行，只补跑之后的版本，不会在长好的库上重放建表 / 改名
- 迁移改成升序执行（原先 7→6→5→15→14→12 是手工顺序）：`v12` 把 `products` 改名成 `materials`，`v15` 才给它补正文列，顺序一错老库就漏列
- **修掉一个只在全新安装上出现的问题**：v4 无条件断言改名后的表存在，空库里根本没有这些表——升级上来的老库没事，新机器会直接起不来
- `src/main/db/` 不依赖 Electron，可以脱离应用单跑；新增 `node scripts/db-migrate-check.mjs`，四个场景（全新库 / 现役库副本 / v11 老库 / v3 老库）一条命令验完

### 其他

- 全仓术语打平到最终命名：剧本 → 编排、知识库 → 素材。应用内开播预检的「去绑剧本 / 节目没绑定剧本 / 剧本里没有场景」改成编排口径，导演提示词同步；官网与文档一并改
- 官网版本徽标与更新日志补齐；功能演示换成真实操作 + 克隆音色配音（1 分 08 秒），hero 循环片、封面与 README 动图一起重做

### 升级说明

- 直接覆盖安装即可。首次启动会：① 把老库改名成 `yuncast.db`；② 建立 `_migrations` 表并按 `user_version` 登记历史迁移（这一步只登记，不改表）
- 想回退到 0.3.0：把 `yuncast.db` 改回 `agentanchor.db` 即可，结构没有变化
