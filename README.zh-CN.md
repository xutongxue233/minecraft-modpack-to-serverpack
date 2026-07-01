# Minecraft 整合包转服务端包工具

简体中文 | [English](./README.md)

这是一个面向 Minecraft Java 版的桌面工具，用于把客户端整合包转换为更适合服务端部署的服务端包。目标用户包括整合包作者、服主和需要将 CurseForge、Modrinth、packwiz 整合包整理为服务端包的玩家。

搜索关键词：Minecraft 服务端包生成器、Minecraft 整合包转换工具、CurseForge 服务端包、Modrinth 服务端包、packwiz 服务端包、客户端 Mod 过滤、Electron 桌面应用。

## 功能特性

- 基于 Electron、React、TypeScript 和 pnpm workspace 的桌面程序。
- 支持读取 CurseForge `.zip`、Modrinth `.mrpack` 和 packwiz 目录。
- 通过 CurseForge API 把 `projectID/fileID` 数字条目补全为真实 Mod 名称、文件名和下载地址。
- 通过 Modrinth SHA-1 version lookup 和项目元数据补全文件信息。
- 从 JAR 中读取 `fabric.mod.json`、`quilt.mod.json`、`META-INF/mods.toml`、`META-INF/neoforge.mods.toml`、`mcmod.info`。
- 桌面端提供 Mod 复核清单，支持搜索、按决策筛选、批量保留、批量排除和行级重置。
- 支持 GitHub 远程项目级客户端 Mod 规则库和 JSON/YAML 用户规则文件，按 CurseForge projectID、Modrinth projectID、modId、slug 等稳定标识固定包含/排除规则。
- 生成转换报告，包含文件决策、下载状态、哈希、警告和人工复核项。
- 单个 Mod 下载失败时仍会生成初版报告，并把对应文件标记为 `failed`。
- Mod 清单预览支持滚动展示完整列表，并完整显示 JAR 文件名和版本。
- 生成服务端包目录，包含筛选后的 `mods/`、服务端安全 overrides、`server-core.json`、EULA 占位文件、JVM 参数、安装脚本和启动脚本。
- 可选在输出目录同级生成便于分发的服务端包 `.zip`。
- 根据整合包元数据选择 Vanilla、Fabric、Quilt、Forge 或 NeoForge 服务端核心，并给出 Java 版本建议。
- 可选直接下载/安装服务端核心，接受 EULA 后即可从 `start.bat` / `start.ps1` 启动。
- 直接下载核心后可运行启动脚本测试，日志会显示在桌面端任务日志中；测试只验证到 EULA 检查，不会自动接受 EULA。
- 支持在桌面端配置 Java Home；生成的服务端脚本会先读取 `java-home.txt`，再回退到 `JAVA_HOME` 和系统 `java`。
- 下载阶段按 Mod 下载和核心下载分组显示进度；Mod 下载展示已完成数量、百分比和当前文件，核心下载展示字节进度。

## 当前状态

项目处于 MVP 早期阶段。当前已经覆盖输入解析、平台元数据补全、下载校验、服务端 Mod 筛选、远程项目级规则库、人工复核、用户规则文件、初版服务端目录生成、可选服务端核心直接安装、可选 zip 输出、报告生成和桌面工作流。packwiz 远程 metafile 和发布自动化会继续完善。

## 支持格式

| 格式 | 状态 | 说明 |
| --- | --- | --- |
| CurseForge `.zip` | MVP | 需要 CurseForge API Key 才能补全名称和下载地址。 |
| Modrinth `.mrpack` | MVP | 读取 `modrinth.index.json`、hash、downloads 和 env 元数据。 |
| packwiz 目录 | MVP | 读取 `pack.toml` 和 `index.toml`，远程 metafile 支持仍在完善。 |

## 为什么需要这个工具

很多 Minecraft 整合包默认面向客户端发布。服务端包通常需要额外处理：

- 移除或复核纯客户端 Mod；
- 保留服务端 Mod 和双端 Mod；
- 合并服务端安全的 overrides；
- 保留哈希和来源信息，方便审计；
- 在输出可运行服务端前先生成可读报告。

这个工具的目标是把这些步骤变得可见、可复现，而不是靠手工删文件。

## 截图和安装包

截图、安装包和便携版建议通过 GitHub Releases 发布。首次公开 Release 前，可以按下面命令在本地构建。

## 快速开始

### 环境要求

- Node.js 22 或更高版本
- pnpm 11
- 当前打包脚本面向 Windows
- 可选：CurseForge API Key，用于 CurseForge 整合包的名称补全和下载地址解析

### 安装依赖

```bash
pnpm install
```

### 开发运行

```bash
pnpm dev
```

### 构建

```bash
pnpm build
```

### 打包 Windows 版本

```bash
pnpm dist:win
```

构建产物位于 `apps/desktop/release/`。该目录不会提交到 Git，二进制文件应通过 GitHub Releases 发布，而不是直接提交到源码仓库。

## Mod 规则文件

桌面端默认启用 GitHub 远程项目级规则库，规则库文件位于 `rules/client-mod-rules.json`，发布后会通过 GitHub raw URL 拉取并缓存到本机。远程规则维护的是项目级稳定标识，不维护每个版本的 `fileID` 或 hash。

桌面端也可以选择 `.json`、`.yaml` 或 `.yml` 用户规则文件。优先级为：远程规则 < 用户规则文件 < 本次界面人工复核。

```json
{
  "include": ["server-helper.jar"],
  "exclude": [
    {
      "source": "curseforge",
      "projectId": "1234",
      "fileId": "5678",
      "reason": "client-only"
    }
  ],
  "rules": [
    {
      "id": "modmenu",
      "side": "client",
      "decision": "exclude",
      "reason": "客户端 Mod 菜单，不需要进入服务端。",
      "match": {
        "modrinthProjectIds": ["mOgUt4GM"],
        "curseforgeProjectIds": ["308702"],
        "modIds": ["modmenu"],
        "slugs": ["modmenu"]
      },
      "loaders": ["fabric", "quilt"],
      "minecraftVersions": [">=1.16"]
    }
  ]
}
```

## CurseForge API Key

CurseForge 导出的整合包通常只包含数字形式的 `projectID` 和 `fileID`。要显示真实 Mod 名称并获取下载地址，需要配置 CurseForge API Key。

配置方式：

- 在桌面程序里粘贴到 CurseForge API Key 输入框。
- 或启动程序前设置环境变量 `CURSEFORGE_API_KEY` 或 `CF_API_KEY`。

Key 只保存在本机应用配置中，不会以明文返回给渲染进程。不要提交 key、token、`.env` 文件或本机 `config.json`。

## 项目结构

```text
apps/desktop/        Electron 桌面程序
packages/core/       整合包解析、元数据补全、下载、报告
packages/shared/     共享类型、schema 和错误结构
docs/                需求文档、架构文档、开发计划
```

## 开发命令

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm dist:win
```

## 安全说明

- 解压路径会做安全校验，避免路径穿越。
- 下载地址默认必须使用 HTTPS。
- 当整合包或平台元数据提供支持的 hash 时，会进行哈希校验。
- API key 泄露后应立即轮换；本仓库 `.gitignore` 已忽略常见本地配置和密钥文件。

## 路线图

- 完善 `overrides/` 和 `server-overrides/` 合并规则，支持用户自定义过滤。
- 强化加载器核心直接安装能力，增加更多兼容性校验和失败回退。
- 增加可编辑的客户端专用和服务端专用规则库。
- 增加 GitHub Release 自动化，发布 Windows 安装包和便携版。
- 改进 packwiz 远程元数据和 hash 处理。

## 参与贡献

欢迎提交 issue 和 pull request。反馈问题时建议提供：

- 整合包格式和来源；
- Minecraft 版本和加载器；
- 是否已配置 CurseForge API Key；
- 去除敏感信息后的 `conversion-report.json`。

## 许可证

MIT License，见 [LICENSE](./LICENSE)。
