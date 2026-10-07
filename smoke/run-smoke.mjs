/**
 * 冒烟测试：把插件放进一个「迷你酒馆」目录结构里，用桩模块 import 真正的 index.js，
 * 验证：模块能加载 → 设置默认值正确 → 真·调用本机 SearXNG 搜索 → 注入 prompt 数组 /
 * 关键词提取 / 知识整理 三条链路都能跑通。
 *
 *   node smoke/run-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // agent-search 源目录
const sandbox = path.join(here, 'mini-tavern');
const extDir = path.join(sandbox, 'public/scripts/extensions/third-party/agent-search');

let passed = 0;
let failed = 0;
const results = [];

function check(name, cond, extra = '') {
    if (cond) {
        passed++;
        results.push(`  ✅ ${name}`);
    } else {
        failed++;
        results.push(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
    }
}

/* ------------------------------------------------------------------
 * 1. 搭建 mini-tavern 目录
 * ----------------------------------------------------------------*/
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(extDir, { recursive: true });
fs.mkdirSync(path.join(sandbox, 'public/scripts/slash-commands'), { recursive: true });

for (const f of ['index.js', 'agent-core.js', 'settings.html', 'style.css', 'manifest.json']) {
    fs.copyFileSync(path.join(root, f), path.join(extDir, f));
}

const writeStub = (rel, body) => fs.writeFileSync(path.join(sandbox, 'public', rel), body, 'utf8');

// —— 桩：public/script.js（注意：酒馆的 script.js 在 public/ 下，extensions.js 在 public/scripts/ 下）
writeStub(
    'script.js',
    `export const eventSource = globalThis.__dshEventSource;
export const event_types = globalThis.__dshEventTypes;
export const saveSettingsDebounced = () => { globalThis.__dshSaveCount = (globalThis.__dshSaveCount || 0) + 1; };
export const getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
export const substituteParams = (s) => String(s || '').replace('{{persona}}', globalThis.__dshPersona || '');

// 模仿真实酒馆：generateRawData 返回原始响应对象，extractMessageFromData 负责取正文
export async function generateRawData(opts) {
    globalThis.__dshGenerateCalls.push(opts);
    if (!globalThis.__dshGenerateQueue.length) {
        // 队列空 → 模拟「推理模型把 max_tokens 花光、正文为空」
        return { choices: [{ message: { content: '', reasoning_content: '想了很久……' }, finish_reason: 'length' }] };
    }
    const next = globalThis.__dshGenerateQueue.shift();
    if (typeof next === 'string') {
        return { choices: [{ message: { content: next }, finish_reason: 'stop' }] };
    }
    return next; // 允许直接塞原始响应对象，用于构造异常场景
}

export function extractMessageFromData(data) {
    return data?.choices?.[0]?.message?.content ?? '';
}

export async function generateRaw(opts) {
    const data = await generateRawData(opts);
    const text = extractMessageFromData(data);
    if (!text) throw new Error('No message generated');
    return text;
}
`,
);

// —— 桩：public/scripts/extensions.js
writeStub(
    'scripts/extensions.js',
    `export const extension_settings = globalThis.__dshExtensionSettings;
export const getContext = () => globalThis.__dshContext;
export async function renderExtensionTemplateAsync() { return globalThis.__dshSettingsHtml; }
`,
);

// —— 桩：public/scripts/world-info.js
writeStub(
    'scripts/world-info.js',
    `export async function getWorldInfoPrompt() {
    return { worldInfoString: globalThis.__dshWorldInfo || '', worldInfoBefore: globalThis.__dshWorldInfo || '', worldInfoAfter: '' };
}
`,
);

// —— 桩：slash-commands
writeStub(
    'scripts/slash-commands/SlashCommandParser.js',
    `export const SlashCommandParser = { addCommandObject(cmd) { globalThis.__dshCommands.push(cmd); } };
`,
);
writeStub('scripts/slash-commands/SlashCommand.js', `export const SlashCommand = { fromProps: (p) => p };\n`);
writeStub(
    'scripts/slash-commands/SlashCommandArgument.js',
    `export const ARGUMENT_TYPE = { STRING: 'string' };
export const SlashCommandArgument = { fromProps: (p) => p };
`,
);

/* ------------------------------------------------------------------
 * 2. 全局环境桩
 * ----------------------------------------------------------------*/
const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
};

function fakeEl() {
    const el = {
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, contains: () => false },
        children: [],
        value: '',
        textContent: '',
        innerHTML: '',
        checked: false,
        files: [],
        addEventListener() {},
        removeEventListener() {},
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        insertAdjacentHTML() {},
        querySelector: () => fakeEl(),
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
        scrollIntoView() {},
        click() {},
        closest: () => null,
        setAttribute() {},
        focus() {},
    };
    return el;
}

globalThis.document = {
    body: fakeEl(),
    documentElement: fakeEl(),
    createElement: () => fakeEl(),
    querySelector: () => null, // 让面板走「未挂载」分支，避免依赖真实 DOM
    querySelectorAll: () => [],
    addEventListener() {},
    getElementById: () => null,
};
globalThis.window = globalThis;
globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };

globalThis.__dshEventSource = { on() {}, emit() {} };
globalThis.__dshEventTypes = {
    GENERATE_AFTER_DATA: 'generate_after_data',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    GENERATION_ENDED: 'generation_ended',
    MESSAGE_SENT: 'message_sent',
    CHARACTER_EDITED: 'character_edited',
};
globalThis.__dshExtensionSettings = {};
globalThis.__dshGenerateQueue = [];
globalThis.__dshGenerateCalls = [];
globalThis.__dshCommands = [];
globalThis.__dshPersona = '{{persona}} 之后的内容被替换';
globalThis.__dshWorldInfo = '【世界书】可莉是蒙德火花骑士';

globalThis.__dshContext = {
    characterId: 0,
    characters: [
        {
            name: '可莉',
            description: '蒙德火花骑士',
            personality: '活泼好动',
            scenario: '风起地',
            mes_example: '',
        },
    ],
    chat: [
        { is_user: true, mes: '你好呀可莉' },
        { is_user: false, name: '可莉', mes: '蹦蹦炸弹！' },
    ],
    name1: 'User',
    name2: '可莉',
    maxContext: 8192,
};

const ready = new Promise((resolve) => {
    globalThis.jQuery = (fn) => {
        Promise.resolve()
            .then(fn)
            .then(resolve)
            .catch((err) => {
                console.error('初始化失败', err);
                resolve();
            });
    };
});

/* ------------------------------------------------------------------
 * 3. 内置桩搜索服务器（不再依赖 Docker / 本机 SearXNG，测试必须可重复）
 * ----------------------------------------------------------------*/
import http from 'node:http';

const stubHits = new Map(); // 关键词 → 命中次数，便于断言
let stubLong = false; // true 时返回超长内容，用于验证输入预算裁剪

const stubServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const keyword = url.searchParams.get('q') || '';
    stubHits.set(keyword, (stubHits.get(keyword) || 0) + 1);
    const body = {
        query: keyword,
        number_of_results: 4,
        results: [
            {
                title: `${keyword} - 第1条`,
                content: stubLong ? `第1条摘要。` + '长正文'.repeat(1200) : `第1条摘要，含人物设定。`,
                url: `https://page1.example/${encodeURIComponent(keyword)}`,
                engine: 'stub',
            },
            {
                title: `${keyword} - 第2条`,
                content: `第2条摘要。`,
                url: `https://page2.example/${encodeURIComponent(keyword)}`,
                engine: 'stub',
            },
            {
                title: `${keyword} - 第3条`,
                content: `第3条摘要。`,
                url: `https://page3.example/${encodeURIComponent(keyword)}`,
                engine: 'stub',
            },
            {
                title: `${keyword} - 萌娘百科`,
                content: `这是关于 ${keyword} 的萌娘摘要。`,
                url: `https://zh.moegirl.org.cn/${encodeURIComponent(keyword)}`,
                engine: 'stub',
            },
            {
                title: `${keyword} - 维基百科`,
                content: `这是关于 ${keyword} 的维基摘要。`,
                url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(keyword)}`,
                engine: 'stub',
            },
        ],
    };
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify(body));
});

await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
const STUB_PORT = stubServer.address().port;
const STUB_SEARCH = `http://127.0.0.1:${STUB_PORT}/search?q={keyword}&format=json&language={language}`;

/* ------------------------------------------------------------------
 * 3.5 内存版「酒馆服务端」：拦 /api/worldinfo/*，用于验证资料库真的写到服务端
 * ----------------------------------------------------------------*/
const fakeServer = {
    worlds: new Map(), // name → data
    calls: [],
    models: [{ id: 'deepseek/deepseek-v4.1-flash' }, { id: 'gpt-4o-mini' }],
};

const fakeResponse = (obj, status = 200) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(obj),
    json: async () => obj,
});

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    fakeServer.calls.push(u);

    if (u.includes('/api/worldinfo/list')) {
        return fakeResponse([...fakeServer.worlds.keys()].map((name) => ({ file_id: name, name })));
    }
    if (u.includes('/api/worldinfo/get')) {
        const body = JSON.parse(options.body || '{}');
        if (!fakeServer.worlds.has(body.name)) return fakeResponse('Not found', 404);
        return fakeResponse(fakeServer.worlds.get(body.name));
    }
    if (u.includes('/api/worldinfo/edit')) {
        const body = JSON.parse(options.body || '{}');
        if (!body?.name || !body?.data?.entries) return fakeResponse('Is not a valid world info file', 400);
        fakeServer.worlds.set(body.name, body.data);
        return fakeResponse({ ok: true });
    }
    if (u.includes('/api/settings/get')) {
        return fakeResponse({ extension_settings: { agent_search: fakeServer.savedFoxSettings || {} } });
    }
    if (/\/models\/?$/.test(u)) {
        return fakeResponse({ object: 'list', data: fakeServer.models });
    }
    return realFetch(url, options);
};

/* ------------------------------------------------------------------
 * 4. 加载插件
 * ----------------------------------------------------------------*/
const pluginUrl = new URL(`file:///${path.join(extDir, 'index.js').replace(/\\/g, '/')}`).href;
await import(pluginUrl);
await ready;

console.log('冒烟测试：🦊Agent 搜索 · 独立版\n');

const api = globalThis.window.foxSearch;
check('模块加载后暴露 window.foxSearch', !!api);

// 版本号与 manifest / ag-core 同源，避免写死版本号导致假失败
const manifestVersion = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
check(
    `版本号与 manifest 一致（${manifestVersion}）`,
    api?.version === manifestVersion && api?.core?.VERSION === manifestVersion,
    `api=${api?.version} core=${api?.core?.VERSION} manifest=${manifestVersion}`,
);
check('注册了 /foxsearch 斜杠命令', globalThis.__dshCommands.some((c) => c.name === 'foxsearch'));

const defaults = api.settings();
check('默认 searchApiUrl 与预设提取值一致', defaults.searchApiUrl === 'http://localhost:8888/search?q={keyword}&format=json&language={language}', defaults.searchApiUrl);
check('默认 enableCustomSearch=true / enableWikipedia=false / enableMoegirl=false',
    defaults.enableCustomSearch === true && defaults.enableWikipedia === false && defaults.enableMoegirl === false);
check('默认注入 head/tail 与玄狐一致',
    defaults.foxSearchHead.includes('【Agent 搜索注入】') && defaults.foxSearchTail.includes('以上内容只是通过搜索得来'),
    defaults.foxSearchTail);

// 真实的 18080 SearXNG 只作为可选附加验证
let searxngUp = false;
try {
    const probe = await fetch('http://localhost:18080/', { signal: AbortSignal.timeout(4000) });
    searxngUp = probe.ok;
} catch { /* 离线：不影响其余用例 */ }

/* ------------------------------------------------------------------
 * 5. 搜索链路（桩服务器：确定性）
 * ----------------------------------------------------------------*/
console.log('【链路 A】自定义来源 API → 桩搜索服务器');
api.patchSettings({
    analysisApi: 'current',
    providerMode: 'api',
    enableCustomSearch: true,
    enableWikipedia: false,
    enableMoegirl: false,
    enableJinaFetch: false,
    aiFilter: false,
    saveToHusouLocal: false,
    saveToPersonality: false,
    searchApiUrl: STUB_SEARCH,
    searchResultsCount: 5,
    searchTimeout: 15000,
});
const ok = await api.search('SillyTavern');
const last = api.lastResult();
check('搜索返回 true', ok === true);
check('拿到结果条目', (last?.filteredMap?.size || 0) >= 1, `size=${last?.filteredMap?.size}`);
check('注入块包含 <SearchResults> 与关键词行',
    !!last?.injectText?.includes('<SearchResults>') && !!last?.injectText?.includes('当前搜索关键词：SillyTavern'),
    String(last?.injectText || '').slice(0, 120));
check('桩服务器确实被请求过', (stubHits.get('SillyTavern') || 0) >= 1, JSON.stringify([...stubHits]));

{

    const sample = [...(last?.filteredMap || new Map()).values()][0] || '';
    check('结果里带 🔗 链接（Jina 候选可用）', sample.includes('🔗 http'));
    check('extractJinaCandidates 能从真实结果里提取 URL', api.core.extractJinaCandidates(last.filteredMap).length >= 1);

    // 注入 prompt 数组
    const promptArray = [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '继续' },
    ];
    const injected = api.inject(promptArray);
    check('inject() 成功注入 prompt 数组', injected === true);
    check('prompt 数组里出现 <SearchResults> 块', promptArray.some((m) => String(m.content).includes('<SearchResults>')));
    check('重复注入不会累积多个块',
        (() => {
            api.inject(promptArray);
            const count = promptArray.map((m) => (String(m.content).match(/<SearchResults>/g) || []).length).reduce((a, b) => a + b, 0);
            return count === 1;
        })());

    const foxExtraArray = [{ role: 'system', content: '预留块：<fox_extra></fox_extra>' }];
    api.inject(foxExtraArray);
    check('优先注入到 <fox_extra> 内部', /<fox_extra>[^<]*<SearchResults>/.test(foxExtraArray[0].content.replace(/\n/g, '')));
}

/* ------------------------------------------------------------------
 * 5. 关键词提取链路（桩模型）
 * --------------------------------------------------------------------------------*/
console.log('\n【链路 B】模型提取关键词 → 搜索');
globalThis.__dshGenerateQueue.push('这是模型回答：\n```json\n["原神", "原神 可莉", "原神", " 原神 可莉 "]\n```');
api.patchSettings({ providerMode: 'api', enableJinaFetch: false, aiFilter: false });
const okB = await api.search('');
const keywordsB = api.lastResult()?.keywords || [];
check('模型输出的关键词被解析并去重', JSON.stringify(keywordsB) === JSON.stringify(['原神', '原神 可莉']), JSON.stringify(keywordsB));
check('关键词提取确实调用了模型', globalThis.__dshGenerateCalls.length >= 1);
check('链路 B 有结果（每个关键词都打了桩服务器）', okB === true && (stubHits.get('原神') || 0) >= 1 && (stubHits.get('原神 可莉') || 0) >= 1,
    JSON.stringify([...stubHits]));

/* ------------------------------------------------------------------
 * 6. 知识整理链路（桩模型 + 协议解析）
 * --------------------------------------------------------------------------------*/
console.log('\n【链路 C】AI 过滤 / 知识整理');
globalThis.__dshGenerateQueue.push(
    '# 知识库开始\n# 条目开始\n# 名称\n可莉\n# 说明\n**身份定位**：蒙德火花骑士，炸弹专家。\n# 条目结束\n# 知识库结束',
);
api.patchSettings({ aiFilter: true, enableJinaFetch: false });
const okC = await api.search('可莉');
const mapC = api.lastResult()?.filteredMap;
check('整理结果按条目名建表', mapC?.has('可莉') === true, JSON.stringify([...(mapC || new Map()).keys()]));
check('整理后的说明进入注入块', String(api.lastResult()?.injectText || '').includes('蒙德火花骑士'));
check('链路 C 端到端成功', okC === true);

/* ------------------------------------------------------------------
 * 7. 自检
 * --------------------------------------------------------------------------------*/
console.log('\n【链路 D】连通性自检');
const checkLines = await api.selfCheck();
check('自检返回多行结果', Array.isArray(checkLines) && checkLines.length >= 3, JSON.stringify(checkLines));

/* ------------------------------------------------------------------
 * 8. 回归：设置面板渲染失败时绝不能插入字面量 "undefined"
 *    （线上真实故障：手机端 ST 的模板渲染抛错 → renderExtensionTemplateAsync 返回 undefined
 *      → insertAdjacentHTML(undefined) → 扩展列表里多出一行 "undefined"）
 * ----------------------------------------------------------------*/
console.log('\n【链路 E】设置面板挂载（渲染失败回归）');

globalThis.location = { href: 'http://localhost:8000/', hostname: 'localhost', origin: 'http://localhost:8000' };

let insertedHtml = '';
const container = fakeEl();
container.insertAdjacentHTML = (_pos, html) => {
    insertedHtml += String(html);
};
const originalQuerySelector = globalThis.document.querySelector;
globalThis.document.querySelector = (sel) => {
    if (sel === '#extensions_settings' || sel === '#extensions_settings2') return container;
    if (sel === '#agent-search-settings') return insertedHtml.includes('id="agent-search-settings"') ? fakeEl() : null;
    return null;
};

const savedFetch = globalThis.fetch;

// E1：模板渲染返回 undefined + HTML 拉不到 → 必须什么都不插，且不得出现 "undefined"globalThis.__dshSettingsHtml = undefined;
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
insertedHtml = '';
const mountedBroken = await api.mountPanel();
check('渲染失败时不插入任何内容', insertedHtml === '', JSON.stringify(insertedHtml.slice(0, 80)));
check('渲染失败时返回 false', mountedBroken === false);
check('绝不会把字面量 undefined 插进 DOM', !insertedHtml.includes('undefined'));

// E2：直连拉取 settings.html 成功 → 面板正常插入
const realSettingsHtml = fs.readFileSync(path.join(root, 'settings.html'), 'utf8');
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => realSettingsHtml });
insertedHtml = '';
const mountedOk = await api.mountPanel();
check('直连拉取时面板成功插入', mountedOk === true && insertedHtml.includes('id="agent-search-settings"'));
check('插入的是真实面板而不是 undefined', insertedHtml.includes('🦊 Agent 搜索') && !insertedHtml.includes('>undefined<'),
    insertedHtml.slice(0, 80));

globalThis.fetch = savedFetch;
globalThis.document.querySelector = originalQuerySelector;

/* ------------------------------------------------------------------
 * 9. 回归：扩展文件夹名 ≠ 仓库名时也必须能找到 settings.html
 *    （线上真实故障：ST 从 GitHub URL 安装 → 文件夹叫 sillytavern-agent-search，
 *      而代码里硬编码 third-party/agent-search → 拉不到 settings.html → undefined 行）
 * ----------------------------------------------------------------*/
console.log('\n【链路 F】换文件夹名安装（GitHub 安装的真实情况）');

const altName = 'sillytavern-agent-search';
const altDir = path.join(sandbox, 'public/scripts/extensions/third-party', altName);
fs.mkdirSync(altDir, { recursive: true });
for (const f of ['index.js', 'agent-core.js', 'settings.html', 'style.css', 'manifest.json']) {
    fs.copyFileSync(path.join(root, f), path.join(altDir, f));
}

let altReady;
const altReadyPromise = new Promise((resolve) => {
    altReady = resolve;
});
globalThis.jQuery = (fn) => {
    Promise.resolve().then(fn).then(altReady).catch(() => altReady());
};

const firstApi = api; // 第一份实例（加载第二份后 window.foxSearch 会被覆盖）
const altUrl = new URL(`file:///${path.join(altDir, 'index.js').replace(/\\/g, '/')}`).href;
await import(altUrl);
await altReadyPromise;

const altApi = globalThis.window.foxSearch;
check('两份实例是不同对象', altApi !== firstApi);
firstApi.patchSettings({ searchApiUrl: 'https://tunnel.example/search?q={keyword}&format=json' });
check('实例 A 改地址后，实例 B 立刻读到新值（共享真源，修「改了地址还是旧值」）',
    altApi.settings().searchApiUrl === 'https://tunnel.example/search?q={keyword}&format=json',
    altApi.settings().searchApiUrl);
altApi.patchSettings({ searchApiUrl: STUB_SEARCH });
check('实例 B 改地址后，实例 A 也读到新值',
    firstApi.settings().searchApiUrl === STUB_SEARCH,
    firstApi.settings().searchApiUrl);
check('重复安装会被检测出来',
    (globalThis.__foxSearchInstances || []).length === 2,
    JSON.stringify(globalThis.__foxSearchInstances));
check('另一份副本加载成功（同名实例被后者覆盖）', !!altApi);
check('settingsUrl 指向实际文件夹', String(altApi.settingsUrl()).includes(`/${altName}/settings.html`), altApi.settingsUrl());
check('extRelPath 推导为 third-party/' + altName, altApi.extRelPath() === `third-party/${altName}`, altApi.extRelPath());

let requestedUrls = [];
let altInserted = '';
const altContainer = fakeEl();
altContainer.insertAdjacentHTML = (_p, html) => {
    altInserted += String(html);
};
const savedQuery = globalThis.document.querySelector;
globalThis.document.querySelector = (sel) => {
    if (sel === '#extensions_settings' || sel === '#extensions_settings2') return altContainer;
    if (sel === '#agent-search-settings') return altInserted.includes('id="agent-search-settings"') ? fakeEl() : null;
    return null;
};
globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return { ok: true, status: 200, text: async () => fs.readFileSync(path.join(root, 'settings.html'), 'utf8') };
};
const altMounted = await altApi.mountPanel();
check('换名安装时面板仍能挂载', altMounted === true && altInserted.includes('id="agent-search-settings"'));
check('请求的是真实文件夹下的 settings.html',
    requestedUrls.some((u) => includes_(u, `/${altName}/settings.html`)),
    requestedUrls.join(' , '));

function includes_(haystack, needle) {
    return String(haystack).includes(needle);
}

globalThis.document.querySelector = savedQuery;
globalThis.fetch = savedFetch;

/* ------------------------------------------------------------------
 * 10. 可选：真机 SearXNG（localhost:18080）附加验证
 * ----------------------------------------------------------------*/
console.log('\n【链路 G】本机 SearXNG 附加验证（可选）');
if (!searxngUp) {
    console.log('  ⏭ 本机 SearXNG (localhost:18080) 未运行，跳过（不影响其余用例）');
} else {
    api.patchSettings({ searchApiUrl: 'http://localhost:18080/search?q={keyword}&format=json&language={language}', aiFilter: false, enableJinaFetch: false });
    const okG = await api.search('SillyTavern');
    const sizeG = api.lastResult()?.filteredMap?.size || 0;
    check('本机 SearXNG 能搜到结果', okG === true && sizeG >= 1, `size=${sizeG}`);
    if (sizeG) {
        const sample = [...api.lastResult().filteredMap.values()][0];
        check('结果里带 🔗 链接（Jina 候选可用）', String(sample).includes('🔗 http'));
    }
}

/* ------------------------------------------------------------------
 * 10.5 速度：全文抓取必须并发、且受全局上限约束（不能再出现 4 分钟）
 * ----------------------------------------------------------------*/
console.log('\n【链路 G2】全文抓取速度约束');
{
    api.patchSettings({ providerMode: 'api', enableJinaFetch: true, enableJinaPrefilter: false, aiFilter: false, jinaMaxUrlsPerKeyword: 3, jinaMaxUrlsTotal: 3, jinaConcurrency: 3 });
    const bigMap = new Map();
    for (let k = 0; k < 5; k++) {
        bigMap.set(`kw${k}`, Array.from({ length: 4 }, (_, i) => `【页${i}】摘要\n🔗 https://example.test/${k}/${i}`).join('\n'));
    }
    const cands = api.core.extractJinaCandidates(bigMap);
    const picked = api.core.planJinaTargets(cands, { perKeyword: 3, total: 3 });
    check('候选很多时也只抓前 3 页', picked.length === 3, `candidates=${cands.length} picked=${picked.length}`);

    let running = 0;
    let peak = 0;
    await api.core.mapLimit([1, 2, 3, 4, 5], 3, async (n) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 15));
        running--;
        return n;
    });
    check('抓取并发度不超过设定值', peak <= 3, `peak=${peak}`);
}

/* ------------------------------------------------------------------
 * 10.55 reader 模式（现在的默认）：自定义来源前 3 个网址 → 交 AI 读并整理
 * ----------------------------------------------------------------*/
console.log('\n【链路 G5】reader 模式：前 3 个网址交给 AI');
{
    const savedFetch5 = globalThis.fetch;
    const readerHits = [];
    globalThis.fetch = async (url, options) => {
        const u = String(url);
        if (u.startsWith('https://r.jina.ai/')) {
            readerHits.push(decodeURIComponent(u.replace('https://r.jina.ai/', '')));
            return {
                ok: true,
                status: 200,
                text: async () =>
                    `Title: 某页\nURL Source: ${u}\nMarkdown Content:\n${'白井黑子是常盘台中学的风纪委员，能力为空间移动。'.repeat(30)}`,
            };
        }
        return savedFetch5(url, options);
    };

    api.patchSettings({
        providerMode: 'reader',
        enableCustomSearch: true,
        enableWikipedia: false,
        enableMoegirl: false,
        searchApiUrl: STUB_SEARCH,
        readerMaxUrls: 3,
        readerMaxChars: 0,
        jinaConcurrency: 3,
    });
    globalThis.__dshGenerateCalls.length = 0;
    globalThis.__dshGenerateQueue.push('**身份**：风纪委员\n**外貌**：双马尾\n**性格**：认真\n**能力**：空间移动\n**背景**：常盘台中学\n**人际关系**：爱慕御坂美琴\n**语言风格**：句尾加「ですの」\n**扮演要点**：风纪委员式认真\n**资料来源**：见上');
    const ok5 = await api.search('白井黑子');
    const last5 = api.lastResult();
    const prompt5 = String(globalThis.__dshGenerateCalls[0]?.prompt || '');

    check('reader 模式搜索成功', ok5 === true, `ok=${ok5}`);
    check('只读了前 3 个网址（桩里有 4+ 条）', readerHits.length <= 3, `读取了 ${readerHits.length} 个：${readerHits.join(' , ')}`);
    check('读取的网址来自自定义搜索源', readerHits.every((u) => u.includes('page')), readerHits.join(' , '));
    check('交给模型的提示词里带上了这些网址', prompt5.includes('page1.example') && prompt5.includes('page2.example'), prompt5.slice(0, 200));
    check('提示词里带上了抓到的正文', prompt5.includes('空间移动'), '正文未进入提示词');
    check('提示词要求按角色卡字段整理', prompt5.includes('**身份**') && prompt5.includes('**扮演要点**'));
    check('结果是按关键词命名的角色档案', last5?.filteredMap?.has('白井黑子') === true, JSON.stringify([...(last5?.filteredMap || new Map()).keys()]));

    globalThis.fetch = savedFetch5;
}

/* ------------------------------------------------------------------
 * 10.58 网址过滤（别再把百度/脸书/视频站交上去）+ reader 截断重试 + 兜底摘录
 * ----------------------------------------------------------------*/
console.log('\n【链路 G6】网址质量与 reader 容错');
{
    // ① 过滤排序：百度/脸书/视频站要掉，百科站优先
    const cands = [
        { site: '自定义来源：百度', url: 'https://baike.baidu.com/item/x' },
        { site: '自定义来源：脸书', url: 'https://www.facebook.com/p' },
        { site: '自定义来源：B站', url: 'https://www.bilibili.com/video/BV1' },
        { site: '自定义来源：魔禁维基', url: 'https://toaru.huijiwiki.com/wiki/x' },
        { site: '维基百科', url: 'https://zh.wikipedia.org/wiki/x' },
    ];
    const picked = api.core.rankAndFilterUrls(cands, { max: 3, perHost: 1 });
    check('百度/脸书/视频站被过滤掉', !picked.some((p) => /baidu|facebook|bilibili/.test(p.url)), JSON.stringify(picked.map((p) => p.url)));
    check('留下的都是百科类站点', picked.every((p) => /huijiwiki|wikipedia|moegirl|fandom/.test(p.url)), JSON.stringify(picked.map((p) => p.url)));

    // ② 中转站无视 max_tokens：两次截断的思考长度一样 → 快速失败并给明确建议
    const savedFetch6 = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const u = String(url);
        if (u.startsWith('https://r.jina.ai/')) {
            return { ok: true, status: 200, text: async () => '白井黑子的资料正文'.repeat(60) };
        }
        return savedFetch6(url, options);
    };
    api.patchSettings({
        providerMode: 'reader', enableCustomSearch: true, enableWikipedia: false, enableMoegirl: false,
        searchApiUrl: STUB_SEARCH, readerMaxUrls: 3, customMaxTokens: 4096, analysisReasoningEffort: '',
    });
    globalThis.__dshGenerateQueue.length = 0;
    globalThis.__dshGenerateCalls.length = 0;
    const truncatedSame = (len) => ({ choices: [{ message: { content: '', reasoning_content: 'x'.repeat(len) }, finish_reason: 'length' }] });
    globalThis.__dshGenerateQueue.push(truncatedSame(6000), truncatedSame(6000), truncatedSame(6000));
    const ok6 = await api.search('白井黑子');
    const last6 = api.lastResult();
    const content6 = String([...(last6?.filteredMap?.values() || [])][0] || '');
    const tryTokens = globalThis.__dshGenerateCalls.map((c) => c.responseLength);
    check('中转站无视 max_tokens 时快速失败（只试 4096→8192 两次）', tryTokens.length === 2, 'tokens=' + JSON.stringify(tryTokens));
    check('第二次确实请求了更大的上限', tryTokens[1] > tryTokens[0], JSON.stringify(tryTokens));
    check('失败也保住了搜索结果（回退原文摘录）', ok6 === true && content6.includes('白井黑子'), `ok=${ok6} len=${content6.length}`);
    check('摘录里明确标注未整理与原因', content6.includes('未整理'), content6.slice(0, 80));

    globalThis.fetch = savedFetch6;
    api.patchSettings({ providerMode: 'api', enableCustomSearch: true, searchApiUrl: STUB_SEARCH });
}

/* ------------------------------------------------------------------
 * 10.6 持久化：关掉搜索源 → 模拟刷新页面 → 不能再自己打开
 *      （用户报的真实问题：关了搜索源，刷新后又变回开启）
 * ----------------------------------------------------------------*/
console.log('\n【链路 G3】设置持久化（关掉 → 刷新）');
{
    // 造一份"玄狐/酒馆 WebSearch 遗留配置"，模拟真实用户的 localStorage
    storage.set('websearch_settings', JSON.stringify({
        enableCustomSearch: true,
        enableJinaFetch: true,
        searchApiUrl: 'http://localhost:8888/search?q={keyword}&format=json&language={language}',
    }));

    // ① 关掉两个源（等价于用户勾选框）
    api.patchSettings({ enableCustomSearch: false, enableMoegirl: false, enableJinaFetch: false });
    check('① 关掉后当前实例是关的',
        api.settings().enableCustomSearch === false && api.settings().enableJinaFetch === false,
        JSON.stringify({ c: api.settings().enableCustomSearch, j: api.settings().enableJinaFetch }));

    // ② 模拟"刷新浏览器"：同一份 extension_settings / localStorage，重新 import 一份插件
    const reloadDir = path.join(sandbox, 'public/scripts/extensions/third-party/agent-search-reload');
    fs.mkdirSync(reloadDir, { recursive: true });
    for (const f of ['index.js', 'agent-core.js']) fs.copyFileSync(path.join(root, f), path.join(reloadDir, f));

    let readyB;
    const readyPromiseB = new Promise((r) => { readyB = r; });
    globalThis.jQuery = (fn) => {
        Promise.resolve().then(fn).then(readyB).catch(() => readyB());
    };
    const reloadUrl = new URL(`file:///${path.join(reloadDir, 'index.js').replace(/\\/g, '/')}`).href;
    await import(reloadUrl);
    await readyPromiseB;

    const apiB = globalThis.window.foxSearch;
    check('② 刷新后 enableCustomSearch 仍然是关的', apiB.settings().enableCustomSearch === false, String(apiB.settings().enableCustomSearch));
    check('② 刷新后 enableJinaFetch 仍然是关的', apiB.settings().enableJinaFetch === false, String(apiB.settings().enableJinaFetch));
    check('② 刷新后遗留配置没有把开关又打开（migrate 只做一次）',
        apiB.settings().enableCustomSearch === false && apiB.settings().enableMoegirl === false);

    // ③ 模拟「服务器上根本没存住」：把共享设置里的开关改回默认（开），
    //    但本地镜像里是关的 → 重载必须采用镜像（这就是用户遇到的"关了刷新又开"）
    globalThis.__dshExtensionSettings['agent_search'] = {
        ...globalThis.__dshExtensionSettings['agent_search'],
        enableCustomSearch: true,
        enableJinaFetch: true,
        __savedAt: 1, // 服务器版本很旧
    };
    const reloadDir2 = path.join(sandbox, 'public/scripts/extensions/third-party/agent-search-reload2');
    fs.mkdirSync(reloadDir2, { recursive: true });
    for (const f of ['index.js', 'agent-core.js']) fs.copyFileSync(path.join(root, f), path.join(reloadDir2, f));
    let readyC;
    const readyPromiseC = new Promise((r) => { readyC = r; });
    globalThis.jQuery = (fn) => {
        Promise.resolve().then(fn).then(readyC).catch(() => readyC());
    };
    await import(new URL(`file:///${path.join(reloadDir2, 'index.js').replace(/\\/g, '/')}`).href);
    await readyPromiseC;
    const apiC = globalThis.window.foxSearch;
    check('③ 服务器丢了设置时，本地镜像把开关救回来（保持关闭）',
        apiC.settings().enableCustomSearch === false && apiC.settings().enableJinaFetch === false,
        JSON.stringify({ c: apiC.settings().enableCustomSearch, j: apiC.settings().enableJinaFetch }));

    // 恢复场地：把搜索源还原，避免影响后面的链路
    api.patchSettings({ providerMode: 'api', enableCustomSearch: true, enableMoegirl: false, enableJinaFetch: false, searchApiUrl: STUB_SEARCH });
    globalThis.jQuery = (fn) => { Promise.resolve().then(fn).then(() => {}).catch(() => {}); };
}

/* ------------------------------------------------------------------
 * 10.7 真实源验证：只开维基+萌娘，搜「白井黑子」必须拿到正文（不是两行摘要）
 *      —— 复现用户的场景：以前萌娘 list=search 被禁 → 数据极少
 * ----------------------------------------------------------------*/
console.log('\n【链路 G4】维基 + 萌娘真实取正文');
{
    api.patchSettings({
        providerMode: 'api',
        enableWikipedia: true,
        enableMoegirl: true,
        enableCustomSearch: false,
        enableJinaFetch: false,
        aiFilter: false,
        searchResultsCount: 5,
        searchTimeout: 15000,
        sourceTopPages: 2,
        sourceExtractChars: 4000,
    });
    const okW = await api.search('白井黑子');
    const lastW = api.lastResult();
    const textLen = [...(lastW?.filteredMap?.values() || [])].join('').length;
    const summary = String(lastW?.summary ? JSON.stringify(lastW.summary) : '');
    check('维基+萌娘搜到了结果', okW === true, `ok=${okW}`);
    check(`正文总量足够（${textLen} 字，应 > 2000）`, textLen > 2000, `len=${textLen}`);
    check('任务明细不再丢失（不是"没有搜索任务明细"）',
        !summarizeLike(lastW?.summary).includes('没有搜索任务明细'),
        summarizeLike(lastW?.summary));
    check('萌娘百科这条源不是 error（走 opensearch + 正文）',
        !/Moegirl[^}]*error/.test(summary),
        summary.slice(0, 300));
    check('结果里能看到萌娘百科的正文', String([...(lastW?.filteredMap?.values() || [])].join('')).includes('萌娘百科'));

    // 还原
    api.patchSettings({ enableWikipedia: false, enableMoegirl: false, enableCustomSearch: true, searchApiUrl: STUB_SEARCH });

    function summarizeLike(sum) {
        if (!sum) return '没有搜索任务明细';
        const failures = (sum.details || []).filter((d) => d.status === 'error');
        return failures.length ? failures.map((d) => `${d.source} error ${JSON.stringify(d.error || {})}`).join(' | ') : '有明细';
    }
}

/* ------------------------------------------------------------------
 * 11. 资料库：必须写到「酒馆服务端」（跨设备共用），而不是只留在本浏览器
 * ----------------------------------------------------------------*/
console.log('\n【链路 H】资料库存到服务端世界书');
api.patchSettings({
    providerMode: 'api',
    saveToHusouLocal: true,
    libraryStorage: 'server',
    libraryWorldName: 'Agent 搜索资料库测试',
    enableJinaFetch: false,
    aiFilter: false,
    searchApiUrl: STUB_SEARCH,
});
fakeServer.calls.length = 0;
const okH = await api.search('原神 可莉');
check('勾选保存后搜索成功', okH === true);
check('调用了 /api/worldinfo/edit（写服务端）', fakeServer.calls.some((u) => u.includes('/api/worldinfo/edit')));
check('服务端确实存下了世界书', fakeServer.worlds.has('Agent 搜索资料库测试'), JSON.stringify([...fakeServer.worlds.keys()]));
const storedWorld = fakeServer.worlds.get('Agent 搜索资料库测试');
if (!storedWorld) { check('资料库链路前置条件（搜索源可用）', false, 'storedWorld 为空，说明前面把搜索源关了'); }
check('世界书里有 1 条内容条目', Object.keys(storedWorld?.entries || {}).length === 1);
{
    const e = Object.values(storedWorld.entries)[0];
    check('词条名写在 comment 上（列表能直接看到）', e.comment === '原神 可莉', String(e.comment));
    check('激活关键词自动填成词条名', JSON.stringify(e.key) === JSON.stringify(['原神 可莉']), JSON.stringify(e.key));
    check('默认蓝灯（constant=false，按关键词激活）', e.constant === false);
    check('不是关灯状态（disable=false）', e.disable === false);
}
// 再搜同一个关键词：应该是「更新词条」而不是又堆一条
const beforeCount = Object.keys(storedWorld.entries).length;
await api.search('原神 可莉');
const afterCount = Object.keys(fakeServer.worlds.get('Agent 搜索资料库测试').entries).length;
check('重复搜索同名对象只更新词条，不再堆叠', afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);
check('资料库缓存现在是词条模型', Array.isArray(api.library().entries) || Array.isArray(api.library().blocks), JSON.stringify(Object.keys(api.library())));
check('默认注入方式交给世界书（插件不重复注入）', (api.settings().libraryInject || 'worldbook') === 'worldbook');
check('条目内容含搜索结果', !!storedWorld && JSON.stringify(storedWorld).includes('原神 可莉'));

await api.reloadLibrary();
const libState = api.library();
check('重载后 source=server', libState.source === 'server', libState.source);
check('重载后读到 1 条', libState.blocks.length === 1, `blocks=${libState.blocks.length}`);

/* ------------------------------------------------------------------
 * 12. 空回复（No message generated）→ 自动诊断 + 逐级裁剪重试
 * ----------------------------------------------------------------*/
console.log('\n【链路 I】分析模型空回复的容错');
api.patchSettings({ providerMode: 'api', aiFilter: true, enableJinaFetch: false, analysisMaxInputChars: 12000, customMaxTokens: 4096 });
globalThis.__dshGenerateCalls.length = 0;
// 第一次：模拟推理模型把输出额度花在思考上（正文空、reasoning 有内容、finish_reason=length）
globalThis.__dshGenerateQueue.push({ choices: [{ message: { content: '', reasoning_content: '很长很长的思考……' }, finish_reason: 'length' }] });
// 第二次（输出上限加倍后）：返回正常知识块
globalThis.__dshGenerateQueue.push('# 知识库开始\n# 条目开始\n# 名称\n可莉\n# 说明\n**身份定位**：蒙德火花骑士（重试成功）。\n# 条目结束\n# 知识库结束');
const okI = await api.search('可莉');
const mapI = api.lastResult()?.filteredMap;
check('输出被截断后自动重试并成功', okI === true && mapI?.has('可莉') === true, `ok=${okI} keys=${JSON.stringify([...(mapI || new Map()).keys()])}`);
check('空回复被记进诊断（含 finish_reason / reasoning 线索）', api.diagnostics().includes('空回复'), api.diagnostics().slice(0, 160));
check('重试方向是「加倍 max_tokens」而不是只裁输入',
    globalThis.__dshGenerateCalls.length >= 2 &&
        globalThis.__dshGenerateCalls[1].responseLength > globalThis.__dshGenerateCalls[0].responseLength,
    `out0=${globalThis.__dshGenerateCalls[0]?.responseLength} out1=${globalThis.__dshGenerateCalls[1]?.responseLength}`);
check('输入并没有被无谓地裁掉',
    globalThis.__dshGenerateCalls[1].prompt.length === globalThis.__dshGenerateCalls[0].prompt.length,
    `len0=${globalThis.__dshGenerateCalls[0]?.prompt?.length} len1=${globalThis.__dshGenerateCalls[1]?.prompt?.length}`);

/* ------------------------------------------------------------------
 * 13. 模型列表自动拉取（不用手打模型名）
 * ----------------------------------------------------------------*/
console.log('\n【链路 J】拉取模型列表');
api.patchSettings({ customApiUrl: 'https://api.example.test/provider/v1', customApiKey: 'test-key' });
const models = await api.fetchModels();
check('拉到模型列表', Array.isArray(models) && models.length === 2, JSON.stringify(models));
check('缓存进设置（下次开面板直接显示）', (api.settings().__modelListCache?.models || []).length === 2);
check('推导出的 /models 地址正确',
    api.core.modelsEndpoint('https://api.example.com/v1/chat/completions') === 'https://api.example.com/v1/models');

/* ------------------------------------------------------------------
 * 14. 跨页面设置同步：从服务器重载设置（用户在电脑改了，手机上不刷新就还是旧值）
 * ----------------------------------------------------------------*/
console.log('\n【链路 K】从服务器重载设置');
fakeServer.savedFoxSettings = {
    ...JSON.parse(JSON.stringify(api.settings())),
    searchApiUrl: 'https://registrar-fleet-entitled-cancel.trycloudflare.com/search?q={keyword}&format=json&language={language}',
    enableCustomSearch: true,
};
const reloaded = await api.reloadSettings();
check('从服务器重载设置成功', reloaded === true);
check('重载后搜索地址变成服务器上的新值',
    String(api.settings().searchApiUrl).includes('trycloudflare.com'),
    api.settings().searchApiUrl);
check('地址实时提示会显示当前生效值', typeof api.testSearchUrl === 'function');

/* ------------------------------------------------------------------
 * 15. 静态一致性：index.js 里绑定的按钮 id 必须在 settings.html 或 index.js 自建 DOM 里存在
 *     （这类 id 写错在运行期只表现为"按钮没反应"，很难查）
 * ----------------------------------------------------------------*/
console.log('\n【链路 L】按钮 id 静态一致性');
const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(root, 'settings.html'), 'utf8');
const boundIds = [...indexSrc.matchAll(/onClick\('(#[\w-]+)'/g)].map((m) => m[1].slice(1));
const missing = boundIds.filter((id) => !settingsSrc.includes(`id="${id}"`) && !indexSrc.includes(`id="${id}"`));
check(`面板按钮 id 全部存在（共 ${boundIds.length} 个）`, missing.length === 0, `缺失：${missing.join(', ')}`);
const boundSels = [...indexSrc.matchAll(/bindInput\('(#[\w-]+)'/g)].map((m) => m[1].slice(1));
const missingInputs = boundSels.filter((id) => !settingsSrc.includes(`id="${id}"`));
check(`bindInput 的控件 id 全部存在（共 ${boundSels.length} 个）`, missingInputs.length === 0, `缺失：${missingInputs.join(', ')}`);

stubServer.close();

console.log(results.join('\n'));
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
