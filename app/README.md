# 应用接口与边界

记录：2026-11-07，Asia/Shanghai（UTC+08:00）。本文件描述 `0.1.0` 应用的实现，不代替手机验收记录。运行时固定为 `@earendil-works/pi-coding-agent@1.5.0`。

`pi-termux configure` 在交互 TTY 中采集 HTTPS 地址、协议、模型 ID、reasoning 声明、上下文和输出 token 元数据，再采集不回显的 API Key。首次配置必须提供密钥；已有密钥时留空保留原内容。配置中不接受 URL 用户名/密码、查询参数或片段。协议只接受 `anthropic-messages` 与 `openai-completions`。API Key 没有命令行参数入口。

`pi-termux configure --defaults` 是显式的自动化入口：使用 DeepSeek Anthropic 默认配置，从进程环境 `TERMUX_PI_API_KEY` 读取新密钥；变量为空时只保留已有密钥，没有已有密钥则失败。不要把真实值写在交互 shell 命令或 shell 历史里。环境可由可信父进程从已有私有文件读入，应用不搜索其他项目的凭据。

安装根默认为 `$HOME/.termux-pi`，可由绝对路径 `TERMUX_PI_HOME` 指定 HOME 内的实际子目录。应用拒绝安装路径中的符号链接。配置与密钥只在该根目录下读取；显式选择的项目文件是另一个已授权读取范围。

| 路径 | 用途 |
| --- | --- |
| `private/api-key` | 密钥，文件 `0600`，目录 `0700`；不向控制台输出内容。 |
| `config/connection.json` | 不含密钥的连接与元数据。 |
| `config/pi/models.json` | Pi 模型配置，`apiKey` 固定为 `$TERMUX_PI_API_KEY` 引用。 |
| `runtime/node_modules/@earendil-works/pi-coding-agent` | 固定版本的私有 npm prefix 运行时。 |
| `workspace` | 不传项目路径时使用的新用户项目目录。 |
| `workspaces/demo-*` | `demo` 每次创建的独立示例副本。 |

显式重新配置时，先校验字段与目标路径，再把每个文件写入同目录随机临时文件、`fsync` 并 `rename` 替换。每个文件的替换是原子的；三个文件并非一个跨文件事务。配置过程中如果设备断电，应重新运行 configure 并用 doctor 检查。

默认配置为 `https://api.deepseek.com/anthropic`、`anthropic-messages`、`deepseek-flash`、`reasoning: true`、上下文 `1048576`、输出 `8192`、文本输入。它们是客户端声明和额度设置，没有进行满窗口、最大输出或完整模型能力验收；`--thinking off` 是本版启动默认。

`doctor` 仅读取本安装目录中的包版本、公开配置和密钥文件元数据。它不读取密钥内容，不联网，也不请求模型。输出包含平台、Node 与 Pi 版本、配置摘要、密钥是否存在及模式。Windows 电脑端无法证明 POSIX `0600/0700` 权限，因此 `permissionOk` 在 Windows 为 `null`；Termux 按实际模式核对。

`demo` 不调用模型。它复制发行包中的 `example/` 到新目录，不覆盖旧项目。样例基线是 8 通过；完整测试在功能尚未实现时预期为 10 通过、5 失败，供代理实际观察失败再修改。通过 `start 路径 --prompt-file task-prompt.md` 可显式启动完整编程任务。提示文件必须是项目内的相对路径，内容通过标准输入传给 Pi，不放进命令参数。

`start` 只接受 HOME 内的现有实际项目目录，拒绝 HOME 本身、共享存储、符号链接，以及安装根里的配置/运行时/凭据/发行文件。默认项目 `workspace/` 可以首次自动创建。文件工具 read/write/edit 通过实际路径、符号链接和硬链接检查约束到项目；允许新建项目内子目录和文件，所以可处理常规开发项目。任何文件都可能包含敏感内容；用户应只选择准备交给远端模型处理的项目。

shell 是通用开发入口，可执行项目测试、构建等命令。应用固定初始 cwd、将每条工具超时限制到最多 120 秒、清理凭据类环境变量及 shell/Node 启动钩子，并保留 Termux 的 LD_PRELOAD/LD_LIBRARY_PATH 兼容环境。`!` 手工 shell 入口被替换为提示，避免绕过这组环境清理。**shell 和项目程序仍有当前 Android UID 的权限，可以访问项目外路径，甚至重新读到同 UID 私有文件；这不是 OS 沙箱。** 文件工具检查也不是消除竞态的安全边界。需要隔离不可信项目时应另行设计独立 UID/系统隔离，不能依赖本应用的 cwd 或 guard。

启动使用专用 `PI_CODING_AGENT_DIR`，明确关闭会话持久化、MCP、自动扩展、skills、context files、prompt templates 与额外 themes，只显式加载本应用 guard，只启用 read/write/edit/bash。本应用不生成原始代理会话日志；手工屏幕录制、终端滚屏和用户重定向仍由用户控制。不要把密钥放进项目、提示文件或对话。通用 shell 的权限限制如上一段，不能承诺恶意项目永远无法触及凭据。

手机入口默认带 `--tui-mode regular`。这是为规避当前全屏 mouse tracking 与 Termux 点按弹软键盘相互作用而采用的初步设置；不是完整触摸适配的验收结论。

`guard-check` 只做离线策略探测，不执行 shell、不读取私有密钥、不请求模型。`start` 在读取密钥前先用实际安装的 Pi SDK 构造一次 guard，检测加载失败并停止；这一预检不等于整个代理运行安全隔离。

实现依据是固定标签下的 [Pi CLI 参数](https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/packages/coding-agent/src/cli/args.ts)、[显式扩展与资源加载](https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/packages/coding-agent/src/core/resource-loader.ts)、[bash spawn hook](https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/packages/coding-agent/src/core/tools/bash.ts) 和 [扩展事件接口](https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/packages/coding-agent/src/core/extensions/types.ts)。固定版本真实运行结果应另见发行目录的验收记录。
