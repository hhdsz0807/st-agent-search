/**
 * agent-core.js — 🦊Agent 搜索 · 独立版 纯逻辑核心
 *
 * 本文件是从《[主预设] V19.7.3 狐神抚 · 毓忻.json》里
 * extensions.tavern_helper.scripts[1]（🦊原预设・狐神撫，4,850,787 字符）中
 * 抽出的「Agent 搜索」模块逻辑，去掉原预设本体依赖后重写为无副作用纯函数。
 *
 * 保留原文的部分：
 *  - DEFAULT_SETTINGS：对应原脚本 `const w = {...}`（偏移 51,180 前后）
 *  - 全部 LLM 提示词（关键词提取 / Jina 前置筛选 / 知识整理）
 *  - 标签过滤算法（ssNormalizeTagFilterSettings / ssFindTagRanges / ssMergeRanges / ssRemoveRanges）
 *  - 注入包装（ssWrapTaggedContent + agent_search 默认 head/tail）
 *  - 自定义搜索 API 请求构造与结果字段映射（husouSearchCustom）
 *
 * 本文件不 import 任何 SillyTavern 模块，可被 node 直接测试（见 test-ag-core.mjs）。
 */

export const VERSION = '1.0.2';

/* ============================================================================
 * 1. 默认配置（逐字提取，键名与原脚本保持一致）
 * ==========================================================================*/

/** 原脚本常量：默认不含任何 include 标签对 */
export const DEFAULT_INCLUDE_TAG_PAIRS = [
    { start: '<All_Context>', end: '</All_Context>' },
    { start: '<content>', end: '</content>' },
];

/** 原脚本常量 ssDefaultExcludeTagPairs() */
export const DEFAULT_EXCLUDE_TAG_PAIRS = [
    { start: '<stage_2_pre_output_check>', end: '</stage_2_pre_output_check>' },
    { start: '<stage_1_base_requirements>', end: '</stage_1_base_requirements>' },
    { start: '<think_fox~>', end: '</think_fox~>' },
];

/** Agent 搜索注入提示词默认值（原脚本 ssBuildSearchResultsInject 内注册的 agent_search 槽） */
export const FOX_SEARCH_PROMPT_DEFAULTS = {
    agent_search: {
        head: '【Agent 搜索注入】以下信息是通过网页搜索后得到的信息',
        tail: '以上内容只是通过搜索得来！具体信息以上下文中的角色信息描述为准！\n如果没有内容，跳过即可。',
    },
};

/** 搜索结果包装标签（原脚本 ssBuildSearchResultsInject 中传给 ssWrapTaggedContent 的标签名） */
export const SEARCH_RESULTS_TAG = 'SearchResults';

/**
 * Agent 搜索默认设置 —— 逐字提取自原脚本 `const w = { ... }`。
 * 注意：searchApiUrl 的预设默认值是 http://localhost:8888/...；
 * 教程（Agent 搜索教程1.4）里本机 SearXNG 用的是 18080，面板里有「填入本机 SearXNG」按钮。
 */
export const DEFAULT_SETTINGS = {
    // —— 自动搜索 ——
    enableAutoSearch: false,
    autoMode: 'manual', // manual | auto | interval
    autoInterval: 5,
    backgroundSilent: false,
    sendAnalyze: false,

    // —— 搜索源开关 ——
    enableMoegirl: false,
    enableWikipedia: false,
    enableCustomSearch: true,
    enableJinaFetch: true,
    enableJinaPrefilter: true,

    // —— 上下文内容过滤（送入分析模型前） ——
    enableContentFilter: true,
    includeTagPairs: [],
    excludeTagPairs: [
        { start: '<stage_2_pre_output_check>', end: '</stage_2_pre_output_check>' },
        { start: '<stage_1_base_requirements>', end: '</stage_1_base_requirements>' },
        { start: '<think_fox~>', end: '</think_fox~>' },
    ],
    includeTagStarts: '',
    includeTagEnds: '',
    excludeTagStarts: '<stage_2_pre_output_check>\n<stage_1_base_requirements>\n<think_fox~>\n',
    excludeTagEnds: '</stage_2_pre_output_check>\n</stage_1_base_requirements>\n</think_fox~>',

    // —— 智能 / 过滤 ——
    smartSkip: true,
    aiFilter: true,
    filterMode: 'focus', // focus=只留与关键词直接相关的 | perKeyword=按关键词逐条整理成角色卡 | allEntities=原版（所有出现的实体都收）

    // —— 结果落盘 ——
    saveToPersonality: false,
    saveToHusouLocal: true,
    injectCurrentPrompt: true,

    // —— 分析模型 ——
    analysisApi: 'current', // current | custom
    customApiUrl: '',
    customApiKey: '',
    customModel: '',
    customMaxTokens: 16384, // 预设原文 4096；推理模型思考很吃额度，直接给够，别靠重试兜底
    analysisReasoningEffort: '', // ''=不干预 | none/low/medium/high：让推理模型少思考，避免正文被 max_tokens 掐掉
    customTemperature: 1,
    customFrequencyPenalty: 0,
    customPresencePenalty: 0,
    customTopP: 1,
    customTopK: 0,
    customExtraBodyParamsYaml: '',
    customExcludeBodyParamsYaml: '',
    customExtraHeadersYaml: '',

    // —— 搜索预设 ——
    searchPresetMode: 'builtin',
    searchPresetName: '',

    // —— 自定义搜索 API（SearXNG 等） ——
    searchApiUrl: 'http://localhost:8888/search?q={keyword}&format=json&language={language}',
    searchApiMethod: 'GET',
    searchApiKey: '',
    searchApiKeyHeaderName: 'Authorization',
    searchApiKeyHeaderTemplate: 'Bearer {key}',
    searchApiQueryParam: '',
    searchApiBodyTemplate: '',
    searchApiResultPath: 'results',
    searchApiTitleField: 'title',
    searchApiSnippetField: 'content',
    searchApiLinkField: 'url',
    searchApiLanguage: 'zh-CN',
    searchApiExtraParams: '',

    // —— 数量 / 超时 ——
    maxKeywords: 0, // 0 = 不限
    searchTimeout: 20000,
    maxExtractLength: 0, // 0 = 不裁剪
    searchResultsCount: 10,
    jinaPageTimeout: 8000, // 单页全文超时（原预设 20000 太慢；慢页基本没价值）

    // —— 本插件新增（原脚本没有，默认值与原预设行为一致） ——
    foxSearchHead: FOX_SEARCH_PROMPT_DEFAULTS.agent_search.head,
    foxSearchTail: FOX_SEARCH_PROMPT_DEFAULTS.agent_search.tail,
    contextFloors: 12, // 送入分析模型的最近楼层数
    jinaMaxUrlsPerKeyword: 3, // 每个关键词最多抓几个网页全文
    jinaMaxUrlsTotal: 3, // **全局**最多抓几个网页（用户预期：抓前 3 个就够了）
    jinaConcurrency: 3, // 并发抓取数（串行是 4 分钟慢的主因）
    jinaTotalBudgetMs: 25000, // 全文抓取阶段总时间预算
    jinaMinTextLength: 200, // 清洗后短于此长度视为无效正文
    analysisMaxInputChars: 12000, // 发给分析模型的字符上限（0=不限）；超限自动截断 + 逐级重试
    libraryStorage: 'server', // server=存服务器世界书（跨设备） | local=只存本浏览器
    libraryWorldName: 'Agent 搜索资料库', // 绑定的世界书（写词条的那本）
    libraryInject: 'worldbook', // worldbook=交给世界书按灯/关键词注入（推荐） | plugin=插件再注入一次
    quickFabOpen: false, // 悬浮悬浮按钮按钮是否处于展开状态（记住用户选择）
    quickFabPos: null, // 悬浮按钮按钮位置 {left, top}
    providerMode: 'reader', // reader=把百科网址交给模型读并整理（推荐） | api=插件用官方 API 取正文
    readerMaxChars: 0, // 单页正文上限（0=不限；用户要求别截断，要限就自己填）
    readerTotalChars: 0, // 交给模型的正文总量上限（0=不限）
    readerPagesPerSource: 2, // 每个百科站最多给出几个条目网址
    readerMaxUrls: 3, // **全局**最多交给 AI 去读的网址数（自定义来源的前 3 条优先）
    sourceTopPages: 2, // 每个搜索源最多取前几个词条的完整正文
    sourceExtractChars: 4000, // 单个词条正文保留上限（字）
    debugLog: false,
};

/** 本机 SearXNG 常用地址（教程 1.4 的 18080 端口） */
export const LOCAL_SEARXNG_URL = 'http://localhost:18080/search?q={keyword}&format=json&language={language}';

/* ============================================================================
 * 2. 设置归一化
 * ==========================================================================*/

export function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * 合并并归一化设置。对应原脚本 loadHusouSettings() +
 * ssNormalizeTagFilterSettings()。
 */
export function normalizeSettings(raw) {
    const merged = { ...deepClone(DEFAULT_SETTINGS), ...(raw && typeof raw === 'object' ? raw : {}) };

    const normalized = normalizeTagFilterSettings(merged);

    // 旧字段兼容：enableAutoSearch 与 autoMode 双写
    if (raw && raw.autoMode == null && raw.enableAutoSearch != null) {
        normalized.autoMode = raw.enableAutoSearch ? 'auto' : 'manual';
    }
    if (!['manual', 'auto', 'interval'].includes(normalized.autoMode)) {
        normalized.autoMode = 'manual';
    }
    normalized.autoInterval = Math.max(1, parseInt(normalized.autoInterval) || 5);
    normalized.enableAutoSearch = normalized.autoMode !== 'manual';

    // 数值兜底
    const num = (v, fallback, min) => {
        const n = Number(v);
        const r = Number.isFinite(n) ? n : fallback;
        return min === undefined ? r : Math.max(min, r);
    };
    normalized.maxKeywords = num(normalized.maxKeywords, 0, 0);
    normalized.searchResultsCount = num(normalized.searchResultsCount, 10, 1);
    normalized.searchTimeout = num(normalized.searchTimeout, 20000, 1000);
    normalized.maxExtractLength = num(normalized.maxExtractLength, 0, 0);
    normalized.jinaPageTimeout = num(normalized.jinaPageTimeout, 20000, 1000);
    normalized.contextFloors = num(normalized.contextFloors, 12, 0);
    normalized.jinaMaxUrlsPerKeyword = num(normalized.jinaMaxUrlsPerKeyword, 3, 0);
    normalized.jinaMinTextLength = num(normalized.jinaMinTextLength, 200, 0);
    normalized.searchApiMethod = String(normalized.searchApiMethod || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    normalized.searchApiResultPath = String(normalized.searchApiResultPath || 'results').trim() || 'results';
    normalized.searchApiTitleField = String(normalized.searchApiTitleField || 'title').trim() || 'title';
    normalized.searchApiSnippetField = String(normalized.searchApiSnippetField || 'content').trim() || 'content';
    normalized.searchApiLinkField = String(normalized.searchApiLinkField || 'url').trim() || 'url';

    return normalized;
}

/* ============================================================================
 * 3. 标签过滤（逐字移植 ssNormalizeTagFilterSettings 及其助手）
 * ==========================================================================*/

export function pairsToLines(pairs, which) {
    return (pairs || []).map((p) => (which === 'start' ? p.start || '' : p.end || '')).join('\n');
}

export function linesToPairs(starts, ends) {
    const a = String(starts ?? '').split('\n').map((s) => s.trim());
    const b = String(ends ?? '').split('\n').map((s) => s.trim());
    const len = Math.max(a.length, b.length);
    const out = [];
    for (let i = 0; i < len; i++) {
        const start = a[i] || '';
        const end = b[i] || '';
        if (!start && !end) continue;
        out.push({ start, end });
    }
    return out;
}

export function normalizeTagFilterSettings(settings = {}) {
    const s = { ...settings };

    if (!Array.isArray(s.includeTagPairs)) {
        if (typeof s.includeTagStarts === 'string' || typeof s.includeTagEnds === 'string') {
            s.includeTagPairs = linesToPairs(s.includeTagStarts || '', s.includeTagEnds || '');
        } else {
            s.includeTagPairs = deepClone(DEFAULT_INCLUDE_TAG_PAIRS);
        }
    }
    if (!Array.isArray(s.excludeTagPairs)) {
        if (typeof s.excludeTagStarts === 'string' || typeof s.excludeTagEnds === 'string') {
            s.excludeTagPairs = linesToPairs(s.excludeTagStarts || '', s.excludeTagEnds || '');
        } else {
            s.excludeTagPairs = deepClone(DEFAULT_EXCLUDE_TAG_PAIRS);
        }
    }

    // 历史遗留脏值修复（原文同款）
    const incStarts = String(s.includeTagStarts || '').trim();
    const incEnds = String(s.includeTagEnds || '').trim();
    if (incStarts === '<content\n<All_Context\n<SearchResults' || incStarts === '<content\r\n<All_Context\r\n<SearchResults') {
        s.includeTagPairs = deepClone(DEFAULT_INCLUDE_TAG_PAIRS);
    }
    if (incEnds === 'content>\nAll_Context>\nSearchResults>' || incEnds === 'content>\r\nAll_Context>\r\nSearchResults>') {
        s.includeTagPairs = deepClone(DEFAULT_INCLUDE_TAG_PAIRS);
    }
    if (String(s.excludeTagStarts || '').trim() === '<think_fox~>' && !String(s.excludeTagEnds || '').trim()) {
        s.excludeTagPairs = deepClone(DEFAULT_EXCLUDE_TAG_PAIRS);
    }
    if (String(s.excludeTagStarts || '').trim() === '<think_fox~' && !String(s.excludeTagEnds || '').trim()) {
        s.excludeTagPairs = deepClone(DEFAULT_EXCLUDE_TAG_PAIRS);
    }

    if (Array.isArray(s.excludeTagPairs)) {
        for (const pair of s.excludeTagPairs) {
            if (pair && (!pair.start || String(pair.start).trim() === '') && String(pair.end || '').trim() === '</think_fox~>') {
                pair.start = '<think_fox~>';
            }
        }
        s.excludeTagPairs = s.excludeTagPairs.filter(
            (p) => !p || !(String(p.start || '').trim() === '<All_Context>' && String(p.end || '').trim() === '</All_Context>'),
        );
    }

    // 丢弃 start === end 的坏对（原文 __dropBrokenPairs）
    const dropBroken = (arr) => (Array.isArray(arr) ? arr : []).filter((p) => {
        if (!p) return false;
        const start = String(p.start || '').trim();
        const end = String(p.end || '').trim();
        return !(start && end && start === end);
    });
    s.includeTagPairs = dropBroken(s.includeTagPairs);
    s.excludeTagPairs = dropBroken(s.excludeTagPairs);

    s.includeTagStarts = pairsToLines(s.includeTagPairs, 'start');
    s.includeTagEnds = pairsToLines(s.includeTagPairs, 'end');
    s.excludeTagStarts = pairsToLines(s.excludeTagPairs, 'start');
    s.excludeTagEnds = pairsToLines(s.excludeTagPairs, 'end');
    return s;
}

/** 逐字移植 ssMergeRanges */
export function mergeRanges(ranges) {
    const list = ranges
        .filter((r) => Array.isArray(r) && r.length === 2 && r[0] < r[1])
        .sort((a, b) => a[0] - b[0]);
    if (!list.length) return [];
    const out = [list[0]];
    for (let i = 1; i < list.length; i++) {
        const last = out[out.length - 1];
        const cur = list[i];
        if (cur[0] <= last[1]) {
            last[1] = Math.max(last[1], cur[1]);
        } else {
            out.push(cur);
        }
    }
    return out;
}

/** 逐字移植 ssRemoveRanges */
export function removeRanges(text, ranges) {
    const src = String(text || '');
    const merged = mergeRanges(ranges);
    if (!merged.length) return src;
    let out = '';
    let cursor = 0;
    for (const [start, end] of merged) {
        if (start > cursor) out += src.slice(cursor, start);
        cursor = Math.max(cursor, end);
    }
    out += src.slice(cursor);
    return out;
}

/** 只保留给定区间（removeRanges 的补运算） */
export function keepRanges(text, ranges) {
    const src = String(text || '');
    const merged = mergeRanges(ranges);
    if (!merged.length) return '';
    return merged.map(([start, end]) => src.slice(start, end)).join('\n');
}

/** 逐字移植 ssFindTagRanges */
export function findTagRanges(text, startTag, endTag, mode = 'include') {
    const src = String(text || '');
    const ranges = [];
    const start = String(startTag || '');
    const end = String(endTag || '');

    if (start && end) {
        let cursor = 0;
        while (cursor < src.length) {
            const i = src.indexOf(start, cursor);
            if (i < 0) break;
            const afterStart = i + start.length;
            const j = src.indexOf(end, afterStart);
            if (j < 0) break;
            if (mode === 'exclude') {
                ranges.push([i, j + end.length]);
            } else {
                ranges.push([afterStart, j]);
            }
            cursor = j + end.length;
        }
        return ranges;
    }
    if (start && !end) {
        const i = src.indexOf(start);
        if (i >= 0) {
            if (mode === 'exclude') ranges.push([i, src.length]);
            else ranges.push([i + start.length, src.length]);
        }
        return ranges;
    }
    if (!start && end) {
        const i = src.indexOf(end);
        if (i >= 0) {
            if (mode === 'exclude') ranges.push([0, i + end.length]);
            else ranges.push([0, i]);
        }
        return ranges;
    }
    return ranges;
}

/**
 * 把「内容过滤」设置应用到某段文本上：
 *  - includeTagPairs 非空时，只保留标签内部内容；
 *  - excludeTagPairs 命中区间整体删除。
 */
export function applyTagFilter(text, settings) {
    const s = settings || {};
    if (!s.enableContentFilter) return String(text || '');

    let out = String(text || '');

    const include = Array.isArray(s.includeTagPairs) ? s.includeTagPairs : [];
    if (include.length) {
        const ranges = [];
        for (const p of include) ranges.push(...findTagRanges(out, p.start, p.end, 'include'));
        const kept = keepRanges(out, mergeRanges(ranges));
        if (kept.trim()) out = kept;
    }

    const exclude = Array.isArray(s.excludeTagPairs) ? s.excludeTagPairs : [];
    const ranges = [];
    for (const p of exclude) ranges.push(...findTagRanges(out, p.start, p.end, 'exclude'));
    out = removeRanges(out, ranges);

    return out
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/* ============================================================================
 * 4. 关键词
 * ==========================================================================*/

/** 逐字移植 husouNormalizeKeywords */
export function normalizeKeywords(input) {
    if (Array.isArray(input)) {
        return [...new Set(input.map((v) => String(v || '').trim()).filter(Boolean))];
    }
    return [
        ...new Set(
            String(input || '')
                .split(/[\n,，、;；|]+/g)
                .map((v) => v.trim())
                .filter(Boolean),
        ),
    ];
}

/** 逐字移植 husouKeywordsLine */
export function keywordsLine(input) {
    const list = normalizeKeywords(input);
    return list.length ? `当前搜索关键词：${list.join('、')}` : '';
}

/** 从模型返回里抠出 JSON 数组（原文 husouAnalyzeContext 中的 /\[[\s\S]*?\]/ 解析） */
export function parseJsonArray(text) {
    const src = String(text || '').trim();
    if (!src) return { ok: false, error: 'KEYWORD_MODEL_EMPTY', value: [] };
    const match = src.match(/\[[\s\S]*?\]/);
    if (!match) return { ok: false, error: 'KEYWORD_PROTOCOL_MISSING', value: [] };
    try {
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed)) return { ok: false, error: 'KEYWORD_NOT_ARRAY', value: [] };
        return { ok: true, value: normalizeKeywords(parsed) };
    } catch (e) {
        return { ok: false, error: 'KEYWORD_PARSE_FAILED', value: [], detail: e.message };
    }
}

/* ============================================================================
 * 5. 搜索结果 → 纯文本 / 注入块
 * ==========================================================================*/

/**
 * 逐字移植 husouMapToPlainText：
 *   【关于「关键词」的说明】\n<内容>  …  末尾追加「当前搜索关键词：…」
 */
export function mapToPlainText(resultMap, keywords = []) {
    if (!resultMap || !resultMap.size) return '';
    const blocks = [...resultMap].map(([keyword, content]) => `【关于「${keyword}」的说明】\n${content}`);
    const line = keywordsLine(keywords?.length ? keywords : [...resultMap.keys()]);
    return `${blocks.join('\n\n')}${line ? `\n\n${line}` : ''}`.trim();
}

/** 逐字移植 ssWrapTaggedContent */
export function wrapTaggedContent(tag, content, head = '', tail = '') {
    const body = String(content || '').trim();
    if (!body) return '';
    return `<${tag}>\n${head ? head.trim() + '\n\n' : ''}${body}${tail ? '\n\n' + tail.trim() : ''}\n</${tag}>`;
}

/** 逐字移植 ssBuildSearchResultsInject（含默认 head/tail） */
export function buildSearchResultsInject(content, head, tail) {
    const h = head === undefined || head === null ? FOX_SEARCH_PROMPT_DEFAULTS.agent_search.head : head;
    const t = tail === undefined || tail === null ? FOX_SEARCH_PROMPT_DEFAULTS.agent_search.tail : tail;
    return wrapTaggedContent(SEARCH_RESULTS_TAG, content, h, t);
}

/** 逐字移植 husouBuildInjectBlock */
export function buildInjectBlock(resultMap, head, tail, keywords = []) {
    const text = mapToPlainText(resultMap, keywords);
    if (!text) return '';
    return `\n\n${buildSearchResultsInject(text, head, tail)}\n`;
}

/** 与原脚本同款：从 personality / 文本里剥掉旧注入 */
export function stripSearchInjection(text) {
    let out = String(text || '');
    out = out.replace(/\n*<SearchResults>[\s\S]*?<\/SearchResults>\n*/gi, '\n');
    out = out.replace(/\n*【🦊Agent 搜索外部搜索参考[\s\S]*?【外部搜索参考结束】\n*/g, '\n');
    out = out.replace(/\n*【🔍 外部搜索参考[\s\S]*?【外部搜索参考结束】\n*/g, '\n');
    out = out.replace(/^\s*【外部搜索参考结束】\s*$/gm, '');
    out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

/** 逐字移植 husouSafeUrl（打日志用，隐藏 key） */
export function safeUrl(url, base) {
    try {
        const u = new URL(String(url || ''), base || 'http://localhost/');
        const params = [...u.searchParams.keys()];
        const path = u.pathname
            .split('/')
            .map((seg) => (/(?:key|token|secret|password)/i.test(seg) || seg.length > 80 ? '[已隐藏]' : seg))
            .join('/');
        return `${u.origin}${path}${params.length ? `?参数=${params.join(',')}` : ''}`;
    } catch {
        return `[无法解析URL，长度=${String(url || '').length}]`;
    }
}

/* ============================================================================
 * 6. 自定义搜索 API（SearXNG 兼容）—— 移植 husouSearchCustom
 * ==========================================================================*/

/** 构造请求 URL / body / headers，返回 { url, method, headers, body } */
export function buildCustomRequest(keyword, settings) {
    const cfg = settings || {};
    const rawUrl = String(cfg.searchApiUrl || '').trim();
    if (!rawUrl) {
        const err = new Error('自定义搜索已启用，但 API 地址为空');
        err.code = 'CUSTOM_CONFIG_URL_EMPTY';
        throw err;
    }
    const method = String(cfg.searchApiMethod || 'GET').toUpperCase();
    const apiKey = String(cfg.searchApiKey || '').trim();
    const language = String(cfg.searchApiLanguage || 'zh-CN').trim();
    const useLang = !!language && language !== 'auto';

    const headers = { Accept: 'application/json' };
    if (apiKey && String(cfg.searchApiKeyHeaderName || '').trim()) {
        const tpl = String(cfg.searchApiKeyHeaderTemplate || '{key}').trim() || '{key}';
        headers[String(cfg.searchApiKeyHeaderName).trim()] = tpl.replace(/\{key\}/g, apiKey);
    }

    let url = rawUrl
        .replace(/\{keyword\}/g, encodeURIComponent(keyword))
        .replace(/\{language\}/g, encodeURIComponent(language));

    let body = null;
    if (method === 'POST') {
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const tpl = String(cfg.searchApiBodyTemplate || '').trim() || '{"query":"{keyword}"}';
        const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        body = tpl.replace(/\{keyword\}/g, esc(keyword)).replace(/\{language\}/g, esc(language));
    } else {
        if (apiKey && String(cfg.searchApiQueryParam || '').trim()) {
            url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(String(cfg.searchApiQueryParam).trim())}=${encodeURIComponent(apiKey)}`;
        }
        if (String(cfg.searchApiExtraParams || '').trim()) {
            let extra = String(cfg.searchApiExtraParams)
                .trim()
                .replace(/\{keyword\}/g, encodeURIComponent(keyword))
                .replace(/\{language\}/g, encodeURIComponent(language));
            if (!extra.startsWith('&') && !extra.startsWith('?')) {
                extra = (url.includes('?') ? '&' : '?') + extra;
            }
            url += extra;
        }
        if (useLang && !url.includes('language=') && !url.includes('lang=')) {
            url += `${url.includes('?') ? '&' : '?'}language=${encodeURIComponent(language)}`;
        }
    }

    return { url, method, headers, body };
}

/** 按 searchApiResultPath 取数组（支持 "data.items" / "items.0"） */
export function resolveResultPath(json, path) {
    let cur = json;
    for (const seg of String(path || 'results').split('.')) {
        if (cur == null) break;
        cur = /^\d+$/.test(seg) ? cur[parseInt(seg, 10)] : cur[seg];
    }
    return cur;
}

/**
 * 把自定义 API 的 JSON 映射成一行行文本（移植 husouSearchCustom 的映射段）。
 * 返回 { lines: string[], rawCount, error? }
 */
export function mapCustomResults(json, settings) {
    const cfg = settings || {};
    const path = cfg.searchApiResultPath || 'results';
    const arr = resolveResultPath(json, path);
    if (!Array.isArray(arr)) {
        return {
            lines: [],
            rawCount: 0,
            error: `结果路径“${path}”没有得到数组`,
            errorCode: 'CUSTOM_RESULT_PATH_INVALID',
        };
    }

    const titleField = cfg.searchApiTitleField || 'title';
    const snippetField = cfg.searchApiSnippetField || 'content';
    const linkField = cfg.searchApiLinkField || 'url';
    const limit = Number(cfg.searchResultsCount) || 10;

    const lines = [];
    for (const item of arr) {
        const title = (item?.[titleField] ?? '').toString();
        const snippet = (item?.[snippetField] ?? '')
            .toString()
            .replace(/<[^>]+>/g, '')
            .replace(/\n+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const link = (item?.[linkField] ?? '').toString();
        if (!title && !snippet) continue;
        let line = title ? `【${title}】` : '';
        line += snippet;
        if (link) line += `\n🔗 ${link}`;
        if (line) lines.push(line);
        if (lines.length >= limit) break;
    }
    return { lines, rawCount: arr.length };
}

/* ============================================================================
 * 7. Jina 全文抓取助手（移植 husouCleanJinaText / husouExtractJinaCandidates）
 * ==========================================================================*/

/** 逐字移植 husouCleanJinaText */
export function cleanJinaText(text) {
    let t = String(text || '');
    t = t.replace(/^Title:\s*.*$/gim, '');
    t = t.replace(/^URL Source:\s*https?:\/\/\S+.*$/gim, '');
    t = t.replace(/^Published Time:\s*.*$/gim, '');
    t = t.replace(/^Markdown Content:\s*$/gim, '');
    t = t.replace(/!\[[^\]]*?\]\((?:https?:\/\/|data:image\/)[^)]+\)/gi, '');
    t = t.replace(/<img\b[^>]*>/gi, '');
    t = t.replace(/\[([^\]]{0,120})\]\((?:https?:\/\/|\/)[^)]+\)/gi, '$1');
    t = t.replace(/https?:\/\/[^\s"'<>，。！？、；：）)\]}【】]+/gi, '');
    t = t.replace(/\bwww\.[^\s"'<>，。！？、；：）)\]}【】]+/gi, '');
    return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** 逐字移植 husouNormalizeJinaUrl */
export function normalizeJinaUrl(url) {
    return String(url || '')
        .trim()
        .replace(/[)\]）】。,.，；;]+$/g, '');
}

/**
 * 按字符预算拼装「原始搜索结果」文本，供知识整理提示词使用。
 *
 * 线上真实故障：把全部原始结果（Wiki 摘要 + Jina 全文，动辄上万字符）连同六类 65 维度规则
 * 一起发给分析模型，小上下文连接会直接空返回（酒馆报 "No message generated"）。
 * 这里做两级裁剪：单关键词上限 perKeywordChars + 全局上限 maxChars，并显式标注截断。
 *
 * @returns {{text: string, usedChars: number, truncated: boolean}}
 */
export function buildBudgetedRawText(resultMap, options = {}) {
    const { maxChars = 0, perKeywordChars = 0 } = options;
    const parts = [];
    let used = 0;
    let truncated = false;

    if (!resultMap || !resultMap.size) return { text: '', usedChars: 0, truncated: false };

    for (const [keyword, content] of resultMap) {
        let body = String(content || '');
        if (perKeywordChars > 0 && body.length > perKeywordChars) {
            body = `${body.slice(0, perKeywordChars)}\n…（本关键词结果已截断）`;
            truncated = true;
        }
        const block = `\n=== 「${keyword}」===\n${body}\n`;
        if (maxChars > 0 && used + block.length > maxChars) {
            const remain = maxChars - used;
            if (remain > 300) {
                parts.push(`${block.slice(0, remain)}\n…（已达总长度上限，后续结果已省略）`);
                truncated = true;
            }
            used = Math.min(maxChars, used + Math.max(remain, 0));
            break;
        }
        parts.push(block);
        used += block.length;
    }
    return { text: parts.join(''), usedChars: used, truncated };
}

/** 逐级重试用的预算阶梯：全量 → 1/2 → 1/4（maxChars=0 时只有一档） */
export function budgetLadder(maxChars) {
    const max = Number(maxChars) || 0;
    if (max <= 0) return [0];
    const ladder = [max];
    for (const factor of [2, 4]) {
        const next = Math.max(1500, Math.round(max / factor));
        if (next < ladder[ladder.length - 1]) ladder.push(next);
    }
    return ladder;
}

/**
 * 分析模型的重试计划。
 *
 * 线上真实故障：`finish_reason=length` + 正文 0 字符 + 思考 6000+ 字符
 * —— 模型把输出额度全花在思维链上，正文没写出来。此时**裁剪输入毫无帮助**，
 * 必须**放大输出上限 max_tokens**。所以先按输出加倍重试，再考虑缩减输入。
 *
 * @returns {{maxInput:number, maxOutput:number, why:string}[]}
 */
export function analysisAttempts({ baseOutput = 16384, maxInputChars = 12000, maxOutputCap = 32768 } = {}) {
    const base = Math.max(1024, Math.round(Number(baseOutput) || 16384));
    const cap = Math.max(base, Math.round(Number(maxOutputCap) || 32768));
    const inLadder = budgetLadder(maxInputChars);
    const attempts = [{ maxInput: inLadder[0], maxOutput: base, why: '首次尝试', kind: 'first' }];

    // 输出被掐断：只再抬一次输出上限（不做无谓的输入裁剪，那样根本治不了）
    const bumped = Math.min(cap, base * 2);
    if (bumped > base) {
        attempts.push({ maxInput: inLadder[0], maxOutput: bumped, why: `上一轮输出被 max_tokens 掐断，抬到 ${bumped} 再试一次`, kind: 'bump-output' });
    }
    // 其它类型失败（协议不对/内容过长）：才考虑逐步裁剪输入
    for (const maxInput of inLadder.slice(1)) {
        attempts.push({ maxInput, maxOutput: bumped > base ? bumped : base, why: `仍失败，改为裁剪输入到 ${maxInput} 字符`, kind: 'shrink-input' });
    }
    return attempts;
}

/** 判断某个失败是否属于「输出被 max_tokens 掐断」 */
export function isOutputTruncated(err) {
    const info = err?.detail?.info || err?.info;
    return !!info && info.finishReason === 'length';
}

/**
 * 由 chat/completions 地址推导 /models 地址（用于自动拉取模型列表）。
 * 例：https://api.commandcode.ai/provider/v1  →  https://api.commandcode.ai/provider/v1/models
 *     https://x/v1/chat/completions          →  https://x/v1/models
 */
export function modelsEndpoint(apiUrl) {
    let u = String(apiUrl || '').trim();
    if (!u) return '';
    u = u.replace(/\/chat\/completions\/?$/i, '');
    u = u.replace(/\/completions\/?$/i, '');
    u = u.replace(/\/+$/, '');
    return `${u}/models`;
}

/** 兼容各家 /models 返回结构，抽出模型 id 并排序去重 */
export function parseModelIds(json) {
    const pick = (item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.id || item.name || item.model || '';
        return '';
    };
    const list = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.models)
          ? json.models
          : Array.isArray(json)
            ? json
            : [];
    return [...new Set(list.map(pick).map((s) => String(s || '').trim()).filter(Boolean))].sort();
}

/* ============================================================================
 * 资料库 ↔ 世界书（服务端存储载体）
 *
 * 酒馆的 /api/worldinfo/edit 会把 JSON 写到服务器 data/<user>/worlds/<name>.json，
 * 因此同一台酒馆服务器的所有浏览器/设备共用一份资料，还能在世界书界面里直接看。
 * 条目做成「无关键词、非常驻」，所以不会被酒馆自动激活触发（避免和插件注入重复）。
 * ==========================================================================*/

/** 世界书条目字段模板（ST 读取时会补默认值，这里给全常用字段更稳） */
export const WORLD_ENTRY_DEFAULTS = {
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: false,
    selectiveLogic: 0,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    displayIndex: 0,
    extensions: {},
};

/** blocks → 世界书数据对象 */
export function blocksToWorldData(name, blocks) {
    const entries = {};
    const list = (Array.isArray(blocks) ? blocks : []).filter((b) => String(b?.content || '').trim());
    list.forEach((block, i) => {
        const uid = i;
        entries[uid] = {
            ...deepClone(WORLD_ENTRY_DEFAULTS),
            uid,
            comment: `Agent 搜索资料 #${i + 1}${block?.ts ? ` · ${block.ts}` : ''}`,
            content: String(block.content),
            displayIndex: i,
            addMemo: true,
            extensions: { agent_search: { ts: block?.ts || '', index: i } },
        };
    });
    return {
        name,
        entries,
        extensions: { agent_search: { kind: 'library', version: 1, savedAt: new Date().toISOString() } },
    };
}

/** 世界书数据对象 → blocks（按 displayIndex/uid 排序，读回扩展里的 ts） */
export function worldDataToBlocks(worldData) {
    const entries = worldData && typeof worldData === 'object' && worldData.entries && typeof worldData.entries === 'object' ? worldData.entries : {};
    return Object.values(entries)
        .filter((e) => e && String(e.content || '').trim())
        .sort((a, b) => {
            const ai = Number.isFinite(Number(a.displayIndex)) ? Number(a.displayIndex) : Number(a.uid) || 0;
            const bi = Number.isFinite(Number(b.displayIndex)) ? Number(b.displayIndex) : Number(b.uid) || 0;
            return ai - bi;
        })
        .map((e) => ({
            ts: String(e?.extensions?.agent_search?.ts || '').trim(),
            content: String(e.content),
        }));
}

/**
 * 从结果 map 里提取所有 🔗 URL 候选（移植 husouExtractJinaCandidates）。
 * @returns {{index:number, keyword:string, title:string, snippet:string, url:string}[]}
 */
export function extractJinaCandidates(resultMap) {
    const out = [];
    if (!resultMap || !resultMap.size) return out;
    let index = 0;
    for (const [keyword, content] of resultMap) {
        const text = String(content || '');
        const blocks = text.split(/\n(?=【)/);
        for (const block of blocks) {
            const urls = [...block.matchAll(/🔗\s+(https?:\/\/[^\s]+)/g)]
                .map((m) => normalizeJinaUrl(m[1]))
                .filter(Boolean);
            if (!urls.length) continue;
            const titleMatch = block.match(/^【([^】]+)】/);
            const title = titleMatch ? titleMatch[1] : '';
            const snippet = block
                .replace(/🔗\s+https?:\/\/\S+/g, '')
                .replace(/^【[^】]+】/, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 300);
            for (const url of urls) {
                out.push({ index: ++index, keyword, title, snippet, url });
            }
        }
    }
    return out;
}

/** 解析 Jina 前置筛选模型的 JSON 输出（移植 husouPrefilterJinaFetchTargets 的解析段） */
export function parsePrefilterJson(text, candidates = []) {
    const src = String(text || '').trim();
    const match = src.match(/\{[\s\S]*\}/);
    if (!match) return new Set();
    let parsed;
    try {
        parsed = JSON.parse(match[0]);
    } catch {
        return new Set();
    }
    const approved = Array.isArray(parsed.approved)
        ? parsed.approved
        : Array.isArray(parsed.approved_urls)
          ? parsed.approved_urls
          : Array.isArray(parsed.urls)
            ? parsed.urls
            : [];

    const urls = new Set();
    for (const item of approved) {
        if (typeof item === 'number') {
            const c = candidates[item - 1];
            if (c?.url) urls.add(c.url);
            continue;
        }
        if (typeof item === 'string') {
            const u = normalizeJinaUrl(item);
            if (/^https?:\/\//i.test(u)) urls.add(u);
            continue;
        }
        if (item && typeof item === 'object') {
            if (item.should_fetch === false || item.approved === false) continue;
            const idx = Number(item.index ?? item.id ?? item.no);
            if (Number.isFinite(idx) && idx >= 1 && candidates[idx - 1]?.url) {
                urls.add(candidates[idx - 1].url);
            }
            const u = normalizeJinaUrl(item.url || '');
            if (/^https?:\/\//i.test(u)) urls.add(u);
        }
    }
    return urls;
}

/** 解析知识整理输出（移植 husouFilterResults 的协议解析段） */
export function parseKnowledgeResponse(text, options = {}) {
    const lenient = options.lenient !== false; // 默认宽松：截断的响应也把已完成的条目捞出来
    const src = String(text || '').trim();
    if (!src) return { ok: false, error: 'FILTER_MODEL_EMPTY', entries: new Map() };
    const block = src.match(/#\s*知识库开始\s*\n([\s\S]*?)(?:#\s*知识库结束|$)/i);
    if (!block) return { ok: false, error: 'FILTER_PROTOCOL_MISSING', entries: new Map() };
    const body = block[1].trim();
    const unterminated = !/#\s*知识库结束/i.test(src);
    if (!body || /#\s*无新增/i.test(body)) return { ok: true, entries: new Map(), noNew: true };

    const entries = new Map();
    const re = /#\s*条目开始\s*\n([\s\S]*?)#\s*条目结束/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
        const chunk = m[1].trim();
        const nameMatch = chunk.match(/#\s*名称\s*\n(.+)/i);
        const descMatch = chunk.match(/#\s*说明\s*\n([\s\S]*)/i);
        const name = nameMatch ? nameMatch[1].trim() : '';
        const desc = descMatch ? descMatch[1].trim() : '';
        if (!name || !desc) continue;
        if (/无可用信息|无相关信息|全部无关|完全无关|discard|irrelevant/i.test(desc)) continue;
        entries.set(name, desc);
    }
    // 截断的响应里，已闭合的条目照样能用 —— 能用就别浪费一次重试
    if (!entries.size) {
        if (unterminated && !lenient) return { ok: false, error: 'FILTER_TRUNCATED_NO_ENTRY', entries: new Map() };
        return { ok: false, error: 'FILTER_SECTIONS_EMPTY', entries: new Map() };
    }
    return { ok: true, entries, truncated: unterminated };
}

/* ============================================================================
 * 8. 提示词（逐字提取）
 * ==========================================================================*/

/** 逐字移植 husouBuildFixedContextHeader */
export function buildFixedContextHeader() {
    return {
        role: 'system',
        content: `\n\n（在这里插入）\n\n    ⛔⛔⛔STOP EVERYTHING AND FOLLOW⛔⛔⛔\n      【搜索规则】：\n      你是一个专业的关键词提取大师、网页搜索大师，你需要读取完整的上下文后，按要求执行操作。\n接下来会按固定顺序读取角色卡、玩家设定、场景、世界书、用户偏好与聊天记录。\n\n你必须把这些内容视为完整上下文，用于：\n- 提取真正需要搜索的关键词；\n- 判断搜索结果是否与当前剧情、世界书、角色设定有关；\n- 判断 Jina 是否值得抓取网页全文；\n- 过滤同名但无关的网页。\n\n禁止只看最新用户消息。\n禁止忽略世界书。\n禁止忽略角色卡。\n禁止忽略玩家设定。\n禁止忽略用户偏好。\n\n【上下文开始】`,
    };
}

/** 固定上下文读取顺序说明（移植 ssBuildFixedContextOrderedPrompts 的第一条） */
export function buildContextOrderNote() {
    return {
        role: 'system',
        content: `【固定上下文读取说明】\n接下来会按固定顺序读取角色卡、玩家设定、场景、世界书、用户偏好与聊天记录。\n你必须把这些内容视为完整上下文，不允许只看最新用户输入。`,
    };
}

/** 关键词提取提示词（逐字移植 husouAnalyzeContext 中的字符串 a，变量已参数化） */
export function buildKeywordExtractPrompt({ existing = '', linked = '', smartSkip = true } = {}) {
    return `【上下文结束】\n\n【当前任务：提取需要搜索的关键词】\n\n你是关键词提取大师。\n\n你的任务：\n根据【上下文开始】到【上下文结束】之间的完整内容，结合角色卡、玩家设定、场景、世界书、用户偏好、聊天记录，提取真正需要外部搜索的关键词。\n\n【已有Agent 搜索资料】\n${smartSkip ? existing || '（暂无已搜索内容）' : '（智能跳过已关闭）'}\n\n【跨模块补充参考】\n${linked || '（暂无）'}\n\n【关键词提取规则】\n1. 必须结合完整上下文判断，不允许只看最新用户消息。\n2. 如果上下文出现作品名，先提取作品名本身。\n3. 然后提取“作品名 + 角色名 / 组织名 / 物品名 / 地点名 / 术语名”。\n4. 最后提取“作品名 + 角色名 + 子项目 / 技能 / 装备 / 称号 / 剧情事件”。\n5. 禁止单独搜索没有作品前缀、容易混淆的普通词。\n6. 禁止提取日常普通词、情绪词、动作词、无搜索价值词。\n7. 如果已有Agent 搜索资料已经完整覆盖某关键词，且当前上下文没有新需求，可以跳过。\n8. 如果同名词可能对应多个作品，必须加作品前缀。\n9. 不限制关键词数量，但必须去重。\n10. 关键词要适合搜索引擎直接搜索。\n\n【输出格式】\n必须只输出 JSON 数组。\n禁止 Markdown。\n禁止解释。\n禁止代码块。\n\n示例：\n["原神", "原神 可莉", "原神 西风骑士团", "原神 可莉 蹦蹦炸弹"]\n\n如果没有关键词，输出：\n[]\nhashlib follow the ⋙ request：\nOUTPUT\n`;
}

/** Jina 前置筛选提示词（逐字移植 husouPrefilterJinaFetchTargets 中的字符串 r） */
export function buildJinaPrefilterPrompt(candidates = [], keywords = []) {
    const list = candidates
        .map(
            (c) =>
                `【候选 ${c.index}】\n关键词：${c.keyword || '未知'}\n标题：${c.title || '无标题'}\n摘要：${c.snippet || '无摘要'}\nURL：${c.url}`,
        )
        .join('\n\n');
    return `【上下文结束】\n\n【身份】\n你是Agent 搜索的 Jina 抓取前置筛选器。\n\n你不会抓网页全文。\n你只阅读完整上下文、当前搜索关键词，以及“原始搜索结果候选”的标题、摘要、URL。\n你的任务是判断：哪些候选网页值得继续调用 Jina 抓取全文。\n\n【判断目标】\n只批准真正可能包含有效人物信息、作品设定、世界观信息、角色资料、组织资料、物品资料、剧情资料的网页。\n\n【优先批准】\n1. wiki、wikipedia、萌娘百科、百度百科、fandom、wiki.gg、专门的作品百科、角色资料页。\n2. 标题和摘要明显包含角色身份、经历、性格、能力、剧情、世界观、组织、地点、物品、设定。\n3. 与当前角色卡、世界书、聊天上下文、搜索关键词明显相关。\n4. 虽然不是百科，但摘要显示有足够文字信息，且和当前上下文相关。\n5. 即使和当前角色不相关，但有具体世界观、其他信息的网页，批准，可作为信息、世界观补充\n\n【必须拒绝】\n1. 字典、翻译、词语解释、成语解释、普通汉语释义页面。\n2. 官网首页、下载页、启动器页面、登录页、注册页、商店页、购买页、新闻列表页。\n3. 纯图片、图库、壁纸、头像、表情包、视频、短视频、直播、音乐播放、无正文页面。\n4. 搜索结果页、标签页、目录页、导航页、聚合页。\n5. 摘要为空、只有广告词、只有按钮文字、只有“下载/进入官网/立即体验”等无信息内容。\n6. 和当前世界书、角色卡、聊天上下文明显无关的同名词条。\n7. 抓了也只能得到大量图片、按钮、导航、下载提示的网站。\n\n【特别规则】\n- 如果标题是百科，直接抓取，特别是wiki、百度百科，人物介绍等网页，即使摘要里没有正文，也必须抓取！\n- 如果是官网，但摘要只是宣传、下载、购买、注册，不要抓。\n- 如果是官网里的具体角色资料/设定资料页，批准。\n- 如果不确定，但摘要里已经出现部分人物设定、剧情设定、世界观资料，批准。\n- 如果只是在解释一个普通词语，如字典，不要批准。\n- 尽可能抓有任何关联信息的网页，即使是标题里出现也要抓取，但不要乱抓完全无关的网页。\n\n【本次搜索关键词】\n${normalizeKeywords(keywords).join('、') || '（未知）'}\n\n【原始搜索结果候选】\n${list}\n\n【输出格式】\n必须只输出合法 JSON。\n禁止 Markdown。\n禁止代码块。\n禁止解释。\n\n格式：\n{\n  "approved": [\n    {\n      "index": 1,\n      "url": "https://example.com/xxx",\n      "reason": "批准原因"\n    }\n  ],\n  "rejected": [\n    {\n      "index": 2,\n      "url": "https://example.com/yyy",\n      "reason": "拒绝原因"\n    }\n  ]\n}\n\n如果没有任何值得抓取的网页：\n{\n  "approved": [],\n  "rejected": []\n}`;
}

/** 角色卡维度模板（用户要的：角色模型 / 外貌 / 性格 / 背景 / 身份…） */
export const CHARACTER_SHEET_FIELDS = [
    ['身份', '正式名称、别名/称号、性别、年龄、种族、阵营/组织、身份标签'],
    ['外貌', '身高体型、发型发色、瞳色、服饰、标志性配饰、特殊印记'],
    ['性格', '性格类型、核心特质、矛盾点、情绪倾向'],
    ['能力', '能力/技能、原理、等级、限制与弱点'],
    ['背景', '出身、重要经历、成长轨迹、当前处境'],
    ['人际关系', '家人、挚友、爱慕/敌对对象、对陌生人的态度'],
    ['语言风格', '口癖、语气、常用句式、称呼习惯'],
    ['扮演要点', '日常状态、情绪极端时的表现、互动模板'],
];

/** 角色卡维度模板的行文本，供提示词拼接 */
export function characterSheetLines() {
    return CHARACTER_SHEET_FIELDS.map(([name, hint], i) => `${i + 1}. **${name}**：${hint}`).join('\n');
}

/** 过滤模式的说明文本，插进提示词 */
export function filterModeInstruction(mode, keywords = []) {
    const kwLine = normalizeKeywords(keywords).join('、') || '（本次无关键词）';
    switch (mode) {
        case 'perKeyword':
            return `【本次搜索关键词】\n${kwLine}\n\n【整理模式：按关键词逐条整理】\n本次**只为每个搜索关键词输出一条条目**，条目名必须就是该关键词本身（原样）。\n每个条目内部按下面的「对象维度」整理，能填多少填多少，没有信息的维度写（本次无新增）。\n搜索结果里出现的**其他角色、声优、关联作品、普通概念词**：**不要单独建条目**，只在它们属于该关键词对象的直接信息时（例如"室友""能力来源"）并入该条目正文。\n\n【对象维度】\n${characterSheetLines()}`;
        case 'allEntities':
            return `【本次搜索关键词】\n${kwLine}\n\n【整理模式：全实体知识库（原版原预设行为）】\n搜索结果里出现的任何角色、设定、组织、物品、事件、术语，都要单独建条目整理。`;
        case 'focus':
        default:
            return `【本次搜索关键词】\n${kwLine}\n\n【整理模式：只保留直接相关内容】\n只为**与上述关键词指向同一个对象**的信息建条目（含该对象的别名、称号、明确同指的词条）。\n明确丢弃：\n- 只是"相关作品""其他角色""声优/制作人员""普通概念词/术语解释"的条目；\n- 与关键词同名但明显是另一个对象的条目；\n- 只在搜索结果里顺带出现、与关键词对象没有直接关系的内容。\n每个条目名用**关键词本身或该对象的正式名称**，不要用"相关角色A"这类模糊名字。\n条目内部按下面的「对象维度」整理。\n\n【对象维度】\n${characterSheetLines()}`;
    }
}

/**
 * 本地兜底：把明显跟关键词无关的条目剔掉（模型没听话时的保险）。
 * 相关 = 条目名与某个关键词互为子串，或条目名出现在该关键词的原始结果里且名字长度>=2。
 * 若过滤后为空，则保留原样（宁多勿漏）。
 */
export function filterEntriesByFocus(entries, keywords = [], rawTextByKeyword = {}) {
    if (!entries || !entries.size) return new Map();
    const kws = normalizeKeywords(keywords);
    if (!kws.length) return new Map(entries);
    const keep = new Map();
    const others = new Map();
    for (const [name, content] of entries) {
        const n = String(name || '').trim();
        const direct = kws.some((k) => k && (k.includes(n) || n.includes(k)));
        if (direct) {
            keep.set(name, content);
            continue;
        }
        others.set(name, content);
    }
    if (keep.size) return keep;
    return new Map(entries);
}
/** 知识整理 system 提示词（逐字移植 husouFilterResults 中的字符串 l） */
export function buildFilterSystemPrompt({ rawText = '', keywords = '', existing = '', mode = 'focus', keywordList = [] } = {}) {
    return `\n\n（在这里插入）\n    \n        ⛔⛔⛔STOP EVERYTHING AND FOLLOW⛔⛔⛔\n    你是信息整理大师。以下是通过网页搜索到的原始结果，以及之前已经整理过的知识。请对比两者，只从新结果中提取之前没有的内容，将其极其详细地补充到已有知识中。\n\n【本次新搜索的原始结果】\n${rawText}\n\n【本次搜索关键词】\n${keywords || '当前搜索关键词：（未知）'}\n\n${filterModeInstruction(mode, keywordList)}${mode === 'allEntities' ? '' : '\n\n【模式优先级（高于下方一切规则）】\n下面的「对象类型判断 / A–F 维度」只作为**条目内部的维度参考**；\n在本次模式下，**不得**因为搜索结果里出现了别的角色、声优、作品、术语就为它们另建条目。'}\n\n【之前已整理的知识】\n${existing || '（暂无）'}\n# 角色/世界观/物品信息整理规则\n\n## 第一步：对象类型判断\n根据输入信息，判断需要分析的对象属于以下哪一类（只选一类）：\n- A. 角色（含拟人化角色）\n- B. 世界观（含世界设定、地理、历史、时间线）\n- C. 物品/道具（含武器、神器、特殊物品）\n- D. 组织/势力\n- E. 事件/剧情\n- F. 概念/术语（含力量体系、法则、特殊规则）\n\n如无法判断，默认按“角色”处理。\n\n## 第二步：过滤规则（严格遵守）\n1. 与当前对象类型、所属作品、设定完全无关的信息直接丢弃，不输出。\n2. 如果某个维度信息在“之前已整理的知识”中已经存在且已有详细说明（超过200字的完整描述），不要再重复输出相同内容。只输出：\n   - 之前完全没有出现过的新信息\n   - 之前信息不全面（少于100字或仅有概括）的补充内容\n3. 只输出本次新搜索中发现的、之前没有的新内容，不要复述已有内容。\n4. 如果没有任何新内容，严格只输出四个字：（无可用信息）\n5. 多条来源合并去重，用自己的话概括。\n6. 严格按照下方对应类型的分析维度输出，每个维度都要检查是否已覆盖。如果某维度无新信息，标注“（本次无新增）”，不要直接跳过不写。\n7. 不要解释判断过程，直接输出整理后的信息。\n\n## 第三步：按类型输出维度（必须全部覆盖）\n\n### 【A类：角色】输出以下20个维度\n1. 身份定位（正式名称、别名、称号、性别、生日/年龄、种族/类型、所属阵营/组织、身份标签）\n2. 外貌特征（身高/体型、发型发色、瞳色、肤色、服饰风格、标志性配饰、特殊印记/伤疤）\n3. 性格核心（性格类型、核心特质、性格矛盾点、情绪倾向）\n4. 能力体系（主要能力、战斗风格、特殊技能、能力限制/弱点、能力来源）\n5. 语言风格（音色、语速、口癖/口头禅、常用句式、语气特点）\n6. 人际关系（家庭成员、组织内关系、朋友/盟友、敌对/竞争关系、对陌生人的态度）\n7. 生平经历（出生背景、重要转折事件、成长轨迹、当前状态）\n8. 心理内驱（核心欲望、最大恐惧、核心价值观、信念冲突）\n9. 日常生活（作息规律、饮食偏好、爱好/兴趣、生活习惯怪癖、能力短板）\n10. 标志性行为（战斗行为、社交行为、独处行为、压力下的行为）\n11. 象征物/代表物（随身物品、精神寄托、身份标识）\n12. 他人评价（他人眼中的形象、常见误解）\n13. 情感关系（恋爱/好感对象、亲情羁绊、友情深度、对陌生人的情感模式）\n14. 道德观/行为准则（对待规则的态度、对待弱者的态度、对待敌人的态度、对待秘密的态度）\n15. 知识/智慧水平（受教育程度、常识掌握程度、专业技能、认知盲区）\n16. 幽默/严肃倾向（笑点、严肃话题触发点、是否擅长自嘲）\n17. 审美偏好（喜欢的颜色/图案、艺术品味、厌恶的风格）\n18. 时间观（守时程度、对过去的执念、对未来的规划）\n19. 领导力/团队角色（在团队中的位置、是否合群、对权威的态度）\n20. 扮演要点（日常状态、情绪极端状态、与其他类型角色互动模板、成长弧线提示）\n\n### 【B类：世界观】输出以下15个维度\n1. 世界名称与总体定位（正式名称、类型、核心特色）\n2. 地理/空间构成（主要大陆/区域、地貌特征、特殊地点、空间法则）\n3. 历史时间线（创世/起源、重大历史时期、关键转折事件、当前时代定位）\n4. 力量/法则体系（能量来源、力量类型、力量等级、使用限制）\n5. 种族/物种构成（主要种族及其特征、种族关系、稀有物种）\n6. 政治/权力结构（统治形式、主要势力、权力机关、统治人物）\n7. 经济与资源（货币体系、主要资源、贸易体系、稀缺物品）\n8. 文化与社会（主流价值观、节日庆典、社会阶层、禁忌/习俗）\n9. 科技/魔法水平（技术等级、魔法普及度、特殊技术、技术禁区）\n10. 宗教/信仰体系（主流信仰、神祇体系、宗教组织、信仰冲突）\n11. 气候与自然环境（气候类型、生态特征、自然灾害、特殊自然现象）\n12. 语言与文字（官方语言、古代语言、方言差异、特殊符号系统）\n13. 交通/通讯方式（移动手段、信息传递方式、限制条件）\n14. 主要威胁/冲突（外部威胁、内部矛盾、灾难类型、战争状态）\n15. 世界法则/特殊规则（世界边界、轮回规则、特殊定律、不可违背的铁律）\n\n### 【C类：物品/道具】输出以下12个维度\n1. 物品名称与别名（正式名称、俗称、曾用名、外文名）\n2. 外观特征（尺寸、颜色/材质/形状、标志性特征、持有状态）\n3. 功能/用途（主要功能、次要用途、负面效果、使用条件）\n4. 力量/属性（元素属性/能量类型、能力等级、特殊效果）\n5. 来源/制造者（制造者、制造时间/地点、制造方式、来历传说）\n6. 历史/背景（重要持有者、相关事件、历史地位）\n7. 使用限制（使用条件、副作用、耐久/消耗性、使用门槛）\n8. 象征意义（代表什么、文化含义、情感价值）\n9. 获取方式（掉落/奖励来源、任务关联、稀有度）\n10. 相关角色/势力（使用者、关联者、寻求者）\n11. 物品状态（当前所在、是否完整、是否可修复）\n12. 已知版本/变体（有无不同版本、强化形态、仿制品）\n\n### 【D类：组织/势力】输出以下10个维度\n1. 组织名称与别名（正式名称、简称、绰号）\n2. 定位与性质（类型、成立目的、核心价值观）\n3. 组织结构（层级体系、核心成员组成、内部派系）\n4. 领导层（领导人、决策机制、继任方式）\n5. 成员画像（成员数量、成员来源、成员特征、入会方式）\n6. 势力范围（主要活动区域、控制区域、影响力范围）\n7. 行为方式（行动风格、常用手段、公开/隐蔽程度）\n8. 与其他势力的关系（盟友、敌对、中立、从属）\n9. 历史沿革（创立时间、重要事件、当前状态）\n10. 象征/标识（标志、口号、制服/信物）\n\n### 【E类：事件/剧情】输出以下10个维度\n1. 事件名称（官方名称、民间称呼）\n2. 时间/地点（发生时间、发生位置、持续时间）\n3. 参与方（主要角色/势力、次要参与者、对立/协助方）\n4. 起因（直接导火索、深层背景、诱因）\n5. 经过（关键节点、转折点、高潮）\n6. 结果（最终结局、直接后果、伤亡/损失）\n7. 影响（短期影响、长期影响、对角色/世界观的影响）\n8. 相关信息来源（在哪部作品/章节/任务中出现）\n9. 争议/未解之谜（存疑信息、未解释细节）\n10. 相关象征/纪念（是否被纪念、有无相关物品/节日）\n\n### 【F类：概念/术语】输出以下8个维度\n1. 术语名称（正式名称、俗称、外文名）\n2. 定义（精确定义、核心内涵、外延范围）\n3. 分类/类型（如有多种形式或等级）\n4. 运作机制（原理、过程、条件）\n5. 关联概念（上位概念、下位概念、平行概念）\n6. 历史/起源（何时出现、由谁提出/发现）\n7. 相关角色/事件（谁与此相关、在什么事件中涉及）\n8. 限制/边界（什么不是这个概念、适用范围边界）\n\n## 第四步：输出格式\n- 第一行：对象类型：[A角色/B世界观/C物品……]\n- 然后按顺序输出各维度，格式：**维度名称**：内容\n- 无新增信息的维度写：（本次无新增）\n- 最后不要加总结或解释`;
}

/** 知识整理 user 提示词（逐字移植 husouFilterResults 中的字符串 c） */
export function buildFilterUserPrompt(mode = 'focus') {
    return `请对比新旧内容，只输出本次新增的信息。\n只允许输出以下两种格式之一：\n\n如果有新信息，输出：\n# 知识库开始\n# 条目开始\n# 名称\n角色名\n# 说明\n新增的核心信息...\n# 条目结束\n\n# 条目开始\n# 名称\n角色名\n# 说明\n新增的核心信息...\n# 条目结束\n\n（多内容以此类推，禁止跳过！只要出现角色、设定、未知名词，都必须进行总结！）\n# 知识库结束\n\n如果没有任何新信息，必须严格输出：\n# 知识库开始\n# 无新增\n# 知识库结束\n\n不要解释，不要输出旧内容。`;
}

/** 搜索源连通性自检清单（移植原脚本自检输出口径） */
export const PROVIDER_LABELS = {
    wikipedia: 'Wikipedia（中文）',
    moegirl: '萌娘百科',
    custom: '自定义来源 API',
    jina: 'Jina 全文抓取（r.jina.ai）',
};

/** 关键词提取所需的固定上下文段落顺序（移植 ssBuildFixedContextOrderedPrompts） */
export const CONTEXT_ORDER = [
    'char_description',
    'char_personality',
    'scenario',
    'persona_description',
    'user_preference',
    'world_info_before',
    'world_info_after',
    'chat_history',
];

/* ============================================================================
 * 资料库 = 世界书词条（新模型）
 *
 * 旧模型是"一堆整段文本 block"，排版难看、也没法被酒馆按关键词激活。
 * 新模型：一个词条 = { name, content, keywords[], constant, disabled, ts }
 *   - name      ：词条名（列表上看到的那一行，例如「白井黑子」）
 *   - content   ：点进去看到的详情正文
 *   - keywords  ：激活关键词（世界书 key）
 *   - constant  ：绿灯（常驻注入）
 *   - disabled  ：关灯（不注入）
 * 直接写成酒馆世界书条目，所以世界书界面里也能看/改，酒馆自己会按灯与关键词注入。
 * ==========================================================================*/

/** 一个空词条 */
export function makeEntry(partial = {}) {
    return {
        name: String(partial.name || '').trim(),
        content: String(partial.content || ''),
        keywords: normalizeKeywords(partial.keywords || []),
        constant: !!partial.constant,
        disabled: !!partial.disabled,
        ts: String(partial.ts || ''),
        sources: Array.isArray(partial.sources) ? partial.sources.map((s) => ({ site: String(s?.site || ''), title: String(s?.title || ''), url: String(s?.url || '') })).filter((s) => s.url) : [],
    };
}

/** 词条数组 → 世界书数据 */
export function entriesToWorldData(worldName, entries) {
    const list = (Array.isArray(entries) ? entries : []).map(makeEntry).filter((e) => e.content.trim() || e.name);
    const out = {};
    list.forEach((entry, i) => {
        const uid = i;
        const keys = entry.keywords.length ? entry.keywords : (entry.name ? [entry.name] : []);
        out[uid] = {
            ...deepClone(WORLD_ENTRY_DEFAULTS),
            uid,
            comment: entry.name || `Agent 搜索词条 #${i + 1}`,
            content: entry.content,
            key: keys,
            keysecondary: [],
            constant: entry.constant,
            disable: entry.disabled,
            displayIndex: i,
            addMemo: true,
            extensions: { agent_search: { ts: entry.ts || '', index: i, name: entry.name || '', sources: JSON.parse(JSON.stringify(entry.sources || [])) } },
        };
    });
    return {
        name: worldName,
        entries: out,
        extensions: { agent_search: { kind: 'library', version: 2, savedAt: new Date().toISOString() } },
    };
}

/** 世界书数据 → 词条数组 */
export function worldDataToEntries(worldData) {
    const entries = worldData && typeof worldData === 'object' && worldData.entries && typeof worldData.entries === 'object' ? worldData.entries : {};
    return Object.values(entries)
        .filter((e) => e && (String(e.content || '').trim() || String(e.comment || '').trim()))
        .sort((a, b) => {
            const ai = Number.isFinite(Number(a.displayIndex)) ? Number(a.displayIndex) : Number(a.uid) || 0;
            const bi = Number.isFinite(Number(b.displayIndex)) ? Number(b.displayIndex) : Number(b.uid) || 0;
            return ai - bi;
        })
        .map((e) => makeEntry({
            name: String(e?.extensions?.agent_search?.name || e?.comment || (Array.isArray(e?.key) ? e.key[0] : '') || '').trim(),
            content: String(e.content || ''),
            keywords: Array.isArray(e.key) ? e.key : [],
            constant: !!e.constant,
            disabled: !!e.disable,
            ts: String(e?.extensions?.agent_search?.ts || ''),
            sources: Array.isArray(e?.extensions?.agent_search?.sources) ? e.extensions.agent_search.sources : [],
        }));
}

/**
 * 把搜索得到的知识 map（条目名 → 正文）变成词条：
 * 词条名 = 条目名，激活关键词默认 = 条目名（蓝灯按关键词激活），可另开绿灯。
 */
export function knowledgeMapToEntries(map, options = {}) {
    const { constant = false } = options;
    if (!map || !map.size) return [];
    const today = new Date().toISOString().split('T')[0];
    return [...map].map(([name, content]) =>
        makeEntry({
            name: String(name || '').trim(),
            content: String(content || '').trim(),
            keywords: normalizeKeywords(name),
            constant,
            disabled: false,
            ts: today,
        }),
    );
}

/** 旧数据迁移：把整段文本按「【关于「X」的说明】」拆成词条 */
export function parseEntriesFromBlockText(text) {
    const src = String(text || '');
    const out = [];
    const re = /【关于[「『"]([^」』"]+)[」』"]的说明】\s*([\s\S]*?)(?=\n*【关于[「『"]|$)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const name = String(m[1] || '').trim();
        const content = String(m[2] || '').trim();
        if (name) out.push(makeEntry({ name, content, keywords: normalizeKeywords(name) }));
    }
    if (!out.length && src.trim()) {
        out.push(makeEntry({ name: '旧资料', content: src.trim(), keywords: [] }));
    }
    return out;
}

/** 词条 → 喂给插件注入 / smartSkip 的文本（与世界书自身注入保持同款格式） */
export function entriesToPlainText(entries) {
    const list = (Array.isArray(entries) ? entries : []).map(makeEntry).filter((e) => e.content.trim());
    if (!list.length) return '';
    return list.map((e) => `【关于「${e.name}」的说明】\n${e.content}`).join('\n\n');
}
/**
 * 规划要抓取的网页：先按关键词限量，再套全局上限。
 * 用户预期："一般抓前三个页面就够了"，所以默认全局只抓 3 页（不是每关键词 3 页）。
 */
export function planJinaTargets(candidates, options = {}) {
    const { perKeyword = 3, total = 3, approvedUrls = null } = options;
    const out = [];
    if (!Array.isArray(candidates) || !candidates.length) return out;

    const byKeyword = new Map();
    for (const c of candidates) {
        if (!c?.url) continue;
        if (approvedUrls && !approvedUrls.has(c.url)) continue;
        const list = byKeyword.get(c.keyword) || [];
        if (list.length >= Math.max(0, perKeyword)) continue;
        list.push(c);
        byKeyword.set(c.keyword, list);
    }
    // 轮转取，保证每个关键词都有机会进前 N 页
    let added = true;
    while (added && out.length < Math.max(0, total)) {
        added = false;
        for (const list of byKeyword.values()) {
            if (!list.length) continue;
            if (out.length >= Math.max(0, total)) break;
            out.push(list.shift());
            added = true;
        }
    }
    return out;
}

/** 带并发上限的异步 map（用于并发抓取页面） */
export async function mapLimit(items, limit, fn) {
    const list = Array.isArray(items) ? items : [];
    const max = Math.max(1, Number(limit) || 1);
    const results = new Array(list.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(max, list.length || 1) }, async () => {
        while (cursor < list.length) {
            const index = cursor++;
            try {
                results[index] = await fn(list[index], index);
            } catch (err) {
                results[index] = { __error: err };
            }
        }
    });
    await Promise.all(workers);
    return results;
}
/* ============================================================================
 * 搜索源正文抓取（修「数据太少」）
 *
 * 实测：萌娘百科 `action=query&list=search` 已被禁用（action-notallowed），
 * 但 `action=opensearch`（找标题）与 `prop=extracts`（全文）可用；
 * 维基百科若只取 exintro 就只有前言几句。
 * 所以：先拿标题，再取**正文**，最后按字数截断。
 * ==========================================================================*/

/** 新增默认值（正文抓取深度/字数） */
export const SEARCH_SOURCE_DEFAULTS = {
    sourceTopPages: 2, // 每个源最多取前几个词条的正文
    sourceExtractChars: 4000, // 单个词条正文最多保留多少字
};

/** 清洗维基/萌娘正文：去引用角标、多余空白、页面样板 */
export function cleanProviderText(text, cap = 4000) {
    let t = String(text || '');
    t = t.replace(/\[\d+\]/g, ''); // [1] 引用角标
    t = t.replace(/\[(?:编辑|edit)\]/gi, '');
    t = t.replace(/^\s*来自[^\n]{0,30}的资料\s*$/gm, ''); // 萌娘页首样板
    t = t.replace(/[ \t]+\n/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    t = t.replace(/[ \t]{2,}/g, ' ');
    t = t.trim();
    const limit = Math.max(0, Number(cap) || 0);
    if (limit && t.length > limit) {
        t = `${t.slice(0, limit)}…（正文已截断至 ${limit} 字）`;
    }
    return t;
}

/** 从 opensearch 响应里取候选标题（数组形态：["关键词", [标题...], ...]） */
export function parseOpenSearchTitles(json) {
    const titles = Array.isArray(json) ? json[1] : json?.query?.search?.map((x) => x?.title);
    return Array.isArray(titles) ? [...new Set(titles.map((x) => String(x || '').trim()).filter(Boolean))] : [];
}

/** 从 query.pages 里逐个取标题与正文 */
export function parseExtractPages(json) {
    const pages = json?.query?.pages && typeof json.query.pages === 'object' ? json.query.pages : {};
    return Object.values(pages)
        .filter((p) => p && !p.missing && String(p.extract || '').trim())
        .map((p) => ({ title: String(p.title || ''), extract: String(p.extract || '') }));
}

/* ============================================================================
 * 「交网址给模型读」模式（v1.8）
 *
 * 用户要求：不要插件截断取正文，直接把 萌娘百科 / 维基百科（以及自定义来源搜到的前 3 条）网址交给模型去读，
 * 由模型整理成角色扮演用的人物资料。
 *
 * 实测（2026-02）：r.jina.ai 能读整页 —— 萌娘 ~47KB、维基 ~120KB；
 * 百度百科返回 403（百度安全验证），所以百度只作为「参考链接」列出。
 * ==========================================================================*/

export const MOEGIRL_SITE = '萌娘百科';
export const WIKIPEDIA_SITE = '维基百科';

/** 萌娘百科条目 URL */
export function moegirlUrl(title) {
    return `https://zh.moegirl.org.cn/${encodeURIComponent(String(title || '').replace(/\s+/g, '_'))}`;
}

/** 维基百科条目 URL */
export function wikipediaUrl(title) {
    return `https://zh.wikipedia.org/wiki/${encodeURIComponent(String(title || '').replace(/\s+/g, '_'))}`;
}

/**
 * 组装「交给模型读」的提示词：网址清单 + 已读到的正文。
 * 目标不是知识库，而是**角色扮演用的人物资料**：身份/外貌/性格/能力/背景/人际关系/语言风格/扮演要点。
 */
export function buildReaderPrompt({ keyword, sources = [] } = {}) {
    const kw = String(keyword || '').trim();
    const list = Array.isArray(sources) ? sources : [];
    const urlLines = list
        .map((s) => {
            const state_ = s.text ? `已读取 ${s.text.length} 字` : s.error ? `读取失败（${s.error}）` : '未读取';
            return `- [${s.site || '来源'}] ${s.title ? `${s.title} —— ` : ''}${s.url}（${state_}）`;
        })
        .join('\n');
    const bodyBlocks = list
        .filter((s) => String(s.text || '').trim())
        .map((s) => `\n===== 【${s.site || '来源'}】${s.title || ''} <${s.url}> =====\n${String(s.text).trim()}`)
        .join('\n');

    return {
        system: `你是角色资料整理师，专门为**角色扮演**准备人物资料。\n你会拿到以下资料：\n1) 目标对象在各百科站点的网址（部分站点正文已随提示词附上）；\n2) 已抓取的网页正文（维基百科 / 萌娘百科）。\n\n你的任务：把资料整理成**能直接用于扮演这个角色**的人物档案。\n\n【硬性要求】\n- **不要长篇推理**：直接输出下面的字段，思考尽量短（否则会因输出长度被截断）。\n- 只整理与「${kw}」这**同一个对象**有关的信息；其他角色/作品/声优/无关概念一律不要单独成条。\n- 不要复述网页排版、导航、脚注、参考文献、外部链接。\n- 信息不足的字段写「（资料未提及）」，不要编造；不确定的标注「（存疑）」。\n- 全文用简体中文。\n\n【输出格式】\n只输出下面这些字段，每行一个，格式为「**字段名**：内容」：\n**身份**：\n**外貌**：\n**性格**：\n**能力**：\n**背景**：\n**人际关系**：\n**语言风格**：\n**扮演要点**：\n**激活关键词**：（把能触发这条档案的**所有叫法**都列出来：本名、别名、简称、昵称、外号、日文名/罗马字；用「、」分隔；只列词，不要解释）\n\n【绝对不要输出】\n- 不要「资料来源 / 参考链接 / 网址」这类字段（但**必须**保留上面那行「激活关键词」）；\n- 正文里不要出现任何 URL、站点名单或「见 xxx 页面」的字样 —— 网址只供你自己阅读，不进档案。`,
        user: `【目标对象】${kw}\n\n【资料来源网址】\n${urlLines || '（无）'}\n${bodyBlocks ? `\n【已抓取的正文】${bodyBlocks}` : '\n【已抓取的正文】\n（本次没有取到正文；请仅依据上面的网址与你已知的常识整理，并在正文中标注「（未读取到原文，存疑）」）'}`,
    };
}

/**
 * 从自定义搜索（SearXNG 等）的响应里取出条目列表（不拼文本，只要结构）。
 * reader 模式需要的是**网址**，所以单独抽出来复用。
 */
export function extractCustomResultItems(json, settings) {
    const cfg = settings || {};
    const arr = resolveResultPath(json, cfg.searchApiResultPath || 'results');
    if (!Array.isArray(arr)) return [];
    const titleField = cfg.searchApiTitleField || 'title';
    const snippetField = cfg.searchApiSnippetField || 'content';
    const linkField = cfg.searchApiLinkField || 'url';
    const limit = Number(cfg.readerMaxUrls) || Number(cfg.searchResultsCount) || 10;
    const out = [];
    for (const item of arr) {
        const url = String(item?.[linkField] ?? '').trim();
        if (!/^https?:\/\//i.test(url)) continue;
        out.push({
            title: String(item?.[titleField] ?? '').trim(),
            snippet: String(item?.[snippetField] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
            url,
        });
        if (out.length >= limit) break;
    }
    return out;
}
/* ============================================================================
 * 剥掉模型的思考内容（思考是它自己用的，不该进资料库/世界书）
 *
 * 有些中转站会把 reasoning 混进 chat 的 `content`，或者模型自己在正文里写
 * <thinking>/思考过程/让我们分析… —— 这些一旦写进词条，就会随世界书注入到扮演里，
 * 属于纯污染，所以这里一律剥掉，并且只保留从第一个字段开始的正式内容。
 * ==========================================================================*/

/** 去掉各种思考标签/段落 */
export function stripThinkingBlocks(text) {
    let t = String(text || '');
    // XML 风格的思考标签（英文标签用 \b 防误伤；中文标签没有词边界，不能加 \b）
    const asciiTags = ['think', 'thinking', 'thought', 'thoughts', 'reasoning', 'analysis', 'scratchpad', 'cot', 'reflection', 'plan'];
    const cjkTags = ['思考', '思路', '思维链', '分析过程', '推理过程'];
    for (const [tags, boundary] of [[asciiTags, '\\b'], [cjkTags, '']]) {
        for (const tag of tags) {
            const tail = boundary;
            const close = new RegExp(`<\\s*${tag}${tail}[^>]*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, 'gi');
            t = t.replace(close, '');
            // 只写了开始标签没闭合的：从标签处砍到结尾
            const open = new RegExp(`<\\s*${tag}${tail}[^>]*>[\\s\\S]*$`, 'i');
            t = t.replace(open, '');
        }
    }
    // Markdown 引用式的思考块（部分中转站会这样输出）
    t = t.replace(/^\s*>\s*(?:思考|thinking|reasoning)[\s\S]*?(?=\n\s*\n|$)/gim, '');
    // 纯文字小标题式的思考段落
    t = t.replace(/(?:^|\n)\s*(?:【?(?:思考过程|思维链|推理过程|分析过程|让我们分析|首先,?我们需要)】?[:：]?)[\s\S]*?(?=\n\s*\n|$)/gi, '\n');
    return t.trim();
}

/**
 * 只保留「从第一个字段开始」的正式内容。
 * 输出格式固定为加粗字段名开头的形式（身份/外貌/性格…），
 * 因此第一个字段之前的内容（客套话、思考、复述提示词）一律丢掉。
 */
export function trimToProfileFields(text) {
    const t = String(text || '');
    const m = t.match(/\*\*\s*[\u4e00-\u9fa5A-Za-z]{2,8}\s*\*\*\s*[:：]/);
    if (!m || typeof m.index !== 'number' || m.index <= 0) return t.trim();
    return t.slice(m.index).trim();
}

/**
 * 去掉「资料来源 / 参考链接」这类字段与任何裸网址行。
 * 网址是给模型自己读的，不该被注入到扮演里（用户明确要求）。
 */
export function stripSourceSection(text) {
    let t = String(text || '');
    // 字段式的来源块：**资料来源**：… （一直到下一个字段或结尾）
    t = t.replace(/\n*\*{0,2}\s*(?:资料)?(?:来源|参考来源|参考链接|引用来源|资料来源与链接)\s*\*{0,2}\s*[:：][\s\S]*?(?=\n\s*\*\*[\u4e00-\u9fa5A-Za-z]{2,8}\s*\*\*\s*[:：]|\s*$)/gi, '\n');
    // 列表式的来源块：### 来源 / 【资料来源】 段落
    t = t.replace(/\n*#{0,3}\s*(?:资料)?(?:来源|参考链接)\s*[:：]?\s*\n(?:[-*•\s]*https?:\/\/[^\s]+\s*\n?)+/gi, '\n');
    t = t.replace(/\n*【\s*(?:资料来源|参考链接|来源)\s*】[\s\S]*?(?=\n\n|$)/g, '\n');
    // 任何单独的裸网址行（含 markdown 链接式）
    t = t.replace(/^\s*[-*•\d.、]*\s*(?:🔗\s*)?<?https?:\/\/[^\s>]+\s*>?\s*$/gim, '');
    t = t.replace(/^\s*\[[^\]]{0,40}\]\(https?:\/\/[^)]+\)\s*$/gim, '');
    return t;
}

/** 组合：剥离思考 → 去掉来源/网址 → 截到字段起点 → 收敛空行 */
export function sanitizeProfileOutput(text, cap = 0) {
    let t = stripThinkingBlocks(text);
    t = stripSourceSection(t);
    t = trimToProfileFields(t);
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    const limit = Math.max(0, Number(cap) || 0);
    if (limit && t.length > limit) t = `${t.slice(0, limit)}…（已截断至 ${limit} 字）`;
    return t;
}
/* ============================================================================
 * 候选网址的筛选与排序（别再拿百度/脸书这种读不到或没营养的链接去喂模型）
 * ==========================================================================*/

/** 百科/维基类站点（优先） */
export const TRUSTED_SITE_PATTERNS = [
    /moegirl\.org\.cn/i, /wikipedia\.org/i, /wikia\.com/i, /fandom\.com/i, /wiki\.gg/i,
    /huijiwiki\.com/i, /baike\.baidu\.com/i, /zhihu\.com\/topic/i, /bahamut\.com\.tw/i,
    /pixiv\.jp\/en\/tags/i, /anidb\.net/i, /bangumi\.tv/i, /gamer\.com\.tw/i, /dic\.nico/i,
];

/** 直接排除：读不到正文、或纯社交/搬运，没整理价值 */
export const BLOCKED_SITE_PATTERNS = [
    /baike\.baidu\.com/i, // 反爬 403
    /facebook\.com/i, /fb\.com/i, /twitter\.com/i, /x\.com\//i, /instagram\.com/i,
    /tiktok\.com/i, /douyin\.com/i, /weibo\.com/i, /xiaohongshu\.com/i, /pinterest\./i,
    /youtube\.com/i, /youtu\.be/i, /bilibili\.com\/video/i, /netflix\.com/i,
    /reddit\.com\/r\/[^/]+\/?$/i,
    /google\.com\/search/i, /bing\.com\/search/i, /duckduckgo\.com\/html/i,
    /\/search\?/i, /\/login/i, /\/signin/i, /\/download/i,
    /itunes\.apple\.com/i, /play\.google\.com/i, /steamcommunity\.com/i,
    /apps\.apple\.com/i, /amazon\./i, /taobao\.com/i, /jd\.com/i,
];

export function siteOf(url) {
    try {
        return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
        return '';
    }
}

/**
 * 过滤 + 排序候选网址：
 *  - 去掉被屏蔽的站点（百度/脸书/视频站/搜索结果页…）
 *  - 可信百科站优先（同一个站最多留 perHost 条）
 *  - 返回最多 max 条
 */
export function rankAndFilterUrls(items, options = {}) {
    const { max = 3, perHost = 1 } = options;
    const list = Array.isArray(items) ? items : [];
    const kept = [];
    const hostCount = new Map();

    const isBlocked = (url) => BLOCKED_SITE_PATTERNS.some((re) => re.test(String(url)));
    const score = (url) => (TRUSTED_SITE_PATTERNS.some((re) => re.test(String(url))) ? 0 : 1);

    const sorted = [...list].sort((a, b) => score(a.url) - score(b.url));
    for (const item of sorted) {
        const url = String(item?.url || '').trim();
        if (!/^https?:\/\//i.test(url)) continue;
        if (isBlocked(url)) continue;
        const host = siteOf(url);
        if (!host) continue;
        const used = hostCount.get(host) || 0;
        if (used >= perHost) continue;
        hostCount.set(host, used + 1);
        kept.push({ ...item, host });
        if (kept.length >= Math.max(0, max)) break;
    }
    return kept;
}
/* ============================================================================
 * 激活关键词（世界书的 key 数组）
 *
 * 用户反馈：只留搜索词一个关键词太弱 —— 「后藤一里」这条档案，
 * 后藤独 / 小孤独 / 波奇酱 / 一里 / 后藤同学 都该能触发。
 * 所以：让模型单独输出一行「**激活关键词**」，这一行**从正文里剥掉**、写进世界书 key；
 * 模型漏了的话，再用本地规则从正文里挖别名。
 * ==========================================================================*/

/** 通用清理：去空白、去标点、去括号补充说明 */
function normalizeKeywordToken(raw) {
    return String(raw || '')
        .replace(/[「」『』""'']/g, '')
        .replace(/[（(][^）)]*[）)]/g, '')
        // 括号/冒号前面的才是叫法本身：`后藤独（日语：…）` → `后藤独`
        .split(/[（(【\[\]:：]/)[0]
        .replace(/^[\s\-*•、,，.。:：]+|[\s\-*•、,，.。:：]+$/g, '')
        .trim();
}

/** 合并多组关键词：去重、去空、去掉过长的（>16 字不太可能是叫法）、上限截断 */
export function mergeKeywords(...lists) {
    const out = [];
    const seen = new Set();
    for (const list of lists) {
        const arr = Array.isArray(list) ? list : String(list || '').split(/[、,，;；|/\n]+/g);
        for (const item of arr) {
            const token = normalizeKeywordToken(item);
            if (!token || token.length > 16) continue;
            if (seen.has(token)) continue;
            seen.add(token);
            out.push(token);
            if (out.length >= 16) return out;
        }
    }
    return out;
}

/**
 * 抽出「激活关键词」那一行，并从正文里删掉它（这一行给世界书用，不该出现在正文里）。
 * 兼容 **激活关键词**：a、b / 激活关键词： / 关键词： / 别名： 等写法。
 */
export function extractKeywordLine(text) {
    let t = String(text || '');
    let keywords = [];
    const lineRe = /^[ \t]*\*{0,2}\s*(?:激活关键词|触发关键词|关键词|别名关键词|别名|别称|又称)\s*\*{0,2}\s*[:：][ \t]*(.+)$/gim;
    t = t.replace(lineRe, (_m, group) => {
        const parts = String(group).split(/[、,，;；|\/]/g);
        keywords = mergeKeywords(keywords, parts);
        return '';
    });
    // 「别名：xx；又称：yy」这种嵌在正文句子里的也捞一下（但保留正文）
    const inlineRe = /(?:别名|别称|又称|俗称|通称|昵称|爱称|外号)\s*[:：]?\s*([^\n。；;]{1,40})/g;
    let m;
    while ((m = inlineRe.exec(t)) !== null) {
        keywords = mergeKeywords(keywords, String(m[1]).split(/[、,，;；|\/\s]+/g));
    }
    return { keywords, text: t.replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * 本地兜底：从正文里挖可能的叫法（日文名、罗马字、引号里的昵称等）
 */
export function extractAliasKeywords(keyword, content) {
    const kw = String(keyword || '').trim();
    const text = String(content || '');
    const found = [kw];

    // （日语：後藤ひとり／ごとう ひとり，罗马化：Gotō Hitori）
    const jpRe = /(?:日语|日文|原文)\s*[:：]\s*([^，,。；;）)]+)/g;
    let m;
    while ((m = jpRe.exec(text)) !== null) {
        for (const part of String(m[1]).split(/[／/|]/g)) found.push(part);
    }
    const romajiRe = /罗马化\s*[:：]\s*([A-Za-zĀ-žōū\s.'-]{2,40})/g;
    while ((m = romajiRe.exec(text)) !== null) found.push(m[1]);

    // 简短昵称式别名（括号里 2~6 字，且不是解释性长句）
    const nickRe = /[（(]\s*(?:别名|又称|俗称|昵称|爱称|外号)?\s*([^\s，,。；;）)]{2,6})\s*[）)]/g;
    while ((m = nickRe.exec(text)) !== null) found.push(m[1]);

    // 「别名：小孤独、波奇酱」「又称 小孤独」这类
    const labelRe = /(?:别名|别称|又称|俗称|通称|昵称|爱称|外号|被称为|被人称作)\s*[:：]?\s*([^\n。；;]{1,40})/g;
    while ((m = labelRe.exec(text)) !== null) {
        found.push(...String(m[1]).split(/[、,，;；|\/\s]+/g));
    }

    // 含「称/叫/别名」的句子里，引号内的 2~6 字叫法
    for (const line of text.split('\n')) {
        if (!/(?:称|叫|别名|别称|昵称|俗称|爱称|外号)/.test(line)) continue;
        const quoted = line.match(/[「『"]([^」』"]{2,6})[」』"]/g) || [];
        for (const q of quoted) found.push(q.replace(/[「『"」』"]/g, ''));
    }

    return mergeKeywords(found);
}