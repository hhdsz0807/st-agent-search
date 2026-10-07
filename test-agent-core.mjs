/**
 * agent-core.js 单元测试 —— 纯 node，无酒馆依赖。
 *   node test-ag-core.mjs
 */

import assert from 'node:assert/strict';
import * as core from './agent-core.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ❌ ${name}\n     ${err.message}`);
    }
}

console.log('agent-core.js 测试\n');

/* ---------------- 关键词 ---------------- */
console.log('关键词');

test('normalizeKeywords 拆分中英标点并去重', () => {
    assert.deepEqual(core.normalizeKeywords('原神, 可莉、原神；西风骑士团|可莉\n蹦蹦炸弹'), [
        '原神',
        '可莉',
        '西风骑士团',
        '蹦蹦炸弹',
    ]);
});

test('normalizeKeywords 接收数组并去重', () => {
    assert.deepEqual(core.normalizeKeywords(['a', ' a ', '', null, 'b']), ['a', 'b']);
});

test('keywordsLine 生成「当前搜索关键词：」行', () => {
    assert.equal(core.keywordsLine(['原神', '可莉']), '当前搜索关键词：原神、可莉');
    assert.equal(core.keywordsLine(''), '');
});

test('parseJsonArray 抠出模型回答里的 JSON 数组', () => {
    assert.deepEqual(core.parseJsonArray('```json\n["原神", "原神 可莉"]\n```').value, ['原神', '原神 可莉']);
    assert.deepEqual(core.parseJsonArray('[]').value, []);
    assert.equal(core.parseJsonArray('没有数组').ok, false);
    assert.equal(core.parseJsonArray('').error, 'KEYWORD_MODEL_EMPTY');
});

/* ---------------- 标签过滤 ---------------- */
console.log('\n标签过滤');

test('linesToPairs / pairsToLines 往返', () => {
    const pairs = core.linesToPairs('<a>\n<b>', '</a>\n</b>');
    assert.deepEqual(pairs, [
        { start: '<a>', end: '</a>' },
        { start: '<b>', end: '</b>' },
    ]);
    assert.equal(core.pairsToLines(pairs, 'start'), '<a>\n<b>');
    assert.equal(core.pairsToLines(pairs, 'end'), '</a>\n</b>');
});

test('normalizeTagFilterSettings 保底并回写行文本', () => {
    const s = core.normalizeTagFilterSettings({});
    assert.ok(Array.isArray(s.excludeTagPairs));
    assert.equal(s.excludeTagPairs.length, 3);
    assert.equal(s.excludeTagStarts.split('\n')[0], '<stage_2_pre_output_check>');
    assert.equal(s.excludeTagEnds.split('\n')[2], '</think_fox~>');
});

test('normalizeTagFilterSettings 丢弃 start===end 的坏对', () => {
    const s = core.normalizeTagFilterSettings({ excludeTagPairs: [{ start: '<x>', end: '<x>' }, { start: '<y>', end: '</y>' }] });
    assert.deepEqual(s.excludeTagPairs, [{ start: '<y>', end: '</y>' }]);
});

test('applyTagFilter 剔除 think_fox 块', () => {
    const s = core.normalizeSettings({});
    const out = core.applyTagFilter('开头<think_fox~>内心戏</think_fox~>结尾', s);
    assert.ok(!out.includes('内心戏'));
    assert.ok(out.includes('开头'));
    assert.ok(out.includes('结尾'));
});

test('applyTagFilter include 只保留标签内部', () => {
    const s = core.normalizeSettings({ includeTagPairs: [{ start: '<content>', end: '</content>' }], excludeTagPairs: [] });
    const out = core.applyTagFilter('噪声<content>正文</content>更多噪声', s);
    assert.equal(out, '正文');
});

test('applyTagFilter 关闭时不改动', () => {
    const s = core.normalizeSettings({ enableContentFilter: false });
    const src = '<think_fox~>保留</think_fox~>';
    assert.equal(core.applyTagFilter(src, s), src);
});

/* ---------------- 自定义搜索 API ---------------- */
console.log('\n自定义搜索 API（SearXNG）');

test('buildCustomRequest GET 拼接语言与额外参数', () => {
    const req = core.buildCustomRequest('原神 可莉', {
        ...core.DEFAULT_SETTINGS,
        searchApiUrl: 'http://localhost:18080/search?q={keyword}&format=json&language={language}',
        searchApiLanguage: 'zh-CN',
        searchApiExtraParams: '&safesearch=0',
    });
    assert.equal(req.method, 'GET');
    assert.ok(req.url.includes('q=%E5%8E%9F%E7%A5%9E%20%E5%8F%AF%E8%8E%89'));
    assert.ok(req.url.includes('language=zh-CN'));
    assert.ok(req.url.includes('safesearch=0'));
    assert.equal(req.body, null);
});

test('buildCustomRequest 语言为 auto 时不追加 language', () => {
    const req = core.buildCustomRequest('x', {
        ...core.DEFAULT_SETTINGS,
        searchApiUrl: 'http://h/search?q={keyword}',
        searchApiLanguage: 'auto',
    });
    assert.equal(req.url, 'http://h/search?q=x');
});

test('buildCustomRequest 带 key 的请求头模板', () => {
    const req = core.buildCustomRequest('x', {
        ...core.DEFAULT_SETTINGS,
        searchApiUrl: 'http://h/search?q={keyword}',
        searchApiKey: 'SECRET',
        searchApiKeyHeaderName: 'X-API-KEY',
        searchApiKeyHeaderTemplate: 'Token {key}',
    });
    assert.equal(req.headers['X-API-KEY'], 'Token SECRET');
    assert.ok(!req.url.includes('SECRET'));
});

test('buildCustomRequest POST 生成转义后的 body', () => {
    const req = core.buildCustomRequest('a"b\\c', {
        ...core.DEFAULT_SETTINGS,
        searchApiUrl: 'http://h/search',
        searchApiMethod: 'POST',
        searchApiBodyTemplate: '{"query":"{keyword}"}',
    });
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['Content-Type'], 'application/json');
    assert.equal(req.body, '{"query":"a\\"b\\\\c"}');
    assert.equal(JSON.parse(req.body).query, 'a"b\\c');
});

test('buildCustomRequest 空地址报错', () => {
    assert.throws(() => core.buildCustomRequest('x', { ...core.DEFAULT_SETTINGS, searchApiUrl: '' }), /地址为空/);
});

test('resolveResultPath / mapCustomResults 映射 SearXNG 结果', () => {
    const json = {
        query: 'x',
        results: [
            { title: '标题A', content: '<b>摘要</b>\n\nA', url: 'https://a.example' },
            { title: '标题B', content: '摘要B', url: 'https://b.example' },
            { title: '', content: '', url: 'https://c.example' },
        ],
    };
    const cfg = { ...core.DEFAULT_SETTINGS, searchResultsCount: 10 };
    assert.equal(core.resolveResultPath(json, 'results').length, 3);
    const mapped = core.mapCustomResults(json, cfg);
    assert.equal(mapped.rawCount, 3);
    assert.equal(mapped.lines.length, 2);
    assert.equal(mapped.lines[0], '【标题A】摘要 A\n🔗 https://a.example');
});

test('mapCustomResults 支持嵌套路径与字段重命名', () => {
    const json = { data: { items: [{ name: 'N', snippet: 'S', link: 'L' }] } };
    const mapped = core.mapCustomResults(json, {
        ...core.DEFAULT_SETTINGS,
        searchApiResultPath: 'data.items',
        searchApiTitleField: 'name',
        searchApiSnippetField: 'snippet',
        searchApiLinkField: 'link',
    });
    assert.deepEqual(mapped.lines, ['【N】S\n🔗 L']);
});

test('mapCustomResults 路径不是数组时报错码', () => {
    const mapped = core.mapCustomResults({ results: { x: 1 } }, core.DEFAULT_SETTINGS);
    assert.equal(mapped.errorCode, 'CUSTOM_RESULT_PATH_INVALID');
});

test('searchResultsCount 截断结果数量', () => {
    const json = { results: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, content: `C${i}`, url: `u${i}` })) };
    const mapped = core.mapCustomResults(json, { ...core.DEFAULT_SETTINGS, searchResultsCount: 3 });
    assert.equal(mapped.lines.length, 3);
});

/* ---------------- Jina ---------------- */
console.log('\nJina 全文');

test('cleanJinaText 去标题/图片/链接', () => {
    const raw = 'Title: 某页\nURL Source: https://x.example\nMarkdown Content:\n![img](https://x/i.png)\n[链接](https://x/a)\n正文 https://x/b 结束';
    const out = core.cleanJinaText(raw);
    assert.ok(!out.includes('Title:'));
    assert.ok(!out.includes('!['));
    assert.ok(out.includes('链接'));
    assert.ok(!out.includes('https://x/b'));
    assert.ok(out.includes('正文'));
});

test('normalizeJinaUrl 去掉尾部标点', () => {
    assert.equal(core.normalizeJinaUrl('https://x/y）。'), 'https://x/y');
});

test('extractJinaCandidates 从结果 map 提取候选', () => {
    const map = new Map([
        ['原神 可莉', '【可莉 - 萌娘百科】蹦蹦炸弹\n🔗 https://zh.moegirl.org.cn/可莉\n【可莉 - 维基】\n🔗 https://zh.wikipedia.org/wiki/可莉'],
    ]);
    const out = core.extractJinaCandidates(map);
    assert.equal(out.length, 2);
    assert.equal(out[0].index, 1);
    assert.equal(out[0].keyword, '原神 可莉');
    assert.equal(out[0].title, '可莉 - 萌娘百科');
    assert.equal(out[0].url, 'https://zh.moegirl.org.cn/可莉');
});

test('parsePrefilterJson 支持下标 / URL / 对象三种批准写法', () => {
    const candidates = [{ url: 'https://a' }, { url: 'https://b' }, { url: 'https://c' }];
    assert.deepEqual([...core.parsePrefilterJson('{"approved":[1,{"index":2}]}', candidates)], ['https://a', 'https://b']);
    assert.deepEqual([...core.parsePrefilterJson('{"approved_urls":["https://c"]}', candidates)], ['https://c']);
    assert.deepEqual([...core.parsePrefilterJson('{"approved":[{"index":3,"should_fetch":false}]}', candidates)], []);
    assert.equal(core.parsePrefilterJson('不是 JSON', candidates).size, 0);
});

/* ---------------- 整理协议 ---------------- */
console.log('\n知识整理协议');

test('parseKnowledgeResponse 解析条目', () => {
    const text = `# 知识库开始
# 条目开始
# 名称
可莉
# 说明
**身份定位**：蒙德火花骑士
# 条目结束
# 知识库结束`;
    const parsed = core.parseKnowledgeResponse(text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.entries.get('可莉'), '**身份定位**：蒙德火花骑士');
});

test('parseKnowledgeResponse 识别「无新增」', () => {
    const parsed = core.parseKnowledgeResponse('# 知识库开始\n# 无新增\n# 知识库结束');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.noNew, true);
});

test('parseKnowledgeResponse 缺协议标记时报错', () => {
    assert.equal(core.parseKnowledgeResponse('随便写点').error, 'FILTER_PROTOCOL_MISSING');
    assert.equal(core.parseKnowledgeResponse('').error, 'FILTER_MODEL_EMPTY');
});

test('parseKnowledgeResponse 丢弃「（无可用信息）」条目', () => {
    const text = '# 知识库开始\n# 条目开始\n# 名称\nX\n# 说明\n（无可用信息）\n# 条目结束\n# 知识库结束';
    assert.equal(core.parseKnowledgeResponse(text).error, 'FILTER_SECTIONS_EMPTY');
});

/* ---------------- 注入块 ---------------- */
console.log('\n注入块');

test('mapToPlainText 组装关键词块并追加关键词行', () => {
    const map = new Map([['可莉', '说明内容']]);
    assert.equal(core.mapToPlainText(map, ['可莉']), '【关于「可莉」的说明】\n说明内容\n\n当前搜索关键词：可莉');
});

test('buildSearchResultsInject 使用默认 head/tail 与 SearchResults 标签', () => {
    const block = core.buildSearchResultsInject('正文');
    assert.ok(block.startsWith('<SearchResults>'));
    assert.ok(block.endsWith('</SearchResults>'));
    assert.ok(block.includes('【Agent 搜索注入】以下信息是通过网页搜索后得到的信息'));
    assert.ok(block.includes('以上内容只是通过搜索得来！'));
});

test('buildInjectBlock 空 map 返回空串', () => {
    assert.equal(core.buildInjectBlock(new Map()), '');
});

test('stripSearchInjection 清理 personality 里的旧注入', () => {
    const dirty = `人设正文\n\n<SearchResults>\n【Agent 搜索注入】x\n\n内容\n</SearchResults>\n`;
    assert.equal(core.stripSearchInjection(dirty), '人设正文');
});

test('safeUrl 隐藏敏感段与查询值', () => {
    const out = core.safeUrl('https://h/search?key=SECRET&q=abc');
    assert.ok(out.includes('参数=key,q'));
    assert.ok(!out.includes('SECRET'));
});

/* ---------------- 提示词 ---------------- */
console.log('\n提示词');

test('关键词提取提示词包含原始规则与 JSON 数组要求', () => {
    const p = core.buildKeywordExtractPrompt({ existing: '已有资料', linked: '', smartSkip: true });
    assert.ok(p.includes('你是关键词提取大师'));
    assert.ok(p.includes('必须只输出 JSON 数组'));
    assert.ok(p.includes('已有资料'));
    assert.ok(p.includes('原神 可莉 蹦蹦炸弹'));
});

test('Jina 前置筛选提示词包含候选与 JSON 协议', () => {
    const p = core.buildJinaPrefilterPrompt([{ index: 1, keyword: 'k', title: 't', snippet: 's', url: 'https://u' }], ['k']);
    assert.ok(p.includes('【候选 1】'));
    assert.ok(p.includes('"approved"'));
    assert.ok(p.includes('本次搜索关键词'));
});

test('知识整理提示词包含 A–F 维度与输出协议', () => {
    const s = core.buildFilterSystemPrompt({ rawText: 'R', keywords: '当前搜索关键词：k', existing: 'E' });
    assert.ok(s.includes('A类：角色'));
    assert.ok(s.includes('F类：概念/术语'));
    assert.ok(s.includes('E'));
    const u = core.buildFilterUserPrompt();
    assert.ok(u.includes('# 知识库开始'));
    assert.ok(u.includes('# 条目开始'));
});

/* ---------------- 默认配置 ---------------- */
console.log('\n默认配置');

test('DEFAULT_SETTINGS 与预设提取值一致', () => {
    assert.equal(core.DEFAULT_SETTINGS.searchApiUrl, 'http://localhost:8888/search?q={keyword}&format=json&language={language}');
    assert.equal(core.DEFAULT_SETTINGS.searchApiResultPath, 'results');
    assert.equal(core.DEFAULT_SETTINGS.searchApiSnippetField, 'content');
    assert.equal(core.DEFAULT_SETTINGS.searchResultsCount, 10);
    assert.equal(core.DEFAULT_SETTINGS.searchTimeout, 20000);
    assert.equal(core.DEFAULT_SETTINGS.jinaPageTimeout, 8000); // 预设原文 20000，本插件为速度收紧到 8000
    assert.equal(core.DEFAULT_SETTINGS.analysisApi, 'current');
    assert.equal(core.DEFAULT_SETTINGS.enableCustomSearch, true);
    assert.equal(core.DEFAULT_SETTINGS.enableWikipedia, false);
    assert.equal(core.DEFAULT_SETTINGS.enableMoegirl, false);
    assert.equal(core.DEFAULT_SETTINGS.enableJinaFetch, true);
    assert.equal(core.DEFAULT_SETTINGS.enableJinaPrefilter, true);
    assert.equal(core.DEFAULT_SETTINGS.enableContentFilter, true);
    assert.equal(core.DEFAULT_SETTINGS.smartSkip, true);
    assert.equal(core.DEFAULT_SETTINGS.aiFilter, true);
    assert.equal(core.DEFAULT_SETTINGS.saveToHusouLocal, true);
    assert.equal(core.DEFAULT_SETTINGS.saveToPersonality, false);
    assert.equal(core.DEFAULT_SETTINGS.injectCurrentPrompt, true);
    assert.equal(core.DEFAULT_SETTINGS.maxKeywords, 0);
    assert.equal(core.DEFAULT_SETTINGS.maxExtractLength, 0);
});

test('normalizeSettings 兼容旧的 enableAutoSearch 字段', () => {
    assert.equal(core.normalizeSettings({ enableAutoSearch: true }).autoMode, 'auto');
    assert.equal(core.normalizeSettings({ autoMode: '乱写' }).autoMode, 'manual');
    assert.equal(core.normalizeSettings({ autoInterval: 0 }).autoInterval, 5);
    assert.equal(core.normalizeSettings({ enableAutoSearch: false }).autoMode, 'manual');
});

test('normalizeSettings 修正方法名与数值下限', () => {
    const s = core.normalizeSettings({ searchApiMethod: 'post', searchResultsCount: -3, searchTimeout: 10 });
    assert.equal(s.searchApiMethod, 'POST');
    assert.equal(s.searchResultsCount, 1); // 负数被夹到下限 1
    assert.equal(s.searchTimeout, 1000);
});

test('LOCAL_SEARXNG_URL 指向教程里的 18080', () => {
    assert.ok(core.LOCAL_SEARXNG_URL.includes('localhost:18080'));
});

/* ---------------- 模型列表 / 输入预算 / 世界书 ---------------- */
/* ---------------- 分析模型重试计划（输出截断 vs 输入过长） ---------------- */
/* ---------------- 整理模式（聚焦 / 逐条 / 原版） ---------------- */
test('parseKnowledgeResponse 能从被截断的响应里捞出已完成条目', () => {
    const truncated = '# 知识库开始\n# 条目开始\n# 名称\n白井黑子\n# 说明\n**身份**：风纪委员\n# 条目结束\n# 条目开始\n# 名称\n御坂美琴\n# 说明\n**身份**：常盘台王牌（这条被截断';
    const parsed = core.parseKnowledgeResponse(truncated);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.truncated, true);
    assert.deepEqual([...parsed.entries.keys()], ['白井黑子']);
});

test('parseKnowledgeResponse 未截断时不标 truncated', () => {
    const parsed = core.parseKnowledgeResponse('# 知识库开始\n# 条目开始\n# 名称\nX\n# 说明\nY\n# 条目结束\n# 知识库结束');
    assert.equal(parsed.truncated, false);
});

/* ---------------- 模型列表 / 输入预算 / 世界书 ---------------- */
console.log('\n模型列表与输入预算');

test('modelsEndpoint 由 chat/completions 推导 /models', () => {
    assert.equal(core.modelsEndpoint('https://api.commandcode.ai/provider/v1'), 'https://api.commandcode.ai/provider/v1/models');
    assert.equal(core.modelsEndpoint('https://x/v1/chat/completions'), 'https://x/v1/models');
    assert.equal(core.modelsEndpoint('https://x/v1/chat/completions/'), 'https://x/v1/models');
    assert.equal(core.modelsEndpoint(''), '');
});

test('parseModelIds 兼容三种返回结构', () => {
    assert.deepEqual(core.parseModelIds({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']);
    assert.deepEqual(core.parseModelIds({ models: [{ name: 'x' }] }), ['x']);
    assert.deepEqual(core.parseModelIds(['z', 'y', 'z']), ['y', 'z']);
    assert.deepEqual(core.parseModelIds({}), []);
});

test('budgetLadder 生成 全量→1/2→1/4 阶梯', () => {
    assert.deepEqual(core.budgetLadder(12000), [12000, 6000, 3000]);
    assert.deepEqual(core.budgetLadder(0), [0]);
});

test('buildBudgetedRawText 按总预算截断并标注', () => {
    const map = new Map([
        ['A', 'x'.repeat(500)],
        ['B', 'y'.repeat(500)],
        ['C', 'z'.repeat(500)],
    ]);
    const all = core.buildBudgetedRawText(map, { maxChars: 0 });
    assert.equal(all.truncated, false);
    assert.ok(all.text.includes('「A」') && all.text.includes('「C」'));
    const cut = core.buildBudgetedRawText(map, { maxChars: 900 });
    assert.equal(cut.truncated, true);
    assert.ok(cut.text.length <= 940, String(cut.text.length));
    assert.ok(cut.text.includes('已达总长度上限'));
    const perKey = core.buildBudgetedRawText(map, { perKeywordChars: 100 });
    assert.equal(perKey.truncated, true);
    assert.ok(perKey.text.includes('本关键词结果已截断'));
});

test('blocksToWorldData / worldDataToBlocks 往返一致', () => {
    const blocks = [
        { ts: '2026-02-20', content: '【关于「可莉」的说明】\n蒙德火花骑士' },
        { ts: '2026-02-21', content: '第二条' },
    ];
    const world = core.blocksToWorldData('Agent 搜索资料库', blocks);
    assert.equal(world.name, 'Agent 搜索资料库');
    assert.equal(Object.keys(world.entries).length, 2);
    assert.equal(world.entries[0].constant, false);
    assert.deepEqual(world.entries[0].key, []);
    assert.deepEqual(core.worldDataToBlocks(world), blocks);
});

test('worldDataToBlocks 按 displayIndex 排序并跳过空条目', () => {
    const world = {
        entries: {
            7: { uid: 7, displayIndex: 1, content: '第二条', extensions: { agent_search: { ts: 'b' } } },
            3: { uid: 3, displayIndex: 0, content: '第一条', extensions: { agent_search: { ts: 'a' } } },
            9: { uid: 9, displayIndex: 2, content: '   ', extensions: {} },
        },
    };
    assert.deepEqual(core.worldDataToBlocks(world), [
        { ts: 'a', content: '第一条' },
        { ts: 'b', content: '第二条' },
    ]);
});

test('默认资料库存储是服务端（跨设备）', () => {
    assert.equal(core.DEFAULT_SETTINGS.libraryStorage, 'server');
    assert.equal(core.DEFAULT_SETTINGS.libraryWorldName, 'Agent 搜索资料库');
    assert.equal(core.normalizeSettings({}).libraryStorage, 'server');
});

/* ---------------- 分析模型重试计划（输出截断 vs 输入过长） ---------------- */
console.log('\n分析模型输出上限');

test('analysisAttempts 输出最多抬一次，避免无谓重试', () => {
    const a = core.analysisAttempts({ baseOutput: 4096, maxInputChars: 12000, maxOutputCap: 32768 });
    assert.deepEqual(a.map((x) => x.maxOutput), [4096, 8192, 8192, 8192]);
    assert.deepEqual(a.map((x) => x.maxInput), [12000, 12000, 6000, 3000]);
    assert.equal(a.filter((x) => x.kind === 'bump-output').length, 1);
    assert.equal(a[0].kind, 'first');
    assert.ok(a[2].why.includes('裁剪输入'));
});

test('analysisAttempts 受上限约束且不重复', () => {
    const a = core.analysisAttempts({ baseOutput: 20000, maxInputChars: 0, maxOutputCap: 32768 });
    assert.deepEqual(a.map((x) => x.maxOutput), [20000, 32768]); // maxInputChars=0 → 不产生裁剪输入的重试
    assert.deepEqual(a.map((x) => x.maxInput), [0, 0]);
});

test('isOutputTruncated 识别 finish_reason=length', () => {
    assert.equal(core.isOutputTruncated({ detail: { info: { finishReason: 'length' } } }), true);
    assert.equal(core.isOutputTruncated({ info: { finishReason: 'stop' } }), false);
    assert.equal(core.isOutputTruncated(new Error('x')), false);
});

test('默认输出上限直接给到 16384（不靠重试兜底）', () => {
    assert.equal(core.DEFAULT_SETTINGS.customMaxTokens, 16384);
});

test('parseKnowledgeResponse 能从被截断的响应里捞出已完成条目', () => {
    const truncated = '# 知识库开始\n# 条目开始\n# 名称\n白井黑子\n# 说明\n**身份**：风纪委员\n# 条目结束\n# 条目开始\n# 名称\n御坂美琴\n# 说明\n**身份**：常盘台王牌（这条被截断';
    const parsed = core.parseKnowledgeResponse(truncated);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.truncated, true);
    assert.deepEqual([...parsed.entries.keys()], ['白井黑子']);
});

test('parseKnowledgeResponse 未截断时不标 truncated', () => {
    const parsed = core.parseKnowledgeResponse('# 知识库开始\n# 条目开始\n# 名称\nX\n# 说明\nY\n# 条目结束\n# 知识库结束');
    assert.equal(parsed.truncated, false);
});

/* ---------------- 整理模式（聚焦 / 逐条 / 原版） ---------------- */
console.log('\n整理模式');

test('filterModeInstruction 三种模式各自的约束', () => {
    const focus = core.filterModeInstruction('focus', ['白井黑子']);
    assert.ok(focus.includes('只保留直接相关内容'));
    assert.ok(focus.includes('声优'));
    assert.ok(focus.includes('白井黑子'));
    const per = core.filterModeInstruction('perKeyword', ['白井黑子']);
    assert.ok(per.includes('只为每个搜索关键词输出一条条目'));
    assert.ok(per.includes('身份'));
    const all = core.filterModeInstruction('allEntities', ['白井黑子']);
    assert.ok(all.includes('全实体知识库'));
});

test('角色卡维度含用户要求的 身份/外貌/性格/背景', () => {
    const names = core.CHARACTER_SHEET_FIELDS.map((f) => f[0]);
    for (const need of ['身份', '外貌', '性格', '能力', '背景']) assert.ok(names.includes(need), need);
});

test('buildFilterSystemPrompt 在聚焦模式下覆盖 A–F「全实体」规则', () => {
    const s = core.buildFilterSystemPrompt({ rawText: 'RAW', keywords: '当前搜索关键词：白井黑子', mode: 'focus', keywordList: ['白井黑子'] });
    assert.ok(s.includes('模式优先级'));
    assert.ok(s.includes('不得'));
    const s2 = core.buildFilterSystemPrompt({ rawText: 'RAW', keywords: 'k', mode: 'allEntities', keywordList: ['k'] });
    assert.ok(!s2.includes('模式优先级'));
});

test('filterEntriesByFocus 剔掉无关实体，只留与关键词相关的', () => {
    const entries = new Map([
        ['白井黑子', 'A'],
        ['白井黑子（某科学的超电磁炮）', 'B'],
        ['御坂美琴', 'C'],
        ['上条当麻', 'D'],
        ['新井里美', 'E'],
    ]);
    const kept = core.filterEntriesByFocus(entries, ['白井黑子']);
    assert.deepEqual([...kept.keys()], ['白井黑子', '白井黑子（某科学的超电磁炮）']);
});

test('filterEntriesByFocus 全都不相关时宁多勿漏（保留原样）', () => {
    const entries = new Map([['御坂美琴', 'C'], ['上条当麻', 'D']]);
    const kept = core.filterEntriesByFocus(entries, ['白井黑子']);
    assert.equal(kept.size, 2);
});

test('默认整理模式是 focus（不再把配音员/关联作品全收进来）', () => {
    assert.equal(core.DEFAULT_SETTINGS.filterMode, 'focus');
    assert.equal(core.normalizeSettings({}).filterMode, 'focus');
});

/* ---------------- 世界书词条模型 ---------------- */
console.log('\n世界书词条');

test('entriesToWorldData 生成带关键词与绿灯的世界书条目', () => {
    const data = core.entriesToWorldData('Agent 搜索资料库', [
        { name: '白井黑子', content: '**身份**：风纪委员', keywords: ['白井黑子', '黑子'], constant: true },
        { name: '御坂美琴', content: '**身份**：常盘台王牌', keywords: ['御坂美琴'], constant: false },
    ]);
    assert.equal(data.name, 'Agent 搜索资料库');
    const e0 = data.entries[0];
    assert.equal(e0.comment, '白井黑子');
    assert.deepEqual(e0.key, ['白井黑子', '黑子']);
    assert.equal(e0.constant, true);
    assert.equal(e0.disable, false);
    assert.equal(e0.extensions.agent_search.name, '白井黑子');
    assert.equal(data.entries[1].constant, false);
});

test('worldDataToEntries 往返一致（含灯与关键词）', () => {
    const entries = [
        { name: '白井黑子', content: 'A', keywords: ['白井黑子'], constant: true, disabled: false, ts: '2026-02-20' },
        { name: '御坂美琴', content: 'B', keywords: ['御坂美琴', '美琴'], constant: false, disabled: true, ts: '2026-02-21' },
    ];
    const back = core.worldDataToEntries(core.entriesToWorldData('X', entries));
    assert.deepEqual(back, entries);
});

test('没有关键词时自动用词条名当激活关键词', () => {
    const data = core.entriesToWorldData('X', [{ name: '可莉', content: 'C', keywords: [] }]);
    assert.deepEqual(data.entries[0].key, ['可莉']);
});

test('knowledgeMapToEntries 把整理结果变成词条（名字即关键词）', () => {
    const map = new Map([['白井黑子', '详情'], ['御坂美琴', '详情2']]);
    const entries = core.knowledgeMapToEntries(map);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, '白井黑子');
    assert.deepEqual(entries[0].keywords, ['白井黑子']);
    assert.equal(entries[0].constant, false);
});

test('parseEntriesFromBlockText 能把旧资料拆成词条', () => {
    const old = '【关于「白井黑子」的说明】\n身份：风纪委员\n\n【关于「御坂美琴」的说明】\n身份：常盘台王牌';
    const entries = core.parseEntriesFromBlockText(old);
    assert.deepEqual(entries.map((e) => e.name), ['白井黑子', '御坂美琴']);
    assert.ok(entries[0].content.includes('风纪委员'));
});

test('entriesToPlainText 拼回与世界书一致的格式', () => {
    const text = core.entriesToPlainText([{ name: '可莉', content: '蒙德火花骑士', keywords: ['可莉'] }]);
    assert.equal(text, '【关于「可莉」的说明】\n蒙德火花骑士');
});

test('悬浮入口默认收起（悬浮按钮按钮形态）', () => {
    assert.equal(core.DEFAULT_SETTINGS.quickFabOpen, false);
    const s = core.normalizeSettings({ quickFabOpen: true, quickFabPos: { left: 10, top: 20 } });
    assert.equal(s.quickFabOpen, true);
    assert.deepEqual(s.quickFabPos, { left: 10, top: 20 });
});

/* ---------------- 速度：抓取规划与并发 ---------------- */
console.log('\n全文抓取规划（速度）');

test('planJinaTargets 全局只抓前 N 页（默认 3）', () => {
    const cands = [];
    for (let k = 0; k < 3; k++) for (let i = 1; i <= 3; i++) cands.push({ index: cands.length + 1, keyword: `kw${k}`, url: `https://e/${k}/${i}` });
    const picked = core.planJinaTargets(cands, { perKeyword: 3, total: 3 });
    assert.equal(picked.length, 3);
    // 轮转取 → 每个关键词各一页
    assert.deepEqual([...new Set(picked.map((c) => c.keyword))].sort(), ['kw0', 'kw1', 'kw2']);
});

test('planJinaTargets 遵守每关键词上限', () => {
    const cands = [
        { keyword: 'a', url: 'https://e/a1' },
        { keyword: 'a', url: 'https://e/a2' },
        { keyword: 'a', url: 'https://e/a3' },
        { keyword: 'b', url: 'https://e/b1' },
    ];
    const picked = core.planJinaTargets(cands, { perKeyword: 2, total: 10 });
    assert.equal(picked.filter((c) => c.keyword === 'a').length, 2);
    assert.equal(picked.length, 3);
});

test('planJinaTargets 支持只取前置筛选批准过的 URL', () => {
    const cands = [{ keyword: 'a', url: 'https://e/1' }, { keyword: 'a', url: 'https://e/2' }];
    const picked = core.planJinaTargets(cands, { perKeyword: 3, total: 3, approvedUrls: new Set(['https://e/2']) });
    assert.deepEqual(picked.map((c) => c.url), ['https://e/2']);
});

test('mapLimit 真的有并发上限且保序', async () => {
    let running = 0;
    let peak = 0;
    const out = await core.mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
    assert.ok(peak <= 2, `peak=${peak}`);
});

test('mapLimit 单条抛错不影响其它条目', async () => {
    const out = await core.mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
    });
    assert.equal(out[0], 1);
    assert.equal(out[2], 3);
    assert.ok(out[1].__error instanceof Error);
});

test('速度相关默认值：全局抓 3 页 / 并发 3 / 单页 8s / 总预算 25s', () => {
    assert.equal(core.DEFAULT_SETTINGS.jinaMaxUrlsTotal, 3);
    assert.equal(core.DEFAULT_SETTINGS.jinaConcurrency, 3);
    assert.equal(core.DEFAULT_SETTINGS.jinaPageTimeout, 8000);
    assert.equal(core.DEFAULT_SETTINGS.jinaTotalBudgetMs, 25000);
});

/* ---------------- reader 模式：网址交给模型 ---------------- */
console.log('\nreader 模式（把网址交给 AI）');

test('extractCustomResultItems 取出标题/摘要/网址', () => {
    const json = {
        results: [
            { title: 'A', content: '<b>摘要</b> A', url: 'https://a.example/1' },
            { title: 'B', content: '摘要B', url: 'not-a-url' },
            { title: 'C', content: '摘要C', url: 'https://c.example/3' },
        ],
    };
    const items = core.extractCustomResultItems(json, { ...core.DEFAULT_SETTINGS, readerMaxUrls: 3 });
    assert.deepEqual(items.map((x) => x.url), ['https://a.example/1', 'https://c.example/3']);
    assert.equal(items[0].title, 'A');
    assert.equal(items[0].snippet, '摘要 A');
});

test('extractCustomResultItems 遵守 readMaxUrls 上限', () => {
    const json = { results: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, content: 'c', url: `https://x/${i}` })) };
    assert.equal(core.extractCustomResultItems(json, { ...core.DEFAULT_SETTINGS, readerMaxUrls: 3 }).length, 3);
});

test('buildReaderPrompt 带上网址清单与正文，并要求角色卡字段', () => {
    const { system, user } = core.buildReaderPrompt({
        keyword: '白井黑子',
        sources: [
            { site: '自定义来源：某页', title: '某页', url: 'https://a.example/1', text: 'X'.repeat(120) },
            { site: '维基百科', title: '白井黑子', url: 'https://zh.wikipedia.org/wiki/x', error: 'HTTP 403' },
        ],
    });
    assert.ok(user.includes('https://a.example/1'));
    assert.ok(user.includes('已读取 120 字'));
    assert.ok(user.includes('读取失败（HTTP 403）'));
    assert.ok(system.includes('**身份**') && system.includes('**扮演要点**'));
    assert.ok(system.includes('白井黑子'));
});

test('reader 模式相关默认值：交网址给模型 / 全局 3 个网址 / 不截断', () => {
    assert.equal(core.DEFAULT_SETTINGS.providerMode, 'reader');
    assert.equal(core.DEFAULT_SETTINGS.readerMaxUrls, 3);
    assert.equal(core.DEFAULT_SETTINGS.readerMaxChars, 0); // 不限：用户要求别截断
    assert.equal(core.normalizeSettings({}).providerMode, 'reader');
});

test('reasoning_effort 默认不干预，可设置为 none', () => {
    assert.equal(core.DEFAULT_SETTINGS.analysisReasoningEffort, '');
    assert.equal(core.normalizeSettings({ analysisReasoningEffort: 'none' }).analysisReasoningEffort, 'none');
});

test('reader 模式正文默认不截断（要限自己填）', () => {
    assert.equal(core.DEFAULT_SETTINGS.readerTotalChars, 0);
    assert.equal(core.DEFAULT_SETTINGS.readerMaxChars, 0);
});

/* ---------------- 剥离思考内容 ---------------- */
console.log('\n剥离思考内容');

test('stripThinkingBlocks 去掉各种思考标签', () => {
    assert.equal(core.stripThinkingBlocks('<thinking>想很久</thinking>正文'), '正文');
    assert.equal(core.stripThinkingBlocks('<think>a</think><thought>b</thought>真内容'), '真内容');
    assert.equal(core.stripThinkingBlocks('前言<思考>内心戏</思考>后记'), '前言后记');
    assert.equal(core.stripThinkingBlocks('<reasoning>未闭合的思考\n第二行'), '');
});

test('trimToProfileFields 丢掉第一个字段之前的废话', () => {
    const raw = '好的，我先分析一下需求。\n**身份**：风纪委员\n**外貌**：双马尾';
    const out = core.trimToProfileFields(raw);
    assert.ok(out.startsWith('**身份**'));
    assert.ok(!out.includes('我先分析'));
});

test('sanitizeProfileOutput 组合清洗：思考 + 前提废话都清掉', () => {
    const raw = '<thinking>先想想要写什么……</thinking>\n好的，以下是资料：\n**身份**：常盘台中学的风纪委员\n**外貌**：茶色双马尾\n**资料来源**：https://x';
    const out = core.sanitizeProfileOutput(raw);
    assert.ok(out.startsWith('**身份**'));
    assert.ok(!out.includes('先想想'));
    assert.ok(!out.includes('以下是资料'));
    assert.ok(out.includes('资料来源'));
});

test('sanitizeProfileOutput 支持字数上限', () => {
    const out = core.sanitizeProfileOutput('**身份**：' + 'x'.repeat(500), 100);
    assert.ok(out.length <= 120);
    assert.ok(out.includes('已截断'));
});

test('正文上限默认不限（用户要求别截断）', () => {
    assert.equal(core.DEFAULT_SETTINGS.readerMaxChars, 0);
    assert.equal(core.DEFAULT_SETTINGS.readerTotalChars, 0);
});

/* ---------------- 候选网址筛选 ---------------- */
console.log('\n候选网址筛选');

test('rankAndFilterUrls 干掉百度/脸书/视频站/搜索结果页', () => {
    const items = [
        { url: 'https://baike.baidu.com/item/x' },
        { url: 'https://www.facebook.com/p' },
        { url: 'https://www.bilibili.com/video/BV1' },
        { url: 'https://www.google.com/search?q=x' },
        { url: 'https://www.youtube.com/watch?v=1' },
        { url: 'https://toaru.huijiwiki.com/wiki/x' },
    ];
    const picked = core.rankAndFilterUrls(items, { max: 3 });
    assert.deepEqual(picked.map((p) => p.url), ['https://toaru.huijiwiki.com/wiki/x']);
});

test('rankAndFilterUrls 百科站优先，且同站只留一条', () => {
    const items = [
        { url: 'https://example.com/a' },
        { url: 'https://zh.wikipedia.org/wiki/x' },
        { url: 'https://zh.wikipedia.org/wiki/y' },
        { url: 'https://zh.moegirl.org.cn/x' },
    ];
    const picked = core.rankAndFilterUrls(items, { max: 3, perHost: 1 });
    assert.equal(picked[0].url, 'https://zh.wikipedia.org/wiki/x');
    assert.equal(picked.filter((p) => p.host.includes('wikipedia')).length, 1);
    assert.equal(picked.length, 3);
});

test('rankAndFilterUrls 非 http(s) 或空列表安全返回', () => {
    assert.deepEqual(core.rankAndFilterUrls([], { max: 3 }), []);
    assert.deepEqual(core.rankAndFilterUrls([{ url: 'ftp://x' }, { url: '' }], { max: 3 }), []);
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);