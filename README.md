# DSH Cursor Integration

通过 Cursor 官方 SDK 在 DSH 中使用 Cursor 模型，并管理多账号用量、代理和本地会话状态。

本项目使用自己的插件标识、配置页、SDK 调度和工具桥接实现。
安装包名为 dsh-cursor-integration，配置条目 ID 为 cursor-integration，
模型提供方 ID 为 cursor。

## 功能

- 多套 API Key，通过 DSH 凭据服务保存密钥，插件配置只保存引用。
- 后台刷新账号用量，根据模型类别和账期进度选择账号。
- 可配置 HTTP 代理，为 Cursor 域名的 fetch、HTTPS、HTTP/2 请求提供代理。
- 工具调用由 DSH 审批并执行。重复 SDK 调用 ID 共享原执行结果。
- 同一 Agent 接收后续消息；已完成轮次使用本地检查点跨进程恢复。
- SSH 会话可以读取当前 SDK 运行生成的本地工具输出文件。
- 显示账号用量、本地上下文、检查点恢复及真实压缩事件。
- 专门处理摘要请求，支持文字、图片输入能力和上下文容量设置。

## 环境与安装

需要 Node.js 24.9 或以上，DSH 的 LLM 接口至少为 0.2.1-rc.3。
Cursor SDK 固定为 1.0.40，需要可用的 Cursor API Key 和模型权限。

在 DSH 插件管理器中填写 tgz 安装包的绝对路径。
进入设置中的 Cursor Integration，保存账号名称和 API Key，
获取模型目录，添加需要的型号，保存配置。
图片输入需要明确声明，未知型号会显示未声明。

代理软件提供 HTTP 或混合端口时，可以填写 http://127.0.0.1:7890。
端口以当前机器实际配置为准。能力声明不会在每条消息前查询网络。

## 旧本地版本迁移

旧包与本项目都注册 DSH 的 cursor 提供方，同一 profile 应只启用其中一个。

1. 完全退出 DSH，备份 profile 配置。
2. 安装本项目，并禁用旧 cursor-provider 条目。
3. 将旧条目 config 下的 proxyUrl 和 providers 内容复制到新 cursor-integration 条目。
   保留 credential-ref，可以继续使用同机的已有密钥。
4. 新集成可以从 DSH 历史重建 Agent，再为它保存自己的检查点。

新机器需要自行填写密钥。安装包不包含账号、用量缓存、会话或检查点。

## 配置示例

    - id: cursor-integration
      name: dsh-cursor-integration
      config:
        proxyUrl: http://127.0.0.1:7890
        providers:
          cursor:
            apiKeyEnv: CURSOR_API_KEY
            usageRefreshMinutes: 5
            models:
              - id: your-model-id
                name: Your model
                inputModalities:
                  - text
                  - image

模型 ID 和参数以当前账号的目录为准。
contextWindow 单位为 Token，应填写后端实际支持的容量。

## 上下文与压缩

Cursor SDK 管理自己的 Agent 运行时和内部提示。
本地上下文估算只能统计 DSH 可见内容。SDK 隐藏历史和内部压缩采用不同口径。

DSH 的自动压缩由 @deepseek-ai/dsh-compaction-basic 管理。
thresholdRatio 为 0.7 时，按 DSH 的估算压力在约 70% 时检查是否需要摘要。
工具结果裁剪可能先降低压力。状态行分别显示摘要和裁剪记录。

SDK 不公开硬输出 Token 上限。压缩请求中的 maxTokens 转为提示指导，
最终是否缩短到要求由 DSH 检查。

## 本地数据

目录为 ~/.dsh/storages/dsh-cursor-integration/。

- 默认账号和模型线路保存元数据。
- 检查点含对话和工具输出，应作为本机聊天数据管理。
- 仅完整结束的轮次标记为可恢复。恢复前核对账号、模型、工具、工作区和历史。
- 匹配失败时从 DSH 历史重建。
- 429、网络或临时服务失败会保留尚未发送新消息的检查点。
- 启动时及每 6 小时清理，空闲检查点默认保留 7 天、最多 32 份，
  SDK 状态文件总量目标为 1 GiB，正在使用的数据跳过清理。

## 开发

    npm ci --legacy-peer-deps
    npm run build
    npm test
    npm pack

package-lock.json 锁定依赖。构建脚本生成 DSH ModuleLoader 可加载的 src/client.js。
测试使用模拟 SDK，包含账号、输入能力、工具校验、重试去重、取消、
历史裁剪、压缩、代理及进程直接退出后的检查点恢复。

正式发布前还需在目标 DSH 桌面版本中验证配置页和真实工具调用。
本次重写版尚未替换原来使用的插件。

## 发布

源码包含 src、client、scripts、测试和锁文件。
安装包只包含运行代码、bundle 配置、README 和许可证。
GitHub 私有仓库：https://github.com/qinvnb/dsh-cursor-integration
当前版本为 0.1.0，尚未发布到 npm；仓库将在验收后再决定是否公开。

## 第三方依赖与许可证

依赖 @cursor/sdk、DSH 公共接口、Ajv、Zod 和 Undici，
其各自的许可证由依赖发布包提供。
浏览器 bundle 内的依赖声明由构建工具保留。
本项目使用 MIT，见 LICENSE。
