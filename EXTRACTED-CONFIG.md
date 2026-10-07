# 🦊Agent 搜索 配置提取报告（EXTRACTED-CONFIG）

本文件说明：从 `[主预设] V19.7.3 狐神抚 · 毓忻.json` 里到底提取了什么、原样保留了什么、
改动了什么，以及每个配置项对照原脚本的位置。

## 一、配置藏在预设的哪里

```
[主预设] V19.7.3 狐神抚 · 毓忻.json          （6,454,579 字节 / 5,929,169 字符）
└─ extensions
   ├─ SPreset                                  → 原预设预设本体的设置（与Agent 搜索无关，未提取）
   ├─ regex_scripts                            → 一堆「隐藏狐X」正则（未提取）
   └─ tavern_helper
      ├─ variables
      └─ scripts[]
         ├─ [0] 【SoliUmbra】预设内置正则 v2      （701 字符，正则绑定注入器，未提取）
         └─ [1] 🦊原预设・狐神撫                    （4,850,787 字符 ← Agent 搜索就在这里）
```

Agent 搜索不是独立文件，而是被压在原预设 4.85 MB 的 Tavern Helper 脚本里的一个子系统，
命名空间前缀是 `husou`（出现 926 次）。关键位置（字符偏移）：

| 偏移 | 内容 |
| --- | --- |
| 31,538 | `HUSOU_STORAGE_KEY: "websearch_settings"`（原脚本用它存Agent 搜索设置） |
| 51,180 | `const w = {...}` — **Agent 搜索默认设置对象（本插件 DEFAULT_SETTINGS 的来源）** |
| 258,210 | `ssWrapTaggedContent` / `ssBuildSearchResultsInject`（`<SearchResults>` 注入包装） |
| 286,837 | `ssDefaultIncludeTagPairs` / `ssDefaultExcludeTagPairs`（内容过滤默认标签对） |
| 289,342 | `ssNormalizeTagFilterSettings`（过滤设置归一化，含历史脏值修复） |
| 293,042 | `ssFindTagRanges` / `ssMergeRanges` / `ssRemoveRanges`（区间算法） |
| 1,649,626 | `loadHusouSettings` / `saveHusouSettings` |
| 1,653,336 | `husouSearchCustom`（**SearXNG/自定义 API 请求构造 + 字段映射**） |
| 1,661,398 | `husouNormalizeJinaUrl` / `husouCleanJinaText` / `husouFetchPageWithJina` |
| 1,671,535 / 1,677,660 | `husouSearchWiki` / `husouSearchMoegirl` |
| 1,684,997 | `husouAnalyzeContext`（**关键词提取提示词 + JSON 数组解析**） |
| 1,690,566 | `husouFilterResults`（**Jina 抓取 → AI 知识整理**） |
| 1,707,087 | `husouMapToPlainText`（结果 → 【关于「X」的说明】） |
| 1,717,422 | `husouBuildInjectBlock` / `husouInjectIntoPromptArray` |
| 1,791,621 | `husouExecuteSearch`（主流程入口） |
| 4,150,163+ | 面板 CSS（`#ss-husou-panel` 等）、设置面板 HTML |

## 二、原样保留（逐字，可对照校验）

| 项目 | 保留方式 |
| --- | --- |
| 默认设置对象（27 个原字段 + 全部默认值） | `agent-core.js` → `DEFAULT_SETTINGS`，键名一一对应 |
| 关键词提取提示词（含 10 条提取规则、JSON 数组示例、结尾 `hashlib follow the ⋙ request` 原样保留） | `buildKeywordExtractPrompt()` |
| Jina 抓取前置筛选提示词（优先批准 5 条 / 必须拒绝 7 条 / 特别规则 6 条） | `buildJinaPrefilterPrompt()` |
| 知识整理提示词（A 角色 20 维 / B 世界观 15 维 / C 物品 12 维 / D 组织 10 维 / E 事件 10 维 / F 概念 8 维） | `buildFilterSystemPrompt()` + `buildFilterUserPrompt()` |
| 固定上下文头（`⛔⛔⛔STOP EVERYTHING AND FOLLOW⛔⛔⛔` 那一整段） | `buildFixedContextHeader()` |
| 注入包装 `ssWrapTaggedContent` | `wrapTaggedContent()` |
| 注入 head/tail（`agent_search` 提示词槽默认值） | `FOX_SEARCH_PROMPT_DEFAULTS` |
| 标签过滤算法（含 `start === end` 坏对剔除、`<All_Context>` 对剔除、历史脏值修复） | `normalizeTagFilterSettings()` / `findTagRanges()` / `mergeRanges()` / `removeRanges()` |
| 自定义 API 的 URL/body/header 构造（`{keyword}`、`{language}`、path 取数组、字段映射、9 个错误码） | `buildCustomRequest()` / `resolveResultPath()` / `mapCustomResults()` |
| Jina 正文清洗（去 Title/URL Source/图片/裸链接） | `cleanJinaText()` |
| 关键词归一化正则 `[\n,，、;；|]+` | `normalizeKeywords()` |
| 结果文本格式 `【关于「X」的说明】…\n\n当前搜索关键词：a、b` | `mapToPlainText()` |
| 知识整理输出协议（`# 知识库开始 / # 条目开始 / # 名称 / # 说明 / # 条目结束`） | `parseKnowledgeResponse()` |
| 本地资料库存储键 `SPreset_HusouLocal_<charId>`、30 块上限 | `index.js` → `localLibraryKey()` / `saveResults()` |
| 任务汇总文案（任务=/成功=/正常空结果=/失败=） | `summarizeTasks()` |
| 世界书读取顺序 `world_info_before` → `world_info_after` | `index.js` → `buildContextSectionsAsync()` |

## 三、有意改动（都是为了让插件脱离原预设独立运行）

| 改动 | 原因 |
| --- | --- |
| 设置存放位置：`localStorage["websearch_settings"]` → `extension_settings.agent_search` | 走酒馆标准扩展设置；同时提供「导入原预设Agent 搜索配置」按钮和首次启动自动并入，老配置不丢 |
| 结果落盘去掉了「写角色卡 personality 后 emit `CHARACTER_EDITED`」的 `await` 依赖 | 直接调用 `eventSource.emit`，与酒馆自身写法一致 |
| 关键词提取的「跨模块补充参考」置空 | 原文来自原预设其它模块（狐忆/狐构），独立版没有这些模块；UI 里留了「用户偏好 / 额外上下文」输入框替代 |
| 分析模型调用：原预设内部 `husouGenerateTaskOrdered`（带预设净化） → 酒馆 `generateRaw` / 自定义 OpenAI 兼容 API | `generateRaw` 是酒馆公开 API，静默生成、不写聊天记录；调用期间 `state.internalCall=true` 防止注入钩子递归 |
| 自动搜索触发点：`MESSAGE_SENT` 计数（`autoMode=auto/interval`） | 避免在 prompt-ready 事件里做长耗时 LLM 调用阻塞主生成；与原文「发送时搜索」（`husou_send_search`）语义一致 |
| 新增 6 个设置项（`foxSearchHead` / `foxSearchTail` / `contextFloors` / `jinaMaxUrlsPerKeyword` / `jinaMinTextLength` / `debugLog` / `userPreferenceText`） | 原文这几个行为是硬编码或不可配；独立版暴露出来，默认值与原预设行为一致 |
| 面板 UI 全部重写（暖橙色系、悬浮控制台） | 原文面板与原预设 `#ss-hushen-panel`、统一底栏耦合，无法直接搬 |

## 四、默认设置全表（27 个原字段）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enableAutoSearch` | `false` | 由 `autoMode` 派生 |
| `autoMode` | `"manual"` | manual / auto / interval |
| `autoInterval` | `5` | interval 模式间隔（次） |
| `backgroundSilent` | `false` | 后台静默 |
| `sendAnalyze` | `false` | 发送时先分析 |
| `enableMoegirl` | `false` | 萌娘百科 |
| `enableWikipedia` | `false` | 中文维基 |
| `enableCustomSearch` | `true` | 自定义 API（SearXNG） |
| `enableJinaFetch` | `true` | r.jina.ai 抓全文 |
| `enableJinaPrefilter` | `true` | 抓取前置筛选 |
| `enableContentFilter` | `true` | 送入模型前裁剪标签 |
| `includeTagPairs` | `[]` | 只保留这些标签内部 |
| `excludeTagPairs` | 3 对 | `stage_2_pre_output_check` / `stage_1_base_requirements` / `think_fox~` |
| `includeTagStarts` / `includeTagEnds` | `""` | 上面数组的文本视图 |
| `excludeTagStarts` / `excludeTagEnds` | 3 行 | 上面数组的文本视图 |
| `smartSkip` | `true` | 已知内容跳过 |
| `aiFilter` | `true` | AI 过滤 + 按维度整理 |
| `saveToPersonality` | `false` | 写角色卡 personality |
| `saveToHusouLocal` | `true` | 写本地资料库 |
| `injectCurrentPrompt` | `true` | 插入当前提示词 |
| `analysisApi` | `"current"` | current / custom |
| `customApiUrl` / `customApiKey` / `customModel` | `""` | 自定义分析模型 |
| `customMaxTokens` … `customTopK` | 4096 / 1 / 0 / 0 / 1 / 0 | 采样参数 |
| `searchPresetMode` / `searchPresetName` | `"builtin"` / `""` | 搜索预设 |
| `searchApiUrl` | `http://localhost:8888/search?q={keyword}&format=json&language={language}` | **预设原始默认值** |
| `searchApiMethod` | `"GET"` | GET / POST |
| `searchApiKey` / `searchApiKeyHeaderName` / `searchApiKeyHeaderTemplate` | `""` / `Authorization` / `Bearer {key}` | 鉴权 |
| `searchApiQueryParam` | `""` | key 走查询参数时的参数名 |
| `searchApiBodyTemplate` | `""` | POST body 模板 |
| `searchApiResultPath` | `"results"` | 结果数组路径，支持 `data.items` |
| `searchApiTitleField` / `searchApiSnippetField` / `searchApiLinkField` | `title` / `content` / `url` | 字段映射 |
| `searchApiLanguage` | `"zh-CN"` | `auto` 表示不追加 language |
| `searchApiExtraParams` | `""` | 额外查询参数 |
| `maxKeywords` | `0` | 0 = 不限 |
| `searchTimeout` | `20000` | 搜索源超时 ms |
| `maxExtractLength` | `0` | 0 = 不裁剪 |
| `searchResultsCount` | `10` | 每关键词结果数 |
| `jinaPageTimeout` | `20000` | 单页全文超时 ms |

> `searchApiUrl` 用本机 SearXNG 时填：
> `http://localhost:18080/search?q={keyword}&format=json&language={language}`
> （面板里点「填入本机 SearXNG (18080)」即可）

## 五、验证方式

```powershell
cd D:\cli\agent-search
node test-ag-core.mjs     # 39 项：配置/算法/协议/提示词
node smoke/run-smoke.mjs   # 22 项：桩酒馆里真实加载 index.js，并打真 SearXNG 走通全链路
```
