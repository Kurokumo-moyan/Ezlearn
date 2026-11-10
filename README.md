# Ezlearn · 通用学习软件（本地单用户）

把一门课的教学资料（slides、讲义、录音转写、tutorial、往年真题、数据集）变成一本**按课程自己的结构组织、零基础可读、每个结论都能追溯到原文、带交互演示**的学习书，并随课程进度增量更新。

设计规格在 [prompts/](prompts/)（`01` 主 Prompt、`02` 流水线与数据结构、`03` 学科档案）。软件运行时直接读取这些 md 文件组装提示词，改规格即可调整行为。

## 普通用户：安装与使用

1. 双击 `Ezlearn-Setup-<版本>.exe` → 安装。不需要管理员权限，也不需要自己装 Node.js：安装程序会先检查电脑上有没有可用的 Node.js（22 或更高），有就直接用，没有就把内置的一份装到软件目录里。
2. 双击桌面或开始菜单的 **Ezlearn** 图标。整个过程没有命令行窗口：先出现一个小的启动进度窗口，然后打开 Ezlearn 桌面窗口。窗口没有系统标题栏：软件名、当前位置、常用按钮和“最小化 / 最大化 / 关闭”都在界面顶部的标题栏里，空白处可以拖动窗口、双击最大化、拖到屏幕边缘贴靠。再次双击图标会把已打开的窗口调到前面。
3. 第一次使用：首页点"导入示例课程"先看看效果；要用自己的课程，到 **⚙ 设置** 里选 AI 公司、粘贴 API 密钥，软件会自动获取这家公司可用的模型让你选。
   使用说明内置在软件里：每个功能标题旁边都有一个小圆形 **?**，鼠标移上去临时查看，点一下固定显示（点提示框外面就关闭）；标题栏右上角的 **?** 是窗口操作和常见问题。
4. 关闭窗口即退出：没有任务在运行时后台服务立即退出；有任务在运行时会先做完再退出。
5. 数据位置：课程、学习书、书签、设置、窗口缓存和日志都在安装位置里的 `data` 文件夹（不占系统盘）；设置页最下面写着具体路径。0.5.0 及以前的安装用的是 `%APPDATA%\Ezlearn`，升级时沿用原位置（`/Data=data` 可改到安装目录）。
6. 卸载：Windows "设置 → 应用" 里找到 Ezlearn，或开始菜单里的"卸载 Ezlearn"。会删除程序、内置 Node.js、快捷方式、浏览器窗口配置和日志；勾选后还会删除全部课程数据。电脑上原有的 Node.js 不会被动。

## 开发者

```bash
npm install
```

```bash
npm start
```

浏览器打开 <http://127.0.0.1:5855/>。也可以用 `npm run demo:seed` 从命令行导入虚构的示例课程（不需要 API key）。

生成安装包（Windows，只用系统自带的 C# 编译器和 PowerShell）：

```bash
npm run build:installer
```

输出 `dist/Ezlearn-Setup-<版本>.exe` 和 `.sha256`。构建脚本会从 nuget.org 下载固定版本的 WebView2 SDK 并校验 Microsoft 签名，把当前运行的官方 `node.exe` 作为内置 Node.js 打进去，裁掉依赖里的调试符号与类型声明，并用打包后的文件真正启动一次做冒烟测试。

安装程序命令行参数（测试 / 批量部署）：`/S` 静默，`/D=目录`，`/Data=数据目录`（相对路径相对于安装目录，默认 `data`），`/NoShortcuts`，`/NoRegister`，`/NoLaunch`，`/BundledNode`（强制使用内置 Node.js），`/Update`（软件内更新用：不询问，装到 `/D` 指定的原目录并重新打开；与 `/S` 一起用时静默安装、不重新打开、不新建原来没有的桌面快捷方式）。卸载程序：`/S`，`/KeepData`。

### 发布新版本与自动更新

软件启动后会读取 `package.json` 里 `ezlearn.updateRepo`（格式 `owner/repo`，也可用环境变量 `EZLEARN_UPDATE_REPO`）对应 GitHub 仓库的**最新 Release**，有新版本时在标题栏下方提示：**立即更新 / 保留当前版本 / 跳过这个版本**。设置页可以关闭自动检查或手动“检查更新”。

更新包必须经过签名，流程如下（第一次发布前先做第 1 步）：

1. 生成签名密钥（只做一次）：`node scripts/release-keygen.mjs`。私钥写到仓库**之外**的 `../Ezlearn-release-key/`，公钥写进 `server/update-key.js`（要提交）。**私钥丢了，已安装的旧版本就再也收不到更新；私钥泄露，别人就能冒充你发布更新。** 请备份到安全的地方，不要提交或上传。
2. 改 `package.json` 的 `version`，然后 `npm run build:installer`。
3. `npm run release -- --notes "这次更新了什么"`：生成 `dist/release-<版本>/` 下的 `Ezlearn-Setup-<版本>.exe`、`ezlearn-update.json`（版本、文件名、大小、SHA-256、更新说明）和 `ezlearn-update.json.sig`（Ed25519 签名）。
4. 在 GitHub 仓库新建 Release，tag 写 `v<版本>`，把这三个文件作为附件上传并发布（不要勾选 pre-release）。

用户点“立即更新”后，软件在后台静默下载安装包并核对签名和 SHA-256（右下角小标签显示进度，可以照常使用），下载好后让用户选：**立即重启更新**（以 `/Update` 模式运行安装程序，显示进度窗口，装完自动重新打开）或 **关闭后更新**（下次关闭 Ezlearn 时以 `/S /Update` 静默安装，下次打开就是新版本）。两种方式都装到原来的目录，数据和设置保留。

## 模型提供商

在软件的设置页选择；也可以用环境变量 / `.env`（设置页优先）。除 Claude 外都走 OpenAI 兼容的 `/chat/completions` 流式接口（Node 内置 `fetch`，没有额外 npm 依赖）。

| `EZLEARN_PROVIDER` | 服务商 | 默认模型 | 密钥变量 | 结构化输出 |
|---|---|---|---|---|
| `anthropic`（默认） | Anthropic Claude | `claude-opus-5-5` | `ANTHROPIC_API_KEY`（或 `ant auth login`） | JSON Schema（强制） |
| `openai` | OpenAI GPT | `gpt-5` | `OPENAI_API_KEY` | JSON Schema |
| `deepseek` | DeepSeek | `deepseek-reasoner` | `DEEPSEEK_API_KEY` | JSON 模式 |
| `gemini` | Google Gemini | `gemini-2.5-pro` | `GEMINI_API_KEY` | JSON Schema |
| `qwen` | 阿里通义千问（百炼） | `qwen-plus` | `DASHSCOPE_API_KEY` | JSON 模式 |
| `moonshot` | Moonshot Kimi | `kimi-k2-0905-preview` | `MOONSHOT_API_KEY` | JSON 模式 |
| `zhipu` | 智谱 GLM | `glm-4.6` | `ZHIPUAI_API_KEY` | JSON 模式 |
| `openrouter` | OpenRouter 聚合 | `openai/gpt-5` | `OPENROUTER_API_KEY` | JSON Schema |
| `custom` | 任意 OpenAI 兼容接口（含本机 Ollama / LM Studio） | 需填写 | `EZLEARN_API_KEY`（本机接口可不填） | JSON 模式 |

- 设置页填好密钥后自动请求该服务商的 `/models`（Claude 用官方 SDK 的 `models.list`），列出可用模型；列表拿不到时可以手动输入模型名。改设置立即生效，不用重启。
- 平台不支持某种结构化输出时自动降级（JSON Schema → JSON 模式 → 纯提示词），输出上限过大时自动减半重试；最终都由服务端 zod 校验，不合格会带着错误清单让模型修正。
- 花费上限：设置页里设新课程的默认上限（默认 $20），单门课在管理页点"提高上限"。平台不返回用量时按字符数保守估算。价格可用 `EZLEARN_PRICE_IN` / `EZLEARN_PRICE_OUT` 校准。
- 本项目的提示词和 S7 校验按 Claude 调校；其他模型可能更常触发"修正重试"或校验警告。

## 使用流程

1. **新建课程**（课程代码、名称、讲解语言、考试语言）→ 上传资料（S1 解析，确定性文本提取，不经过模型；也可以上传手写笔记 / 板书照片）。扫描件、截图和课件上的手写批注可以用 **图像识别**（S1V）让能看图的模型读出来：只识别无文字页，或识别全部页，开始前显示估价；手写内容标成【手写批注】，原印刷文字层保留。看不清的字由模型按上下文推断 1–2 个最可能的写法（先用最可能的继续生成）；生成结束后弹出**对照原图确认**窗口：左边原图标出位置，右边是带前后文的候选，选一个或手动填入，软件会同时改正资料原文和已生成章节里对应的那几个字并重新校验。不是 UTF-8 的文本（GBK、Big5、UTF-16 等）会自动转成 UTF-8 副本，弹出预览让你确认没有乱码；确认之前不参与生成。
2. **一键分析 S2–S5**：证据抽取 → 学科判定 → 考核与真题分析 → 课程方案。
3. **确认课程方案**：可以改标题、来源页码、权重，删掉不想要的交互组件。未确认不会开始生成。
4. **逐章生成 S6 + 自动校验 S7**：每章生成后立即校验，可选模型审稿（只报告问题）。
5. **阅读**：左侧目录跟随课程结构，白天 / 黑夜主题，双语术语开关，例子与解答默认折叠，全文搜索。每个小标题都能加书签；"已掌握"、书签和阅读位置保存在本机数据目录。
6. **历史课程**：首页按最近打开排序列出所有课程，显示进度；有书签就直接跳到最新的书签，没有就打开课程首页选章节。
7. **增量更新 S8**：上传新资料后生成变更清单，逐条确认后只修改受影响的块并重新校验。

所有后台任务（分析、生成、更新）和本地操作（上传解析、获取模型）都显示在窗口顶部的进度窗口里：带进度条，每行提示使用课程的讲解语言（目前支持中文和英文，其他语言显示英文）。任务失败时，进度窗口直接给出"打开设置填写密钥""提高花费上限"之类的按钮。

## 架构

```
server/
  index.js        Express 启动、静态资源、错误处理、启动器模式（日志文件、心跳自动退出）
  security.js     Host 校验、会话令牌、Origin 校验、CSP 等安全头、日志脱敏
  routes.js       REST API（全部经 zod 校验）
  settings.js     设置页的持久化设置（提供商、密钥、模型、默认预算），立即生效
  providers.js    模型提供商预设与地址校验（https only）
  llm.js          模型调用：结构化输出、zod 校验 + 自动修复、预算、模型列表；Anthropic 走官方 SDK
  llm-openai.js   OpenAI 兼容接口适配器（GPT / DeepSeek / Gemini / 通义 / Kimi / 智谱 …）
  ingest.js       S1：PDF / 文本 / 转录 / CSV / SQL 解析
  encoding.js     文本编码识别与转换
  pagerender.js   PDF 页面 / 图片渲染成 PNG（图像识别用）
  prompts.js      从 prompts/*.md 组装系统提示 + 学科档案 + 阶段提示
  pipeline.js     S2–S8 编排、任务队列与进度
  i18n.js         进度提示的多语言文本
  verify.js       S7 自动校验
  sandbox/        SQL（sql.js worker）与 JS（QuickJS）沙箱
  schemas.js      数据结构（Block / Chapter / Evidence / Plan …）与组件配置校验
shared/           前后端共用：安全表达式求值器、行内富文本解析
web/              无构建的前端：块渲染器、8 个交互组件、顶部进度窗口、内置说明（help.js）、设置页、管理页与阅读页
installer/        Windows 桌面窗口（WebView2，无系统标题栏）、启动器、安装程序、卸载程序（C#，系统自带编译器）与图标生成
scripts/          示例课程导入、安装包构建、WebView2 SDK 获取（nuget.org，校验 Microsoft 签名）
samples/sql-demo/ 虚构示例课程资料
test/             node:test 测试（安全、流水线、校验、编码、多提供商）
```

### S7 自动校验做了什么

| 校验 | 方法 | 不通过时 |
|---|---|---|
| 数值 | 执行 `verify` 代码（SQL→sql.js；JS→QuickJS），与文中数字对比（带容差） | 标"核对未通过"，进报告 |
| SQL 代码块 | 在课程样例库中真实执行 | 结果表**直接取执行输出**；失败标记为不可运行 |
| 证据 | "重点 / 真题 / 不考"必须引用 S2 中**原文已在资料里找到**的证据 | 不考标记被移除（内容保留），重点降级为"推断" |
| 渲染 | KaTeX 预编译每个公式；组件配置按 schema 校验，公式只允许算术表达式 | 组件替换为文字说明 |
| 结构 | 速查表、每个小题都有解答、术语双语 | 进报告 |
| 诚信 | 与当期作业做 6-gram 相似度比对 | 移除该题解答 |
| 原文一致 | 定义 / 结论框里的引文能否在本章资料中找到 | 进报告 |

## 安全设计

详见 [SECURITY.md](SECURITY.md)。要点：只监听 127.0.0.1；API 需要每次启动随机生成的会话令牌 + Origin / Host 校验（防 CSRF 与 DNS rebinding）；严格 CSP；LLM 输出与上传资料一律视为不可信数据；API key 只在服务端、接口永不返回原文、日志自动脱敏；第三方接口强制 https、禁止重定向；安装 / 卸载不需要管理员权限，删除前校验安装标记，从不动用户自己的 Node.js。

## 测试

```bash
npm test
```

测试使用假模型（`EZLEARN_FAKE_LLM=1`）、本机模拟的 OpenAI 兼容服务器和临时数据目录，不调用真实 API。

## 当前限制

- 图像识别依赖能看图的模型（Claude / GPT / Gemini，或通义 / Kimi / 智谱的视觉模型）；DeepSeek 不支持。手写识别可能有误，结果标注了清晰度，需对照原件。PPTX / DOCX 需先导出为 PDF。
- Python / R 代码不在本机执行（安全考虑），对应例子标"未经执行验证"；数值核算请用 JS 或 SQL 写 verify。
- 真实 API 生成流程没有用真实密钥跑过；Claude、OpenAI、DeepSeek 已确认无效密钥会得到正确提示。首次用真实课程运行时请留意输出质量与花费。
- 内置的各家默认模型名与价格是估计值，可能已过时；设置页的"获取可用模型"以服务商实际返回为准。
- 安装包没有代码签名，首次运行会出现 SmartScreen 提示。桌面窗口需要 Microsoft Edge WebView2 运行时（Windows 11 自带，Windows 10 通常随 Edge 已安装）；没有时自动改用 Edge / Chrome 的应用窗口打开。
- 进度提示只有中文和英文。
- 单用户本地使用；没有账号体系，不要暴露到局域网。
