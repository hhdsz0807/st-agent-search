/**
 * 🦊Agent 搜索 · 独立版 (agent-search) — SillyTavern 第三方扩展
 *
 * 从《[主预设] V19.7.3 狐神抚 · 毓忻.json》的原预设脚本里，把「Agent 搜索」子系统完整抽出来，
 * 做成不依赖酒馆助手（Tavern Helper / JS-Slash-Runner）的独立插件。
 *
 * 保留的兼容点：
 *  - 设置字段名与原脚本 husouSettings 一致（见 agent-core.js DEFAULT_SETTINGS）
 *  - 支持一键从 localStorage["websearch_settings"] 导入原预设里已保存的Agent 搜索配置
 *  - 本地资料库沿用原存储键 SPreset_HusouLocal_<charId>
 *  - 注入块沿用 <SearchResults> + 【Agent 搜索注入】head/tail
 *  - 全部 LLM 提示词逐字保留（关键词提取 / Jina 前置筛选 / 知识整理）
 */

// 说明：全部用「命名空间导入 + 特性探测」，这样在旧版/魔改版酒馆（比如手机端）里
// 即使缺少某个导出，也不会让整个扩展加载失败。
import * as stExt from '../../../extensions.js';
import * as stCore from '../../../../script.js';
import * as stWorldInfo from '../../../world-info.js';
import * as stSlashParser from '../../../slash-commands/SlashCommandParser.js';
import * as stSlashCommand from '../../../slash-commands/SlashCommand.js';
import * as stSlashArgs from '../../../slash-commands/SlashCommandArgument.js';
import * as core from './agent-core.js';

const MODULE = 'agent_search'; // extension_settings 里的键
const LOG_PREFIX = '[Agent 搜索]';
const HUSOU_COMPAT_STORAGE_KEY = 'websearch_settings'; // 原脚本 f.HUSOU_STORAGE_KEY
const LOCAL_LIB_PREFIX = 'SPreset_HusouLocal_'; // 原脚本的 per-character 资料库键前缀
const SETTINGS_MIRROR_KEY = 'agent_search_settings_v1'; // 设置本地镜像（服务器保存失败时兜底）
const MIGRATED_FLAG_KEY = 'agent_search_migrated_v1'; // 遗留配置只并入一次

/**
 * 本扩展自己的目录 —— 必须从 import.meta.url 推导。
 * 酒馆从 GitHub URL 安装时，扩展文件夹名 = 仓库名（例如 sillytavern-agent-search），
 * 硬编码 'third-party/agent-search' 会拉不到 settings.html，模板渲染失败后
 * renderExtensionTemplateAsync 返回 undefined，插进 DOM 就会在扩展列表里多出一行 "undefined"。
 */
const EXT_DIR_URL = new URL('./', import.meta.url);
const EXT_SETTINGS_URL = new URL('settings.html', EXT_DIR_URL).href;

/** 取本扩展相对 scripts/extensions/ 的路径，供酒馆模板渲染接口使用 */
function extRelPath() {
    try {
        const p = decodeURIComponent(EXT_DIR_URL.pathname);
        const marker = '/scripts/extensions/';
        const i = p.indexOf(marker);
        if (i >= 0) return p.slice(i + marker.length).replace(/\/+$/, '');
    } catch { /* ignore */ }
    return 'third-party/agent-search';
}

/** extension_settings 的活引用（不支持 Proxy，用函数每次取） */
/* ---------------------------------------------------------------------------
 * 设置持久化兜底：本地镜像
 *
 * 线上真实问题：关掉搜索源 → 刷新 → 又变回开启。
 * 原因是酒馆没把 extension_settings 写回服务器（刷新后读的是旧 settings.json），
 * 于是落回默认值（enableCustomSearch / enableJinaFetch 默认就是开）。
 * 这里在 localStorage 里留一份带时间戳的镜像：只要镜像比服务器上的新，就用镜像。
 * -------------------------------------------------------------------------*/

function readSettingsMirror() {
    try {
        const raw = localStorage.getItem(SETTINGS_MIRROR_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function writeSettingsMirror(settings) {
    try {
        localStorage.setItem(SETTINGS_MIRROR_KEY, JSON.stringify({ ...settings, __savedAt: settings.__savedAt || Date.now() }));
    } catch { /* 忽略隐私模式等 */ }
}

/** 若本地镜像比服务器上的设置新，则采用镜像（并把结果推回服务器） */
function adoptSettingsMirror() {
    const store = extSettings();
    const current = store[MODULE] && typeof store[MODULE] === 'object' ? store[MODULE] : null;
    const mirror = readSettingsMirror();
    if (!mirror) return false;
    const mirrorAt = Number(mirror.__savedAt) || 0;
    const currentAt = Number(current?.__savedAt) || 0;
    if (!mirrorAt || mirrorAt <= currentAt) return false;
    store[MODULE] = core.normalizeSettings({ ...(current || {}), ...mirror });
    state.settings = store[MODULE];
    saveSettings();
    diag('设置:采用本地镜像（比服务器上的新）', { mirrorAt, currentAt });
    console.info(LOG_PREFIX, '设置已从本地镜像恢复（服务器上的版本更旧）');
    return true;
}
/**
 * 接管旧「狐搜」插件的配置与本地数据（同一套引擎改了个名字，别让用户重新配一遍）
 */
function adoptLegacySettings() {
    const store = extSettings();
    try {
        const legacy = store['fox-search'] || store.fox_search;
        if (!store[MODULE] && legacy && typeof legacy === 'object') {
            store[MODULE] = core.normalizeSettings(legacy);
            state.settings = store[MODULE];
            saveSettings();
            diag('设置:已接管旧狐搜配置', { keys: Object.keys(legacy).length });
            console.info(LOG_PREFIX, '已接管原来的狐搜设置');
        }
    } catch { /* ignore */ }
    try {
        const legacyMirror = localStorage.getItem('fox_search_settings_v1');
        if (legacyMirror && !localStorage.getItem(SETTINGS_MIRROR_KEY)) {
            localStorage.setItem(SETTINGS_MIRROR_KEY, legacyMirror);
        }
        const legacyLib = localStorage.getItem(`SPreset_HusouLocal_${encodeURIComponent(getCharId())}`);
        if (legacyLib && !localStorage.getItem(localLibKey())) {
            localStorage.setItem(localLibKey(), legacyLib);
        }
    } catch { /* ignore */ }
}
function extSettings() {
    if (!stExt.extension_settings) {
        // 极端情况下（酒馆没有该导出）自己造一个，至少不崩
        stExt.extension_settings = stExt.extension_settings || {};
    }
    return stExt.extension_settings;
}

/** getContext 兼容：优先 extensions.js，其次全局 SillyTavern */
function ctxGet() {
    try {
        if (typeof stExt.getContext === 'function') return stExt.getContext();
    } catch { /* ignore */ }
    try {
        return globalThis.SillyTavern?.getContext?.() ?? {};
    } catch {
        return {};
    }
}

function saveSettings() {
    try {
        stCore.saveSettingsDebounced?.();
    } catch { /* ignore */ }
}

function bus() {
    return stCore.eventSource || globalThis.SillyTavern?.getContext?.()?.eventSource || null;
}

function eventTypes() {
    return stCore.event_types || globalThis.SillyTavern?.getContext?.()?.eventTypes || {};
}

async function rawGenerate(options) {
    // 优先用 generateRawData：拿到的是原始响应对象，便于自己提取内容并诊断空回复。
    // ST 的 generateRaw() 会先 cleanUpMessage()，内容是空就直接抛 "No message generated"，
    // 把 finish_reason / reasoning_content 这些关键线索全丢掉——线上排障时根本无从下手。
    if (typeof stCore.generateRawData === 'function') return stCore.generateRawData(options);
    if (typeof stCore.generateRaw === 'function') return stCore.generateRaw(options);
    throw makeError('GENERATE_RAW_MISSING', '当前酒馆版本没有 generateRaw/generateRawData，请把「分析模型」改成自定义 OpenAI 兼容 API');
}

/** 从原始响应里取正文；并给出「为什么是空的」的诊断 */
function extractAnalysisText(data) {
    if (typeof data === 'string') return { text: data, info: { shape: 'string' } };

    let text = '';
    try {
        if (typeof stCore.extractMessageFromData === 'function') {
            text = String(stCore.extractMessageFromData(data, null) || '');
        }
    } catch { /* 自己兜底 */ }

    const choice = data?.choices?.[0];
    const message = choice?.message || choice?.delta || {};
    if (!text) {
        text = String(
            message.content ??
                data?.content?.[0]?.text ??
                data?.completion ??
                data?.response ??
                '',
        );
    }

    const reasoning = String(message.reasoning_content ?? message.reasoning ?? choice?.reasoning_content ?? '');
    const info = {
        shape: Array.isArray(data?.choices) ? 'chat' : typeof data,
        finishReason: choice?.finish_reason || data?.finish_reason || '',
        contentLength: text.trim().length,
        reasoningLength: reasoning.length,
        topKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
    };
    if (!text.trim() && reasoning.trim()) {
        info.hint = '模型只输出了思考内容（reasoning），正文为空：多为 max_tokens 被思考吃光，或该中转站不返回 reasoning 之外的字段';
    }
    return { text: text.trim(), info };
}

function describeEmptyAnalysis(info) {
    const bits = [];
    if (info.finishReason) bits.push(`finish_reason=${info.finishReason}`);
    bits.push(`正文 ${info.contentLength} 字符`);
    if (info.reasoningLength) bits.push(`思考 ${info.reasoningLength} 字符`);
    if (info.topKeys?.length) bits.push(`响应字段=${info.topKeys.join('/')}`);
    if (info.finishReason === 'length') bits.push('（输出被 max_tokens 截断，推理模型尤其常见）');
    return bits.join('，');
}

function substitute(text) {
    try {
        if (typeof stCore.substituteParams === 'function') return stCore.substituteParams(text);
    } catch { /* ignore */ }
    return String(text || '');
}

async function worldInfoPrompt(chat, maxContext, dryRun) {
    if (typeof stWorldInfo.getWorldInfoPrompt !== 'function') return null;
    return stWorldInfo.getWorldInfoPrompt(chat, maxContext, dryRun);
}

/**
 * 取设置面板 HTML。
 * 不再走 ST 的 Handlebars/DOMPurify 渲染（渲染失败会返回 undefined，插进 DOM 就是一行字面量
 * "undefined"，手机端旧构建尤其容易踩），直接取自己的静态文件。
 */
async function loadPanelHtml() {
    try {
        const res = await fetch(EXT_SETTINGS_URL, { cache: 'no-cache' });
        if (res.ok) return await res.text();
        console.warn(LOG_PREFIX, `settings.html 拉取失败：HTTP ${res.status}（${EXT_SETTINGS_URL}）`);
    } catch (err) {
        console.warn(LOG_PREFIX, 'settings.html 拉取异常', err);
    }
    // 兜底：再试一次酒馆自己的模板渲染（老版本路径，路径按实际文件夹名推导）
    try {
        if (typeof stExt.renderExtensionTemplateAsync === 'function') {
            const html = await stExt.renderExtensionTemplateAsync(extRelPath(), 'settings');
            if (typeof html === 'string' && html.trim()) return html;
        }
    } catch (err) {
        console.warn(LOG_PREFIX, '模板回落渲染失败', err);
    }
    return '';
}

/** 运行期状态 */
const state = {
    settings: null,
    running: false,
    abortController: null,
    internalCall: false, // 我们自己调模型时，跳过注入钩子，避免递归
    lastResult: null, // { filteredMap, rawMap, summary, keywords, injectText }
    pendingInject: '', // 等待注入的完整 <SearchResults> 块
    pendingKeywords: [],
    sendCount: 0,
    diagnostics: [],
    lastSources: null, // 上次搜索每个关键词的来源网址（只存进词条元数据）
    lastKeywordsByKw: null, // 每个关键词的激活关键词列表（写进世界书 key）
    searchTiming: null, // 各阶段耗时（排查"为什么这么慢"）
};

/* ============================================================================
 * 设置读写
 * ==========================================================================*/

/**
 * 设置的唯一真源永远是 extension_settings['agent-search']。
 *
 * 这里曾经返回一份私有缓存对象，导致「装了两份扩展」时：
 * 在 A 的面板里改地址 → 写进共享对象；B 仍拿着自己的旧副本 → B 的自检永远显示旧地址。
 * 现在每次都从共享对象重新归一化，任何实例改完，其它实例立刻看到。
 */
function getSettings() {
    const store = extSettings();
    const target = store[MODULE] && typeof store[MODULE] === 'object' ? store[MODULE] : {};
    const normalized = core.normalizeSettings(target);
    // 原地更新，保持同一个对象引用：任何持有旧引用的代码（包括另一个实例）都不会丢改动
    for (const key of Object.keys(target)) {
        if (!(key in normalized)) delete target[key];
    }
    Object.assign(target, normalized);
    store[MODULE] = target;
    state.settings = target;
    return target;
}

function persistSettings() {
    const store = extSettings();
    store[MODULE] = core.normalizeSettings(store[MODULE]);
    store[MODULE].__savedAt = Date.now();
    state.settings = store[MODULE];
    writeSettingsMirror(store[MODULE]); // 本地留一份：服务器保存失败也不会丢开关
    saveSettings();
}

/* ============================================================================
 * 小工具
 * ==========================================================================*/

function log(...args) {
    if (getSettings().debugLog) console.log(LOG_PREFIX, ...args);
}

function toast(message, type = 'info') {
    try {
        if (typeof toastr !== 'undefined') {
            const fn = type === 'error' ? toastr.error : type === 'warning' ? toastr.warning : type === 'success' ? toastr.success : toastr.info;
            fn(message, '🦊Agent 搜索', { timeOut: type === 'error' ? 8000 : 4000, extendedTimeOut: 2000 });
            return;
        }
    } catch { /* ignore */ }
    console.log(LOG_PREFIX, message);
}

function makeError(code, message, detail = {}) {
    const err = new Error(message);
    err.code = code;
    err.detail = detail;
    return err;
}

function errorInfo(err) {
    return { name: err?.name, message: err?.message, code: err?.code, detail: err?.detail };
}

function diag(title, payload = {}, level = 'log') {
    const entry = { ts: new Date().toISOString(), title, payload };
    state.diagnostics.push(entry);
    if (state.diagnostics.length > 400) state.diagnostics.shift();
    if (level === 'error') console.error(LOG_PREFIX, title, payload);
    else if (getSettings().debugLog) console.log(LOG_PREFIX, title, payload);
}

function formatDiag() {
    return state.diagnostics
        .slice(-120)
        .map((e) => `[${e.ts.slice(11, 19)}] ${e.title} ${Object.keys(e.payload).length ? JSON.stringify(e.payload).slice(0, 400) : ''}`)
        .join('\n');
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getCharId() {
    try {
        return ctxGet()?.characterId ?? 'nochar';
    } catch {
        return 'nochar';
    }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const outer = options.signal;
    if (outer) {
        if (outer.aborted) {
            clearTimeout(timer);
            throw new DOMException('Aborted', 'AbortError');
        }
        outer.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (timedOut) throw makeError('FETCH_TIMEOUT', `网络请求超过 ${timeoutMs}ms`, { url: core.safeUrl(url) });
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/* ============================================================================
 * 上下文收集（移植 ssBuildFixedContextOrderedPrompts 的顺序）
 * ==========================================================================*/

function buildContextSections() {
    const settings = getSettings();
    const ctx = ctxGet();
    const chid = ctx?.characterId;
    const character = ctx?.characters?.[chid];
    const sections = [];

    const push = (label, text) => {
        const filtered = core.applyTagFilter(text, settings).trim();
        if (filtered) sections.push(`【${label}】\n${filtered}`);
    };

    push('角色卡·描述', character?.description || '');
    push('角色卡·性格', character?.personality || '');
    push('场景', character?.scenario || '');
    try {
        push('玩家设定', substitute('{{persona}}'));
    } catch { /* ignore */ }

    const pref = String(settings.userPreferenceText || '').trim();
    if (pref) push('用户偏好', pref);

    const floors = Math.max(0, Number(settings.contextFloors) || 0);
    const chat = ctx?.chat || [];
    if (floors > 0 && chat.length) {
        const recent = chat.slice(-floors);
        const lines = recent
            .map((m) => {
                const name = m?.is_user ? ctx?.name1 || 'User' : m?.name || ctx?.name2 || 'Char';
                return `${name}：${String(m?.mes || '').trim()}`;
            })
            .filter((l) => l.length > 3)
            .join('\n\n');
        push('聊天记录', lines);
    }

    return sections;
}

/** 世界书是异步的，单独补两段（顺序与原预设 world_info_before / world_info_after 一致） */
async function buildContextSectionsAsync() {
    const settings = getSettings();
    const ctx = ctxGet();
    let wiBefore = '';
    let wiAfter = '';
    try {
        const chat = ctx?.chat || [];
        const maxContext = ctx?.maxContext || 8192;
        const result = await worldInfoPrompt(chat, maxContext, true);
        wiBefore = result?.worldInfoBefore || '';
        wiAfter = result?.worldInfoAfter || '';
    } catch (err) {
        diag('上下文:世界书扫描失败', { error: errorInfo(err) }, 'warn');
    }

    const base = buildContextSections();
    const filtered = (label, text) => {
        const f = core.applyTagFilter(text, settings).trim();
        return f ? `【${label}】\n${f}` : '';
    };
    const extra = [filtered('世界书·前置', wiBefore), filtered('世界书·后置', wiAfter)].filter(Boolean);
    return [...base, ...extra];
}

/** 组装成发给分析模型的一整段文本 */
async function buildAnalysisPrompt() {
    const settings = getSettings();
    const sections = await buildContextSectionsAsync();
    const header = core.buildFixedContextHeader().content;
    const note = core.buildContextOrderNote().content;
    const task = core.buildKeywordExtractPrompt({
        existing: settings.smartSkip ? loadLocalText() : '',
        linked: '',
        smartSkip: settings.smartSkip,
    });
    const full = [header, note, ...sections, '【上下文结束】', task].join('\n\n');
    diag('上下文:构建完成', {
        sectionCount: sections.length,
        totalLength: full.length,
        floors: settings.contextFloors,
    });
    return full;
}

/* ============================================================================
 * 模型调用（分析模型：当前连接 或 自定义 OpenAI 兼容 API）
 * ==========================================================================*/

function buildCustomApiBody(settings, system, user, maxTokensOverride) {
    const body = {
        model: settings.customModel || undefined,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        max_tokens: Math.max(512, Number(maxTokensOverride) || Number(settings.customMaxTokens) || 8192),
        temperature: Number(settings.customTemperature ?? 1),
        frequency_penalty: Number(settings.customFrequencyPenalty || 0),
        presence_penalty: Number(settings.customPresencePenalty || 0),
        top_p: Number(settings.customTopP ?? 1),
    };
    if (Number(settings.customTopK) > 0) body.top_k = Number(settings.customTopK);
    // 推理模型的关键开关：让它可以"少思考"，否则思维链会吃掉 max_tokens、正文为空
    const effort = String(settings.analysisReasoningEffort || '').trim();
    if (effort) body.reasoning_effort = effort;
    return body;
}

async function callCustomApi(system, user, signal, maxTokens) {
    const settings = getSettings();
    const url = String(settings.customApiUrl || '').trim();
    if (!url) throw makeError('CUSTOM_API_URL_EMPTY', '分析模型选择了「自定义 API」，但地址为空');
    const headers = { 'Content-Type': 'application/json' };
    const key = String(settings.customApiKey || '').trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildCustomApiBody(settings, system, user, maxTokens)),
        signal,
    }, Math.max(30000, Number(settings.searchTimeout) * 3));
    const text = await res.text();
    if (!res.ok) throw makeError('CUSTOM_API_HTTP_ERROR', `分析模型 HTTP ${res.status}`, { preview: text.slice(0, 300) });
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw makeError('CUSTOM_API_JSON_INVALID', '分析模型响应不是合法 JSON', { preview: text.slice(0, 300) });
    }
    const content = json?.choices?.[0]?.message?.content ?? json?.content?.[0]?.text ?? json?.response ?? '';
    return String(content || '');
}

/**
 * 通用分析调用：遇到「输出被 max_tokens 掐断」时，**自动把上限翻倍并记住**再重试。
 *
 * 背景：推理模型会把输出额度全花在思维链上（实测思考 6150 字符、正文 0 字符），
 * 旧实现只有过滤/关键词两条路径做了加倍重试，reader 路径直接失败。
 * 这里统一处理，并且把提高后的值写回设置 —— 下次不用再失败一次。
 */
async function callAnalysisRobust(system, user, signal, options = {}) {
    const label = options.label || '分析模型';
    const cap = Math.max(8192, Number(options.maxOutputCap) || 32768);
    let maxTokens = Math.max(1024, Number(getSettings().customMaxTokens) || 16384);
    let lastReasoning = 0;
    let prevMaxTokens = maxTokens;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await callAnalysisModel(system, user, signal, { maxTokens });
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            const truncated = core.isOutputTruncated(err);
            const info = err?.detail?.info || err?.info || {};
            diag('分析调用失败', {
                label,
                attempt,
                maxTokens,
                truncated,
                reasoningLength: info.reasoningLength,
                finishReason: info.finishReason,
                error: errorInfo(err),
            }, 'error');
            if (!truncated) throw err;

            // 上限涨了、思考长度却几乎没变 → 中转站根本没按我们请求的 max_tokens 走，
            // 再翻倍只是白等，直接给出可执行建议。
            if (lastReasoning && info.reasoningLength && Math.abs(info.reasoningLength - lastReasoning) < 20) {
                throw makeError(
                    'ANALYSIS_MAX_TOKENS_IGNORED',
                    `模型把输出额度全用在思考上（思考 ${info.reasoningLength} 字符、正文 0 字符），` +
                        `而且把上限从 ${prevMaxTokens} 提到 ${maxTokens} 后思考长度几乎没变 —— 该中转站没有按请求的 max_tokens 走。` +
                        `请改用非推理模型做整理，或把「推理强度 reasoning_effort」设为 none/low。`,
                    { info },
                );
            }
            if (maxTokens >= cap) throw err;
            lastReasoning = info.reasoningLength || lastReasoning;
            prevMaxTokens = maxTokens;

            maxTokens = Math.min(cap, maxTokens * 2);
            // 记住新上限，避免下次又白失败一轮
            const store = extSettings();
            store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), customMaxTokens: maxTokens });
            store[MODULE].__savedAt = Date.now();
            state.settings = store[MODULE];
            writeSettingsMirror(store[MODULE]);
            saveSettings();
            toast(`🦊 模型把输出额度花在思考上（finish_reason=length），已把 max_tokens 提到 ${maxTokens} 并重试（已记住）`, 'info');
        }
    }
    throw makeError('ANALYSIS_RETRY_EXHAUSTED', `${label}：重试后仍然没有正文`);
}
async function callAnalysisModel(system, user, signal, options = {}) {
    const settings = getSettings();
    const maxTokens = Math.max(512, Number(options.maxTokens) || Number(settings.customMaxTokens) || 8192);
    state.internalCall = true;
    try {
        if (settings.analysisApi === 'custom') {
            return await callCustomApi(system, user, signal, maxTokens);
        }
        // 走酒馆当前连接（静默生成，不写入聊天记录）
        const prompt = system ? `${system}\n\n${user}` : user;
        const data = await rawGenerate({
            prompt,
            systemPrompt: '',
            responseLength: maxTokens,
        });
        const { text, info } = extractAnalysisText(data);
        if (!text) {
            diag('分析模型:空回复', { info, rawPreview: JSON.stringify(data).slice(0, 600) }, 'error');
            throw makeError('ANALYSIS_EMPTY_RESPONSE', `模型返回空内容：${describeEmptyAnalysis(info)}`, { info });
        }
        diag('分析模型:返回', { info, outputLength: text.length });
        return text;
    } finally {
        state.internalCall = false;
    }
}

/* ============================================================================
 * 搜索源
 * ==========================================================================*/

function classifyOutcome(lines) {
    return lines && lines.length ? 'success' : 'empty';
}

/** 数据源：中文维基（逐字移植 husouSearchWiki 的请求链） */
/** 数据源：中文维基（取**正文**，不只是前言） */
async function searchWikipedia(keyword, signal) {
    const settings = getSettings();
    const limit = Number(settings.searchResultsCount) || 10;
    const top = Math.max(1, Number(settings.sourceTopPages) || 2);
    const cap = Number(settings.sourceExtractChars) || 4000;

    // ① 找条目（维基的 list=search 可用）
    const res = await fetchWithTimeout(
        `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keyword)}&format=json&origin=*&srlimit=${limit}`,
        { signal },
        Number(settings.searchTimeout),
    );
    if (!res.ok) throw makeError('WIKI_SEARCH_HTTP_ERROR', `Wikipedia 搜索 HTTP ${res.status}`, { keyword });
    const json = await res.json();
    const hits = json?.query?.search || [];
    if (!hits.length) return { lines: [], outcome: 'empty' };

    // ② 取前 N 条正文（explaintext 全文，不再用 exintro）
    const pageIds = hits.slice(0, top).map((h) => h.pageid).filter(Boolean);
    if (!pageIds.length) return { lines: [], outcome: 'empty' };
    const extractRes = await fetchWithTimeout(
        `https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&pageids=${pageIds.join('|')}&format=json&origin=*`,
        { signal },
        Math.max(Number(settings.searchTimeout), 15000),
    );
    if (!extractRes.ok) throw makeError('WIKI_EXTRACT_HTTP_ERROR', `Wikipedia 摘要 HTTP ${extractRes.status}`, { keyword });
    const extracts = await extractRes.json();

    const lines = [];
    for (const page of core.parseExtractPages(extracts)) {
        const body = core.cleanProviderText(page.extract, cap);
        if (!body) continue;
        const link = `https://zh.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/\s+/g, '_'))}`;
        lines.push(`【${page.title}】${body}\n🔗 ${link}`);
    }
    diag('搜索源:Wikipedia:完成', { keyword, hits: hits.length, pages: lines.length, chars: lines.join('').length });
    return { lines, outcome: classifyOutcome(lines) };
}

/** 数据源：萌娘百科
 *  注意：萌娘的 `action=query&list=search` 已禁用（action-notallowed），
 *  必须走 `action=opensearch` 找标题 + `prop=extracts` 取正文。 */
async function searchMoegirl(keyword, signal) {
    const settings = getSettings();
    const top = Math.max(1, Number(settings.sourceTopPages) || 2);
    const cap = Number(settings.sourceExtractChars) || 4000;

    const searchRes = await fetchWithTimeout(
        `https://zh.moegirl.org.cn/api.php?action=opensearch&search=${encodeURIComponent(keyword)}&limit=5&format=json&origin=*`,
        { signal },
        Number(settings.searchTimeout),
    );
    if (!searchRes.ok) throw makeError('MOEGIRL_HTTP_ERROR', `萌娘百科搜索 HTTP ${searchRes.status}`, { keyword });
    const titles = core.parseOpenSearchTitles(await searchRes.json()).slice(0, top);
    if (!titles.length) {
        diag('搜索源:Moegirl:无可匹配标题', { keyword }, 'warn');
        return { lines: [], outcome: 'empty' };
    }

    const extractRes = await fetchWithTimeout(
        `https://zh.moegirl.org.cn/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(titles.join('|'))}&format=json&origin=*&redirects=1`,
        { signal },
        Math.max(Number(settings.searchTimeout), 15000),
    );
    if (!extractRes.ok) throw makeError('MOEGIRL_EXTRACT_HTTP_ERROR', `萌娘正文 HTTP ${extractRes.status}`, { keyword });
    const pages = core.parseExtractPages(await extractRes.json());
    const lines = pages.map((page) => {
        const body = core.cleanProviderText(page.extract, cap);
        if (!body) return '';
        const link = `https://zh.moegirl.org.cn/${encodeURIComponent(String(page.title).replace(/\s+/g, '_'))}`;
        return `【萌娘百科：${page.title}】${body}\n🔗 ${link}`;
    }).filter(Boolean);

    diag('搜索源:Moegirl:完成', { keyword, titles, pages: lines.length, chars: lines.join('').length });
    return { lines, outcome: classifyOutcome(lines) };
}
/** 搜索源请求：网络级瞬时失败（fetch failed / ECONNRESET）自动重试一次 */
async function fetchSearchOnce(req, settings, signal) {
    const attempt = () =>
        fetchWithTimeout(
            req.url,
            { method: req.method, headers: req.headers, body: req.body ?? undefined, signal },
            Number(settings.searchTimeout),
        );
    try {
        return await attempt();
    } catch (err) {
        const transient = err?.name === 'TypeError' || /fetch failed|ECONNRESET|socket hang up|network/i.test(String(err?.message || ''));
        if (err?.name === 'AbortError' || !transient) throw err;
        diag('搜索源:瞬时网络错误，重试一次', { url: core.safeUrl(req.url), error: errorInfo(err) }, 'warn');
        await new Promise((r) => setTimeout(r, 400));
        return await attempt();
    }
}
async function searchCustom(keyword, signal) {
    const settings = getSettings();
    const req = core.buildCustomRequest(keyword, settings);
    const res = await fetchSearchOnce(req, settings, signal);
    const text = await res.text();
    if (!res.ok) {
        throw makeError('CUSTOM_HTTP_ERROR', `自定义搜索 HTTP ${res.status} ${res.statusText || ''}`.trim(), {
            url: core.safeUrl(req.url),
            preview: text.slice(0, 300),
        });
    }
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw makeError('CUSTOM_JSON_INVALID', '自定义搜索响应不是合法 JSON', {
            contentType: res.headers.get('content-type') || '',
            preview: text.slice(0, 300),
        });
    }
    const mapped = core.mapCustomResults(json, settings);
    if (mapped.error) {
        throw makeError(mapped.errorCode || 'CUSTOM_RESULT_PATH_INVALID', mapped.error, {
            path: settings.searchApiResultPath,
        });
    }
    if (mapped.rawCount && !mapped.lines.length) {
        throw makeError('CUSTOM_FIELDS_EMPTY', '结果数组不为空，但标题/摘要字段映射后全部为空', {
            titleField: settings.searchApiTitleField,
            snippetField: settings.searchApiSnippetField,
            linkField: settings.searchApiLinkField,
        });
    }
    return { lines: mapped.lines, outcome: classifyOutcome(mapped.lines) };
}

/* ============================================================================
 * 「交网址给模型读」流程（providerMode = reader）
 *
 * 1) 各来源各自找出条目网址（自定义来源取前 N 条；维基/萌娘取对应条目）
 * 2) 用阅读器（r.jina.ai）把整页正文抓下来（萌娘/维基实测可读）
 * 3) 把「网址清单 + 正文」交给模型，整理成角色扮演用的人物档案
 * ==========================================================================*/

/** 收集三个百科站的条目网址 */
async function collectSourceUrls(keyword, signal) {
    const settings = getSettings();
    const perSite = Math.max(1, Number(settings.readerPagesPerSource) || 2);
    const sources = [];

    if (settings.enableWikipedia) {
        try {
            const res = await fetchWithTimeout(
                `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keyword)}&format=json&origin=*&srlimit=${perSite}`,
                { signal },
                Number(settings.searchTimeout),
            );
            if (res.ok) {
                const json = await res.json();
                for (const hit of (json?.query?.search || []).slice(0, perSite)) {
                    sources.push({ site: core.WIKIPEDIA_SITE, title: hit.title, url: core.wikipediaUrl(hit.title) });
                }
            }
        } catch (err) {
            diag('reader:维基找条目失败', { keyword, error: errorInfo(err) }, 'warn');
        }
    }

    if (settings.enableMoegirl) {
        try {
            const res = await fetchWithTimeout(
                `https://zh.moegirl.org.cn/api.php?action=opensearch&search=${encodeURIComponent(keyword)}&limit=5&format=json&origin=*`,
                { signal },
                Number(settings.searchTimeout),
            );
            if (res.ok) {
                for (const title of core.parseOpenSearchTitles(await res.json()).slice(0, perSite)) {
                    sources.push({ site: core.MOEGIRL_SITE, title, url: core.moegirlUrl(title) });
                }
            }
        } catch (err) {
            diag('reader:萌娘找条目失败', { keyword, error: errorInfo(err) }, 'warn');
        }
    }

    // 百度百科已移除：反爬（403 百度安全验证），正文读不到，留着只是噪音

    // ★ 自定义搜索源（SearXNG 等）：把搜到的**前 3 个网页地址**也交给 AI 去读
    let custom = [];
    if (settings.enableCustomSearch) {
        try {
            const req = core.buildCustomRequest(keyword, settings);
            const res = await fetchSearchOnce(req, settings, signal);
            if (res.ok) {
                const json = JSON.parse(await res.text());
                custom = core.extractCustomResultItems(json, settings).map((item) => ({
                    site: item.title ? `自定义来源：${item.title}` : '自定义来源',
                    title: item.title,
                    url: item.url,
                    fromCustom: true,
                    snippet: item.snippet,
                }));
            }
        } catch (err) {
            diag('reader:自定义来源搜索失败', { keyword, error: errorInfo(err) }, 'warn');
        }
    }

    // 自定义来源在最前（它给的是真实搜索排序），但它常混着百度/脸书/视频站这种
    // 读不到或没营养的链接 → 整体过一遍「过滤 + 百科优先 + 同站限一条」的排序
    const ordered = [...custom, ...sources];
    const cap = Math.max(1, Number(settings.readerMaxUrls) || 3);
    const limited = core.rankAndFilterUrls(ordered, { max: cap, perHost: 1 });
    if (!limited.length) {
        diag('reader:候选网址全被过滤掉', { keyword, raw: ordered.map((s) => core.safeUrl(s.url)) }, 'warn');
    }

    diag('reader:网址清单', {
        keyword,
        total: ordered.length,
        used: limited.length,
        list: limited.map((s) => `${s.site} ${core.safeUrl(s.url)}`),
    });
    return limited;
}

/** 用阅读器读整页正文（并发、可读性差的站点允许失败） */
async function readSourcesWithReader(sources, signal) {
    const settings = getSettings();
    const maxChars = Number(settings.readerMaxChars) || 0;
    const readable = sources;
    const started = Date.now();
    const results = await core.mapLimit(readable, Math.max(1, Number(settings.jinaConcurrency) || 3), async (src) => {
        if (signal?.aborted) return { ...src, error: 'aborted' };
        try {
            const res = await fetchWithTimeout(
                `https://r.jina.ai/${src.url}`,
                { signal, headers: { Accept: 'text/plain' } },
                Math.max(Number(settings.jinaPageTimeout) || 8000, 20000), // 阅读器本身慢，单独放宽
            );
            if (!res.ok) return { ...src, error: `HTTP ${res.status}` };
            let text = core.cleanJinaText(await res.text());
            if (maxChars > 0 && text.length > maxChars) {
                text = `${text.slice(0, maxChars)}…（正文已截断至 ${maxChars} 字）`;
            }
            return { ...src, text };
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            return { ...src, error: err.message };
        }
    });
    let out = sources.map((src) => results.find((r) => r && r.url === src.url) || { ...src, error: '未读取' });

    // 交给模型的正文总量上限：超出就按顺序保留，后面的截断（避免超长页面拖慢/触发输出截断）
    const totalCap = Number(settings.readerTotalChars) || 0;
    if (totalCap > 0) {
        let used = 0;
        out = out.map((src) => {
            const text = String(src.text || '');
            if (!text) return src;
            const remain = totalCap - used;
            if (remain <= 0) {
                return { ...src, text: '', error: `超出总量上限（${totalCap} 字），已跳过` };
            }
            used += Math.min(text.length, remain);
            return text.length > remain ? { ...src, text: `${text.slice(0, remain)}…（总量截断）` } : src;
        });
    }
    diag('reader:读取完成', {
        pages: out.filter((s) => s.text).length,
        chars: out.reduce((n, s) => n + String(s.text || '').length, 0),
        ms: Date.now() - started,
    });
    return out;
}

/** reader 模式：一个关键词 → 一份角色档案条目 */
async function searchByReader(keyword, signal) {
    let keywordsByKeywordOut = [];
    const urls = await collectSourceUrls(keyword, signal);
    if (!urls.length) return { entries: new Map(), details: [] };
    const withText = await readSourcesWithReader(urls, signal);
    const prompt = core.buildReaderPrompt({ keyword, sources: withText });
    let response = '';
    try {
        response = await callAnalysisRobust(prompt.system, prompt.user, signal, { label: '整理角色档案' });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        // 整理失败也别白搜：把抓到的原文按站点摘录存下来，并在正文里写清失败原因
        const readPages = withText.filter((s) => String(s.text || '').trim());
        if (!readPages.length) throw err;
        const excerpts = readPages
            .map((s) => `【${s.site}】${s.title || ''} <${s.url}>\n${core.cleanProviderText(s.text, 2000)}`)
            .join('\n\n');
        const fallback = `（**未整理**：整理模型失败 —— ${err.message}）\n\n${excerpts}`;
        diag('reader:整理失败，已回退为原文摘录', { keyword, error: errorInfo(err), chars: fallback.length }, 'error');
        toast(`⚠️ 整理模型失败，已改存原文摘录（${readPages.length} 页 / ${fallback.length} 字）`, 'warning');
        return {
            entries: new Map([[keyword, fallback]]),
            details: withText.map((s) => ({
                source: s.site,
                keyword,
                status: s.text ? 'success' : 'error',
                url: s.url,
                error: s.text ? undefined : { code: 'READER_FAILED', message: s.error || '未读取' },
            })),
        };
    }
    if (!String(response || '').trim()) {
        throw makeError('READER_MODEL_EMPTY', '整理模型没有返回内容（No message generated）');
    }
    // 剥掉思考内容，只保留从第一个字段开始的正式档案（思考不该进世界书）
    let content = core.sanitizeProfileOutput(core.cleanProviderText(String(response).trim(), 0), 0);
    // 「激活关键词」那一行从正文里剥掉 → 变成世界书的 key 数组（含本地兜底挖到的别名）
    const kwInfo = core.extractKeywordLine(content);
    content = kwInfo.text;
    const keywords = core.mergeKeywords([keyword], kwInfo.keywords, core.extractAliasKeywords(keyword, content));
    const entries = new Map([[keyword, content]]);
    // 来源只作为词条元数据保存（资料库里可见，不进正文、不注入扮演）
    const sources = withText.filter((s) => String(s.text || '').trim()).map((s) => ({ site: s.site, title: s.title || '', url: s.url }));
    const details = withText.map((s) => ({
        source: s.site,
        keyword,
        status: s.text ? 'success' : 'error',
        error: s.text ? undefined : { code: 'READER_FAILED', message: s.error || '未读取' },
        url: s.url,
    }));
    diag('reader:完成', { keyword, chars: content.length, pages: sources.length, keywords });
    return { entries, details, sources, keywords };
}
async function runAllSources(keywords, signal) {
    const settings = getSettings();
    const resultMap = new Map();
    const details = [];
    const tasks = [];

    for (const keyword of keywords) {
        if (settings.enableWikipedia) tasks.push({ source: 'Wikipedia', keyword, run: () => searchWikipedia(keyword, signal) });
        if (settings.enableMoegirl) tasks.push({ source: 'Moegirl', keyword, run: () => searchMoegirl(keyword, signal) });
        if (settings.enableCustomSearch) tasks.push({ source: 'CustomSearch', keyword, run: () => searchCustom(keyword, signal) });
    }

    diag('搜索源:任务创建', { keywordCount: keywords.length, taskCount: tasks.length });
    if (!tasks.length) {
        toast('⚠️ 没有启用任何搜索源（至少开一个：Wiki / 萌百 / 自定义来源）', 'warning');
    }

    await Promise.all(
        tasks.map(async (task) => {
            try {
                const out = await task.run();
                const lines = out?.lines || [];
                if (lines.length) {
                    const prev = resultMap.get(task.keyword) || '';
                    const merged = prev ? `${prev}\n${lines.join('\n')}` : lines.join('\n');
                    resultMap.set(task.keyword, merged);
                }
                details.push({ source: task.source, keyword: task.keyword, status: out?.outcome || classifyOutcome(lines) });
            } catch (err) {
                if (err?.name === 'AbortError') throw err;
                details.push({ source: task.source, keyword: task.keyword, status: 'error', error: errorInfo(err) });
                diag('搜索源:失败', { source: task.source, keyword: task.keyword, error: errorInfo(err) }, 'error');
            }
        }),
    );

    resultMap._summary = {
        taskCount: tasks.length,
        successCount: details.filter((d) => d.status === 'success').length,
        emptyCount: details.filter((d) => d.status === 'empty').length,
        errorCount: details.filter((d) => d.status === 'error').length,
        aborted: !!signal?.aborted,
        details,
    };
    return resultMap;
}

/** 逐字移植 husouSearchSummaryText */
function summarizeTasks(summary) {
    if (!summary) return '没有搜索任务明细';
    const failures = (summary.details || [])
        .filter((d) => d.status === 'error')
        .slice(0, 8)
        .map((d) => `${d.source}/${d.keyword}：${d.error?.code || 'ERROR'} ${d.error?.message || '未知错误'}`)
        .join('\n');
    return `任务=${summary.taskCount || 0}，成功=${summary.successCount || 0}，正常空结果=${summary.emptyCount || 0}，失败=${summary.errorCount || 0}${failures ? `\n失败明细：\n${failures}` : ''}`;
}

/* ============================================================================
 * Jina 全文抓取 + AI 过滤
 * ==========================================================================*/

async function fetchPageWithJina(url, signal) {
    const settings = getSettings();
    const clean = core.normalizeJinaUrl(url);
    if (!/^https?:\/\//i.test(clean)) return null;
    const readerUrl = `https://r.jina.ai/${clean}`;
    try {
        const res = await fetchWithTimeout(readerUrl, { signal, headers: { Accept: 'text/plain' } }, Number(settings.jinaPageTimeout));
        if (!res.ok) return null;
        const text = core.cleanJinaText(await res.text());
        const min = Number(settings.jinaMinTextLength) || 200;
        if (!text || text.length < min) return null;
        return text;
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        diag('Jina:抓取失败', { url: core.safeUrl(clean), error: errorInfo(err) }, 'warn');
        return null;
    }
}

/**
 * Jina 全文抓取（速度优先版）
 *
 * 旧实现：每个关键词最多 3 页、**串行**、单页超时 20s → 3 个关键词最坏 180s，这是"4 分钟"的主因。
 * 现在：全局只抓前 N 页（默认 3）+ **并发抓取** + 单页超时 8s + 阶段总预算 25s；
 * 候选本来就不多（≤2 页）时**跳过前置筛选那次模型调用**，省一整轮 LLM。
 */
async function enrichWithJina(resultMap, keywords, signal) {
    const settings = getSettings();
    const candidates = core.extractJinaCandidates(resultMap);
    if (!candidates.length) return resultMap;

    // 只在候选较多时才花钱做前置筛选（少的时候直接抓，反正也就那几页）
    let approvedUrls = null;
    const totalCap = Math.max(0, Number(settings.jinaMaxUrlsTotal) || 0);
    const needPrefilter = settings.aiFilter && settings.enableJinaPrefilter && candidates.length > 2;
    if (needPrefilter) {
        try {
            const started = Date.now();
            const system = `${core.buildFixedContextHeader().content}\n\n${core.buildContextOrderNote().content}`;
            const prompt = core.buildJinaPrefilterPrompt(candidates, keywords);
            const response = await callAnalysisRobust(system, prompt, signal, { label: 'Jina 前置筛选' });
            approvedUrls = core.parsePrefilterJson(response, candidates);
            diag('Jina前筛选:完成', { candidateCount: candidates.length, approvedCount: approvedUrls.size, ms: Date.now() - started });
        } catch (err) {
            diag('Jina前筛选:失败并回退（直接抓）', { error: errorInfo(err) }, 'error');
        }
    } else {
        diag('Jina前筛选:跳过（候选少，直接抓更快）', { candidateCount: candidates.length });
    }

    const targets = core.planJinaTargets(candidates, {
        perKeyword: Number(settings.jinaMaxUrlsPerKeyword) || 3,
        total: totalCap,
        approvedUrls,
    });
    if (!targets.length) {
        diag('Jina:没有可抓页面', { candidateCount: candidates.length });
        return resultMap;
    }

    const startedAt = Date.now();
    const budget = Math.max(3000, Number(settings.jinaTotalBudgetMs) || 25000);
    const concurrency = Math.max(1, Number(settings.jinaConcurrency) || 3);
    diag('Jina:开始抓取', { pages: targets.length, concurrency, pageTimeout: Number(settings.jinaPageTimeout), budget, urls: targets.map((c) => core.safeUrl(c.url)) });

    const fetched = await core.mapLimit(targets, concurrency, async (c) => {
        if (signal?.aborted) return null;
        if (Date.now() - startedAt > budget) {
            diag('Jina:超出总预算，跳过剩余页面', { url: core.safeUrl(c.url) }, 'warn');
            return null;
        }
        const text = await fetchPageWithJina(c.url, signal);
        return text ? { keyword: c.keyword, url: c.url, text } : null;
    });
    const ok = fetched.filter((x) => x && x.text);
    const css = Date.now() - startedAt;
    diag('Jina:抓取完成', { pages: targets.length, ok: ok.length, ms: css });

    if (!ok.length) return resultMap;

    const out = new Map(resultMap);
    out._summary = resultMap._summary; // 复制 Map 时必须带上任务明细，否则会显示「没有搜索任务明细」
    for (const item of ok) {
        const prev = out.get(item.keyword) || '';
        out.set(item.keyword, `${prev}\n\n【网页全文】\n（来源 ${core.safeUrl(item.url)}）\n${item.text}`);
    }
    if (state.searchTiming) state.searchTiming.jinaMs = css;
    return out;
}
async function filterResults(resultMap, keywords, signal) {
    const settings = getSettings();
    if (!resultMap.size) return new Map();
    if (!settings.aiFilter) return new Map(resultMap);

    let existing = '';
    try {
        existing = loadLocalText();
    } catch { /* ignore */ }

    // 重试计划：**先放大输出上限 max_tokens**（推理模型把额度花在思考上是最常见的失败），
    // 再考虑缩减输入。只裁输入是治不了 finish_reason=length 的。
    const attempts = core.analysisAttempts({
        baseOutput: Number(settings.customMaxTokens) || 8192,
        maxInputChars: Number(settings.analysisMaxInputChars) || 0,
    });
    let lastError = null;

    for (let i = 0; i < attempts.length; i++) {
        const { maxInput, maxOutput, why } = attempts[i];
        const built = core.buildBudgetedRawText(resultMap, {
            maxChars: maxInput,
            perKeywordChars: Number(settings.maxExtractLength) || 0,
        });
        if (!built.text.trim()) break;

        const system = core.buildFilterSystemPrompt({
            rawText: built.text,
            keywords: core.keywordsLine(keywords),
            existing,
            mode: settings.filterMode || 'focus',
            keywordList: keywords,
        });
        const user = core.buildFilterUserPrompt(settings.filterMode || 'focus');

        try {
            diag('过滤:尝试', { attempt: i + 1, why, maxInput, maxOutput, rawChars: built.text.length, truncated: built.truncated });
            const response = await callAnalysisRobust(system, user, signal, { label: '知识整理' });
            if (!String(response || '').trim()) {
                throw makeError('FILTER_MODEL_EMPTY', '分析模型没有返回任何内容（No message generated）');
            }
            const parsed = core.parseKnowledgeResponse(response);
            if (!parsed.ok) throw makeError(parsed.error, `AI 过滤解析失败：${parsed.error}`);
            if (parsed.truncated) {
                // 输出被掐断但已完成部分能用 → 直接采用，绝不为了"补全"再花一轮
                diag('过滤:输出被截断，已采用截断前可用条目', { keptCount: parsed.entries.size, maxOutput }, 'warn');
                toast(`🦊 输出被 max_tokens 掐断，已采用已完成的 ${parsed.entries.size} 条（想更完整就把输出上限调大，如 32768）`, 'warning');
            }
            if (parsed.noNew && !parsed.truncated) {
                diag('过滤:正常无新增', { rawCount: resultMap.size, maxInput, maxOutput });
                return new Map();
            }
            // 本地兜底：聚焦模式下把明显无关的实体条目剔掉（模型偶尔不听话）
            let entries = parsed.entries;
            if ((settings.filterMode || 'focus') === 'focus' && entries.size > 1) {
                const focused = core.filterEntriesByFocus(entries, keywords);
                if (focused.size !== entries.size) {
                    diag('过滤:本地聚焦兜底', { before: entries.size, after: focused.size, dropped: [...entries.keys()].filter((k) => !focused.has(k)) });
                }
                entries = focused;
            }
            diag('过滤:完成', { rawCount: resultMap.size, keptCount: entries.size, mode: settings.filterMode, maxInput, maxOutput, attempt: i + 1 });
            return entries;
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            lastError = err;
            const canRetry = i < attempts.length - 1;
            const truncated = core.isOutputTruncated(err);
            diag('过滤:本次失败', { attempt: i + 1, why, maxInput, maxOutput, truncated, error: errorInfo(err), willRetry: canRetry }, 'error');
            if (!canRetry) break;
            toast(`🦊 ${attempts[i + 1].why}…`, 'info');
        }
    }

    diag('过滤:失败并回退为原始结果', { error: errorInfo(lastError) }, 'error');
    const truncated = core.isOutputTruncated(lastError);
    toast(
        `⚠️ AI 过滤失败，已回退为原始结果：${lastError?.message || '未知错误'}\n` +
            (truncated
                ? `（模型把输出额度花在思考上了：把「分析模型 → max_tokens」调大（如 16384），或换非推理模型）`
                : `（已按输出上限与输入预算逐级重试；仍失败可调大 max_tokens、关掉「AI 过滤」，或换一个连接）`),
        'warning',
    );
    return new Map(resultMap);
}

/* ============================================================================
 * 主流程
 * ==========================================================================*/

/** 把各阶段耗时排成一行，便于用户/作者看清"慢在哪" */
function formatTiming(t) {
    if (!t) return '耗时未知';
    const s = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
    const parts = [`总计 ${s(t.totalMs)}`];
    if (t.keywordMs) parts.push(`关键词 ${s(t.keywordMs)}`);
    if (t.searchMs) parts.push(`搜索 ${s(t.searchMs)}`);
    if (t.jinaMs) parts.push(`全文抓取 ${s(t.jinaMs)}`);
    if (t.filterMs) parts.push(`整理 ${s(t.filterMs)}`);
    return parts.join(' / ');
}
function summarizeKeywords(keywords) {
    const list = core.normalizeKeywords(keywords);
    const max = Number(getSettings().maxKeywords) || 0;
    return max > 0 ? list.slice(0, max) : list;
}

async function extractKeywords(signal) {
    const prompt = await buildAnalysisPrompt();
    // 输出上限的加倍重试已经在 callAnalysisRobust 里统一处理（并会记住新上限）
    const response = await callAnalysisRobust('', prompt, signal, { label: '关键词提取' });
    const parsed = core.parseJsonArray(response);
    if (!parsed.ok) {
        throw makeError(parsed.error, `关键词模型输出无法解析（${parsed.error}）`, { preview: String(response).slice(0, 300) });
    }
    return summarizeKeywords(parsed.value);
}

/**
 * 完整Agent 搜索流程：关键词 → 多源搜索 → Jina 全文 → AI 过滤 → 可注入结果
 * @param {{keywords?: string[], manual?: boolean}} options
 */
async function executeSearch(options = {}) {
    if (state.running) {
        toast('🦊 Agent 搜索正在运行中，点击「取消」可中断', 'warning');
        return false;
    }
    const settings = getSettings();
    const manualKeywords = core.normalizeKeywords(options.keywords || []);
    const manual = manualKeywords.length > 0 || !!options.manual;

    state.running = true;
    state.searchTiming = { startedAt: Date.now(), keywordMs: 0, searchMs: 0, jinaMs: 0, filterMs: 0, totalMs: 0 };
    state.abortController = new AbortController();
    const signal = state.abortController.signal;
    updateQuickPanel();

    try {
        let keywords = manualKeywords;
        if (!keywords.length) {
            const ctx = ctxGet();
            const floors = ctx?.chat?.length || 0;
            log('自动提取关键词，聊天楼层数', floors);
            const t0 = Date.now();
            keywords = summarizeKeywords(await extractKeywords(signal));
            state.searchTiming.keywordMs = Date.now() - t0;
        }
        if (signal.aborted) throw makeError('ABORTED', '已取消');

        if (!keywords.length) {
            diag('关键词:正常为空', { manual });
            toast('🦊 没有提取到需要搜索的关键词（可手动输入关键词再搜）', 'info');
            return false;
        }

        state.pendingKeywords = keywords;
        updateKeywordPanel(keywords);

        const tSearch = Date.now();
        const readerMode = (settings.providerMode || 'reader') === 'reader';
        let rawMap;
        if (readerMode) {
            // reader 模式：先把各来源的网址收集起来（自定义来源优先取前 3 条），
            // 再用阅读器读整页，最后交给模型整理成角色档案 —— 插件不再自己截断取正文。
            rawMap = new Map();
            const allDetails = [];
            const sourcesByKeyword = {};
            const keywordsByKw = {};
            for (const kw of keywords) {
                if (signal.aborted) throw makeError('ABORTED', '已取消');
                const one = await searchByReader(kw, signal);
                for (const [k, v] of one.entries) rawMap.set(k, v);
                if (one.sources?.length) sourcesByKeyword[kw] = one.sources;
                if (one.keywords?.length) keywordsByKw[kw] = one.keywords;
                allDetails.push(...one.details);
            }
            state.lastSources = sourcesByKeyword;
            state.lastKeywordsByKw = keywordsByKw;
            rawMap._summary = {
                taskCount: allDetails.length,
                successCount: allDetails.filter((d) => d.status === 'success').length,
                emptyCount: 0,
                errorCount: allDetails.filter((d) => d.status === 'error').length,
                details: allDetails,
            };
        } else {
            rawMap = await runAllSources(keywords, signal);
        }
        state.searchTiming.searchMs = Date.now() - tSearch;
        if (signal.aborted) throw makeError('ABORTED', '已取消');
        if (!readerMode && settings.enableJinaFetch && rawMap.size) {
            rawMap = await enrichWithJina(rawMap, keywords, signal);
        }
        const tFilter = Date.now();
        const filteredMap = !rawMap.size
            ? new Map()
            : readerMode
              ? new Map(rawMap) // reader 模式的内容已经是模型整理好的角色档案，不再二次过滤
              : await filterResults(rawMap, keywords, signal);
        state.searchTiming.filterMs = Date.now() - tFilter;

        state.searchTiming.totalMs = Date.now() - state.searchTiming.startedAt;
        state.lastResult = {
            keywords,
            rawMap,
            filteredMap,
            summary: rawMap._summary || null,
            timing: state.searchTiming,
            injectText: '',
        };

        if (filteredMap.size) {
            const inject = core.buildSearchResultsInject(
                core.mapToPlainText(filteredMap, keywords),
                settings.foxSearchHead,
                settings.foxSearchTail,
            );
            state.pendingInject = inject;
            state.lastResult.injectText = inject;
            if (settings.saveToHusouLocal || settings.saveToPersonality) {
                await saveResults(filteredMap, keywords);
            }
            toast(`🦊 Agent 搜索完成：${filteredMap.size} 条（${formatTiming(state.searchTiming)}），已就绪注入本次生成`, 'success');
        } else {
            state.pendingInject = '';
            toast(`🦊 Agent 搜索完成，无新信息\n${summarizeTasks(rawMap._summary)}`, 'info');
        }
        return filteredMap.size > 0;
    } catch (err) {
        if (err?.name === 'AbortError' || err?.code === 'ABORTED') {
            toast('🦊 Agent 搜索已取消', 'info');
            return false;
        }
        diag('主流程:失败', { error: errorInfo(err) }, 'error');
        toast(`❌ Agent 搜索失败：${err.message}（详情见控制台「Agent 搜索诊断」）`, 'error');
        return false;
    } finally {
        state.running = false;
        state.abortController = null;
        updateQuickPanel();
    }
}

/* ============================================================================
 * 结果落盘：默认存到「酒馆服务器」（世界书文件），跨浏览器/跨设备共用
 *
 * 为什么不默认用 localStorage：localStorage 是每个浏览器各存一份，
 * 电脑浏览器存的资料，手机浏览器打不开（用户实际遇到的坑）。
 * 服务端存储用 /api/worldinfo/edit 写 data/<user>/worlds/<名字>.json：
 *  - 同一酒馆服务器的所有浏览器共用一份；
 *  - 在酒馆的「世界书」界面里能直接看到、编辑、导出；
 *  - 仍会在本地留一份 localStorage 备份，服务器读不到时兜底。
 * ==========================================================================*/

/** 运行期资料库缓存：现在是「世界书词条」而不是整段文本 */
const libraryCache = {
    entries: [], // [{name, content, keywords[], constant, disabled, ts}]
    loaded: false,
    source: 'unknown', // server | local | local-fallback
    error: '',
    worlds: [], // 服务器上可选的世界书列表
};

/** 兼容旧字段名（有些地方还在读 blocks） */
Object.defineProperty(libraryCache, 'blocks', {
    get() {
        return this.entries.map((e) => ({ ts: e.ts, content: e.content }));
    },
});

function localLibKey(charId = getCharId()) {
    return `${LOCAL_LIB_PREFIX}${encodeURIComponent(charId)}`;
}

/** 本地备份（老键名，保持与原预设兼容）；读出来统一成词条 */
function readLocalBackup() {
    try {
        const raw = localStorage.getItem(localLibKey());
        const parsed = raw ? JSON.parse(raw) : { blocks: [] };
        if (Array.isArray(parsed?.entries)) return parsed.entries.map((e) => core.makeEntry(e));
        const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
        const text = blocks.map((b) => String(b?.content || '')).join('\n\n');
        return core.parseEntriesFromBlockText(text);
    } catch {
        return [];
    }
}

function writeLocalBackup(entries) {
    try {
        const list = (entries || []).filter((e) => String(e?.content || '').trim() || String(e?.name || '').trim()).slice(-60);
        if (!list.length) {
            localStorage.removeItem(localLibKey());
            return;
        }
        localStorage.setItem(localLibKey(), JSON.stringify({ entries: list }));
    } catch { /* ignore */ }
}

function husouLoadLocalData() {
    return { entries: libraryCache.entries };
}

/** 同步读资料库全文（注入 / smartSkip 用缓存；格式与世界书条目一致） */
function loadLocalText() {
    return core.entriesToPlainText(libraryCache.entries);
}

function libraryWorldName() {
    return String(getSettings().libraryWorldName || 'Agent 搜索资料库').trim() || 'Agent 搜索资料库';
}

async function stPost(url, body) {
    const res = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: { ...(stCore.getRequestHeaders?.() || { 'Content-Type': 'application/json' }) },
            body: JSON.stringify(body || {}),
        },
        30000,
    );
    const text = await res.text();
    if (!res.ok) throw makeError('ST_API_ERROR', `${url} HTTP ${res.status}`, { preview: text.slice(0, 200) });
    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return text;
    }
}

/** 列出服务器上的世界书（用于绑定选择） */
async function listWorldBooks() {
    const worlds = await stPost('/api/worldinfo/list', {});
    return Array.isArray(worlds) ? worlds.map((w) => String(w?.file_id || w?.name || '')).filter(Boolean) : [];
}

/** 从绑定的世界书读词条 */
async function loadLibraryFromServer() {
    const name = libraryWorldName();
    const worlds = await listWorldBooks();
    if (!worlds.includes(name)) return { exists: false, entries: [], worlds };
    const data = await stPost('/api/worldinfo/get', { name });
    return { exists: true, entries: core.worldDataToEntries(data), worlds };
}

/** 写回绑定的世界书（真·世界书条目：带关键词与绿灯/关灯） */
async function saveLibraryToServer(entries) {
    const name = libraryWorldName();
    const data = core.entriesToWorldData(name, entries);
    await stPost('/api/worldinfo/edit', { name, data });
    return data;
}

/**
 * 刷新资料库缓存。
 * 服务端模式：读世界书 → 不存在但本地有旧数据 → 自动迁移上去（只提示一次）。
 */
async function refreshLibrary({ notify = false } = {}) {
    const settings = getSettings();
    const localEntries = readLocalBackup();

    if (settings.libraryStorage === 'local') {
        libraryCache.entries = localEntries;
        libraryCache.source = 'local';
        libraryCache.loaded = true;
        if (notify) toast(`🦊 资料库（仅本浏览器）：${libraryCache.entries.length} 个词条`, 'info');
        return libraryCache;
    }

    try {
        const { exists, entries, worlds } = await loadLibraryFromServer();
        if (worlds) libraryCache.worlds = worlds;
        if (!exists) {
            if (localEntries.length) {
                libraryCache.entries = localEntries;
                await saveLibraryToServer(localEntries);
                libraryCache.source = 'server';
                libraryCache.loaded = true;
                toast(`🦊 已把本浏览器里的 ${localEntries.length} 个词条迁移到世界书「${libraryWorldName()}」`, 'success');
                diag('资料库:迁移到世界书', { entries: localEntries.length, world: libraryWorldName() });
                return libraryCache;
            }
            libraryCache.entries = [];
            libraryCache.source = 'server';
            libraryCache.loaded = true;
            if (notify) toast(`🦊 世界书「${libraryWorldName()}」还没有词条，搜一次并勾选保存即可`, 'info');
            return libraryCache;
        }
        libraryCache.entries = entries;
        libraryCache.source = 'server';
        libraryCache.error = '';
        writeLocalBackup(entries);
        libraryCache.loaded = true;
        diag('资料库:已从世界书载入', { world: libraryWorldName(), entries: entries.length });
        if (notify) toast(`🦊 世界书「${libraryWorldName()}」：${entries.length} 个词条`, 'success');
        return libraryCache;
    } catch (err) {
        libraryCache.entries = localEntries;
        libraryCache.source = 'local-fallback';
        libraryCache.error = err?.message || String(err);
        libraryCache.loaded = true;
        diag('资料库:服务器不可用，回退本浏览器', { error: errorInfo(err) }, 'error');
        toast(`⚠️ 读不到世界书「${libraryWorldName()}」（${err.message}），暂用本浏览器缓存 ${localEntries.length} 个词条`, 'warning');
        return libraryCache;
    }
}

/** 持久化当前缓存（写入绑定的世界书 + 本地备份） */
async function persistLibrary(entries) {
    const list = (entries || []).map((e) => core.makeEntry(e)).filter((e) => e.content.trim() || e.name).slice(0, 200);
    libraryCache.entries = list;
    writeLocalBackup(list);
    if (getSettings().libraryStorage === 'local') return { saved: 'local' };
    try {
        await saveLibraryToServer(list);
        libraryCache.source = 'server';
        return { saved: 'server' };
    } catch (err) {
        diag('资料库:写世界书失败', { error: errorInfo(err) }, 'error');
        toast(`❌ 写入世界书「${libraryWorldName()}」失败：${err.message}（已留在本浏览器备份）`, 'error');
        return { saved: 'local' };
    }
}

/** 兼容老接口：手动保存（现按词条走 persistLibrary） */
async function saveLocalBlocks(entries) {
    await persistLibrary(entries);
    return { entries: libraryCache.entries };
}

/* ---------------------------------------------------------------------------
 * 资料库查看器：酒馆 localStorage 里的Agent 搜索资料（默认会注入到当前提示词）
 * -------------------------------------------------------------------------*/

let libraryBlocks = [];
let librarySaveTimer = null;

function libraryCharLabel() {
    try {
        const ctx = ctxGet();
        const character = ctx?.characters?.[ctx?.characterId];
        return character?.name || '（未选中角色卡）';
    } catch {
        return '（未知角色）';
    }
}

/**
 * 资料库窗口：**词条列表**（表面只显示词条名 + 灯 + 关键词），点开看详情。
 * 直接写进绑定的世界书，条目带激活关键词与绿灯/关灯，酒馆自己会按灯注入。
 */
let libraryEntries = [];
let expandedEntry = -1;

async function openLibrary() {
    let modal = document.getElementById('ag-lib-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'ag-lib-modal';
        modal.innerHTML = `
            <div id="ag-lib-dialog">
                <div id="ag-lib-head">
                    <b>📚 Agent 搜索资料库（世界书词条）</b>
                    <span class="ag-lib-head-btns">
                        <span id="ag-lib-big" title="放大">⤢</span>
                        <span id="ag-lib-mid" title="还原">⤡</span>
                        <span id="ag-lib-close" title="关闭">✕</span>
                    </span>
                </div>
                <div id="ag-lib-worldbar">
                    <span>写入世界书：</span>
                    <select id="ag-lib-world"></select>
                    <button id="ag-lib-world-refresh" class="menu_button" title="刷新列表">🔄</button>
                    <button id="ag-lib-world-new" class="menu_button" title="新建世界书">➕</button>
                    <button id="ag-lib-new-entry" class="menu_button">➕ 新建词条</button>
                    <button id="ag-lib-save" class="menu_button">💾 保存到世界书</button>
                </div>
                <div class="ag-note">点词条名展开详情；🔵 蓝灯=常驻注入（不看关键词），🟢 绿灯=按关键词激活，⚪ 关灯=不注入</div>
                <div id="ag-lib-meta"></div>
                <div id="ag-lib-body"></div>
                <div id="ag-lib-foot">
                    <button id="ag-lib-copy" class="menu_button">📋 复制全文</button>
                    <button id="ag-lib-export" class="menu_button">⬇️ 导出 JSON</button>
                    <button id="ag-lib-clear" class="menu_button">🗑️ 清空</button>
                    <button id="ag-lib-done" class="menu_button">✅ 完成</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        makeLibraryDialogDraggable();
        $('#ag-lib-close').addEventListener('click', closeLibrary);
        $('#ag-lib-done').addEventListener('click', closeLibrary);
        $('#ag-lib-big').addEventListener('click', () => resizeLibraryDialog('big'));
        $('#ag-lib-mid').addEventListener('click', () => resizeLibraryDialog('mid'));
        $('#ag-lib-new-entry').addEventListener('click', () => {
            libraryEntries.unshift(core.makeEntry({ name: '', content: '', keywords: [], ts: new Date().toISOString().split('T')[0] }));
            expandedEntry = 0;
            renderLibrary();
        });
        $('#ag-lib-save').addEventListener('click', async () => {
            const res = await persistLibrary(libraryEntries);
            toast(res.saved === 'server' ? `🦊 已写入世界书「${libraryWorldName()}」：${libraryEntries.length} 个词条` : '🦊 已保存在本浏览器', 'success');
        });
        $('#ag-lib-world-refresh').addEventListener('click', async () => {
            await refreshLibrary({ notify: false });
            await renderWorldSelector();
            toast('🦊 世界书列表已刷新', 'success');
        });
        $('#ag-lib-world-new').addEventListener('click', async () => {
            const name = window.prompt('新建世界书的名字：', 'Agent 搜索资料库');
            if (!name) return;
            const store = extSettings();
            store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), libraryWorldName: name.trim(), libraryStorage: 'server' });
            state.settings = store[MODULE];
            saveSettings();
            await persistLibrary(libraryEntries);
            await renderWorldSelector();
            toast(`🦊 已新建并绑定世界书「${name.trim()}」`, 'success');
        });
        $('#ag-lib-world').addEventListener('change', async (e) => {
            const store = extSettings();
            store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), libraryWorldName: e.target.value, libraryStorage: 'server' });
            state.settings = store[MODULE];
            saveSettings();
            await refreshLibrary({ notify: true });
            libraryEntries = libraryCache.entries.map((x) => core.makeEntry(x));
            expandedEntry = -1;
            renderLibrary();
        });
        $('#ag-lib-copy').addEventListener('click', async () => {
            const text = core.entriesToPlainText(libraryEntries);
            try {
                await navigator.clipboard.writeText(text);
                toast('🦊 已复制到剪贴板', 'success');
            } catch {
                toast('⚠️ 复制失败，请手动框选', 'warning');
            }
        });
        $('#ag-lib-export').addEventListener('click', () => {
            const blob = new Blob([JSON.stringify({ world: libraryWorldName(), storage: libraryCache.source, entries: libraryEntries }, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Agent 搜索资料库_${libraryWorldName()}_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 3000);
        });
        $('#ag-lib-clear').addEventListener('click', async () => {
            if (!confirm(`确定清空？世界书「${libraryWorldName()}」里的词条也会一起删掉，不可恢复。`)) return;
            libraryEntries = [];
            await persistLibrary([]);
            renderLibrary();
            toast('🦊 已清空', 'success');
        });
    }

    await refreshLibrary();
    libraryEntries = libraryCache.entries.map((x) => core.makeEntry(x));
    expandedEntry = -1;
    applyLibraryDialogRect();
    modal.classList.add('is-open');
    renderWorldSelector();
    renderLibrary();
}

/** 世界书下拉 */
async function renderWorldSelector() {
    const sel = $('#ag-lib-world');
    if (!sel) return;
    let worlds = libraryCache.worlds || [];
    if (!worlds.length) {
        try {
            worlds = await listWorldBooks();
            libraryCache.worlds = worlds;
        } catch { /* ignore */ }
    }
    const current = libraryWorldName();
    const options = [...new Set([current, ...worlds])].filter(Boolean);
    sel.innerHTML = options.map((w) => `<option value="${escapeHtml(w)}"${w === current ? ' selected' : ''}>${escapeHtml(w)}</option>`).join('');
}

/** 词条列表：一行一个词条，点开看详情 */
function renderLibrary() {
    const body = $('#ag-lib-body');
    const meta = $('#ag-lib-meta');
    if (!body) return;

    const totalChars = libraryEntries.reduce((n, e) => n + e.content.length, 0);
    if (meta) {
        const where = libraryCache.source === 'server' ? '已连接' : libraryCache.source === 'local-fallback' ? `⚠️ 读不到（${libraryCache.error || '未知'}）` : '仅本浏览器';
        meta.textContent = `世界书「${libraryWorldName()}」· ${where} · ${libraryEntries.length} 个词条 · ${totalChars} 字符`;
    }

    if (!libraryEntries.length) {
        body.innerHTML = '<div class="ag-lib-empty">（空）搜一次并勾选「保存到Agent 搜索资料库」，结果会被整理成词条写进这里。</div>';
        return;
    }

    body.innerHTML = libraryEntries
        .map((e, i) => {
            const light = e.disabled ? '⚪' : e.constant ? '🔵' : '🟢';
            const keys = e.keywords.length ? e.keywords.join('、') : '（无关键词）';
            const open = i === expandedEntry;
            return `
        <div class="ag-entry${open ? ' is-open' : ''}" data-index="${i}">
            <div class="ag-entry-row" data-index="${i}">
                <span class="ag-entry-light" data-light="${i}" title="点击切换 蓝灯(常驻)/绿灯(关键词)/关灯">${light}</span>
                <span class="ag-entry-name">${escapeHtml(e.name || '（未命名词条）')}</span>
                <span class="ag-entry-meta">${e.content.length} 字 · ${escapeHtml(keys)}</span>
                <span class="ag-entry-arrow">${open ? '▾' : '▸'}</span>
            </div>
            ${open ? `
            <div class="ag-entry-detail" data-index="${i}">
                <label class="ag-field"><span>词条名（列表上显示的就是它）</span>
                    <input class="ag-entry-name-input" data-index="${i}" type="text" value="${escapeHtml(e.name)}"></label>
                <label class="ag-field"><span>激活关键词（逗号分隔；🔵 蓝灯按这些词触发）</span>
                    <input class="ag-entry-keys" data-index="${i}" type="text" value="${escapeHtml(e.keywords.join(', '))}"></label>
                <div class="ag-note ag-entry-hint">🔵 蓝灯=常驻注入（不看关键词） · 🟢 绿灯=按激活关键词触发 · ⚪ 关灯=禁用不注入</div>
                <div class="ag-entry-toggles">
                    <label><input type="checkbox" class="ag-entry-constant" data-index="${i}" ${e.constant ? 'checked' : ''}> 🔵 蓝灯（常驻注入，不看关键词）</label>
                    <label><input type="checkbox" class="ag-entry-disabled" data-index="${i}" ${e.disabled ? 'checked' : ''}> ⚪ 关灯（禁用，不注入）</label>
                    <button class="menu_button ag-entry-del" data-index="${i}">🗑️ 删除词条</button>
                </div>
                <label class="ag-field"><span>详情正文（点进来看到的内容）</span>
                    <textarea class="ag-entry-content" data-index="${i}" rows="8">${escapeHtml(e.content)}</textarea></label>
                ${(e.sources || []).length
                    ? `<div class="ag-entry-sources"><span>来源（只记录，不写入正文、不注入扮演）：</span>${(e.sources || [])
                          .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.site || s.url)}</a>`)
                          .join(' · ')}</div>`
                    : ''}
            </div>` : ''}
        </div>`;
        })
        .join('');

    // 展开/收起
    body.querySelectorAll('.ag-entry-row').forEach((row) => {
        row.addEventListener('click', () => {
            const i = Number(row.dataset.index);
            expandedEntry = expandedEntry === i ? -1 : i;
            renderLibrary();
        });
    });
    // 灯：蓝(常驻) → 绿(关键词) → 关 → 蓝
    body.querySelectorAll('.ag-entry-light').forEach((el) => {
        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const i = Number(el.dataset.light);
            const e = libraryEntries[i];
            if (e.disabled) { e.disabled = false; e.constant = true; }
            else if (e.constant) { e.constant = false; }
            else { e.disabled = true; }
            scheduleLibrarySave();
            renderLibrary();
        });
    });
    // 字段编辑
    body.querySelectorAll('.ag-entry-name-input').forEach((el) => {
        el.addEventListener('input', () => {
            const i = Number(el.dataset.index);
            libraryEntries[i].name = el.value;
            if (!libraryEntries[i].keywords.length) libraryEntries[i].keywords = core.normalizeKeywords(el.value);
            scheduleLibrarySave();
        });
    });
    body.querySelectorAll('.ag-entry-keys').forEach((el) => {
        el.addEventListener('input', () => {
            libraryEntries[Number(el.dataset.index)].keywords = core.normalizeKeywords(el.value);
            scheduleLibrarySave();
        });
    });
    body.querySelectorAll('.ag-entry-constant').forEach((el) => {
        el.addEventListener('change', () => {
            libraryEntries[Number(el.dataset.index)].constant = el.checked;
            scheduleLibrarySave();
        });
    });
    body.querySelectorAll('.ag-entry-disabled').forEach((el) => {
        el.addEventListener('change', () => {
            libraryEntries[Number(el.dataset.index)].disabled = el.checked;
            scheduleLibrarySave();
        });
    });
    body.querySelectorAll('.ag-entry-content').forEach((area) => {
        autoSizeLibraryText(area);
        area.addEventListener('input', () => {
            libraryEntries[Number(area.dataset.index)].content = area.value;
            scheduleLibrarySave();
        });
    });
    body.querySelectorAll('.ag-entry-del').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const i = Number(btn.dataset.index);
            libraryEntries.splice(i, 1);
            expandedEntry = -1;
            await persistLibrary(libraryEntries);
            renderLibrary();
        });
    });
}

function toggleAllLibraryTexts(expand) {
    document.querySelectorAll('#ag-lib-body .ag-entry-content').forEach((area) => {
        if (expand) area.style.height = `${area.scrollHeight + 8}px`;
        else autoSizeLibraryText(area);
    });
}
/** 关闭窗口 */
// Esc 关闭资料库窗口
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('ag-lib-modal')?.classList.contains('is-open')) {
        closeLibrary();
    }
});
function closeLibrary() {
    const modal = document.getElementById('ag-lib-modal');
    if (modal) modal.classList.remove('is-open');
    saveLibraryDialogRect();
}

/** 恢复/保存窗口位置尺寸 */
function applyLibraryDialogRect() {
    const dialog = document.getElementById('ag-lib-dialog');
    if (!dialog) return;
    const rect = getSettings().libraryDialogRect;
    if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
        dialog.style.width = `${Math.max(300, Math.min(rect.width, window.innerWidth - 10))}px`;
        dialog.style.height = `${Math.max(240, Math.min(rect.height, window.innerHeight - 10))}px`;
        if (Number.isFinite(rect.left)) {
            dialog.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - 120))}px`;
            dialog.style.top = `${Math.max(0, Math.min(rect.top, window.innerHeight - 80))}px`;
            dialog.style.transform = 'none';
        }
    }
}

function saveLibraryDialogRect() {
    const dialog = document.getElementById('ag-lib-dialog');
    if (!dialog) return;
    const r = dialog.getBoundingClientRect();
    const store = extSettings();
    store[MODULE] = core.normalizeSettings({
        ...(store[MODULE] || {}),
        libraryDialogRect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    });
    state.settings = store[MODULE];
    saveSettings();
}

/** 拖动标题栏（鼠标 + 触摸） */
function makeLibraryDialogDraggable() {
    const dialog = document.getElementById('ag-lib-dialog');
    const head = document.getElementById('ag-lib-head');
    if (!dialog || !head) return;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    const point = (e) => (e.touches?.[0] ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY });
    const start = (e) => {
        if (e.target?.closest?.('.ag-lib-head-btns')) return;
        const pt = point(e);
        const r = dialog.getBoundingClientRect();
        dragging = true;
        offsetX = pt.x - r.left;
        offsetY = pt.y - r.top;
        dialog.style.transform = 'none';
        e.preventDefault?.();
    };
    const move = (e) => {
        if (!dragging) return;
        const pt = point(e);
        dialog.style.left = `${Math.min(Math.max(0, pt.x - offsetX), Math.max(0, window.innerWidth - 90))}px`;
        dialog.style.top = `${Math.min(Math.max(0, pt.y - offsetY), Math.max(0, window.innerHeight - 60))}px`;
        e.preventDefault?.();
    };
    const end = () => {
        if (!dragging) return;
        dragging = false;
        saveLibraryDialogRect();
    };
    head.addEventListener('mousedown', start);
    head.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', end);
    document.addEventListener('touchend', end);
}

/** ⤢ 放大 / ⤡ 还原 */
function resizeLibraryDialog(mode) {
    const dialog = document.getElementById('ag-lib-dialog');
    if (!dialog) return;
    if (mode === 'big') {
        dialog.style.left = '4px';
        dialog.style.top = '4px';
        dialog.style.transform = 'none';
        dialog.style.width = `${window.innerWidth - 8}px`;
        dialog.style.height = `${window.innerHeight - 8}px`;
    } else {
        dialog.style.left = '50%';
        dialog.style.top = '8vh';
        dialog.style.transform = 'translateX(-50%)';
        dialog.style.width = 'min(760px, calc(100vw - 16px))';
        dialog.style.height = 'min(76vh, 720px)';
    }
    saveLibraryDialogRect();
}

/** 正文按内容自动撑高（超过 460px 才内部滚动） */
function autoSizeLibraryText(area) {
    if (!area) return;
    area.style.height = 'auto';
    const full = area.scrollHeight;
    area.style.height = `${Math.min(full, 460)}px`;
}
function scheduleLibrarySave() {
    if (librarySaveTimer) clearTimeout(librarySaveTimer);
    librarySaveTimer = setTimeout(async () => {
        librarySaveTimer = null;
        await persistLibrary(libraryBlocks);
        log('资料库已保存', { blocks: libraryCache.blocks.length, to: libraryCache.source });
    }, 700);
}

async function saveResults(filteredMap, keywords) {
    const settings = getSettings();
    const today = new Date().toISOString().split('T')[0];
    const plain = core.mapToPlainText(filteredMap, keywords);
    const out = { localSaved: false, personalitySaved: false };

    if (settings.saveToHusouLocal) {
        try {
            // 词条化：每个整理出来的对象一个词条；同名则**更新**（不重复堆叠）
            const sourcesByKeyword = state.lastSources || {};
            const keywordsByKw = state.lastKeywordsByKw || {};
            const incoming = core.knowledgeMapToEntries(filteredMap, { constant: false }).map((e) => ({
                ...e,
                sources: sourcesByKeyword[e.name] || [],
                keywords: core.mergeKeywords(keywordsByKw[e.name] || [], e.keywords, [e.name]),
            }));
            const merged = [...libraryCache.entries];
            for (const entry of incoming) {
                const idx = merged.findIndex((e) => e.name === entry.name);
                if (idx >= 0) {
                    merged[idx] = core.makeEntry({ ...entry, keywords: entry.keywords.length ? entry.keywords : merged[idx].keywords, constant: merged[idx].constant, disabled: merged[idx].disabled });
                } else {
                    merged.push(entry);
                }
            }
            const saved = await persistLibrary(merged);
            out.localSaved = true;
            out.savedTo = saved.saved;
            out.entries = incoming.length;
            diag('保存:资料库完成', { to: saved.saved, entries: libraryCache.entries.length, world: libraryWorldName() });
        } catch (err) {
            diag('保存:资料库失败', { error: errorInfo(err) }, 'error');
        }
    }

    if (settings.saveToPersonality) {
        try {
            const ctx = ctxGet();
            const character = ctx?.characters?.[ctx?.characterId];
            if (!character) throw makeError('SAVE_CHARACTER_MISSING', '无法取得当前角色卡，不能写入 personality');
            const block = `\n\n${core.buildSearchResultsInject(plain, settings.foxSearchHead, settings.foxSearchTail)}`;
            character.personality = `${core.stripSearchInjection(character.personality || '')}${block}`;
            out.personalitySaved = true;
            diag('保存:personality完成', { characterId: ctx?.characterId, appended: block.length });
        } catch (err) {
            diag('保存:personality失败', { error: errorInfo(err) }, 'error');
            toast(`❌ 写入角色卡 personality 失败：${err.message}`, 'error');
        }
    }
    return out;
}

/* ============================================================================
 * 注入（移植 husouInjectIntoPromptArray / 原预设的统一注入策略）
 * ==========================================================================*/

const SEARCH_RESULTS_BLOCK_RE = /\n*<SearchResults>[\s\S]*?<\/SearchResults>\n*/gi;

function collectPendingInject() {
    const settings = getSettings();
    // 本轮新搜到的结果：总是注入一次（这是搜索的意义所在）
    if (state.pendingInject) return state.pendingInject;
    if (!settings.injectCurrentPrompt) return '';
    // 资料库：默认交给世界书自己按绿灯/关键词注入，插件不再重复注入（避免双份）
    if ((settings.libraryInject || 'worldbook') !== 'plugin') return '';
    const stored = loadLocalText();
    if (!stored) return '';
    return `\n\n${core.buildSearchResultsInject(stored, settings.foxSearchHead, settings.foxSearchTail)}\n`;
}

function injectIntoPromptArray(promptArray) {
    if (state.internalCall) return false;
    if (!Array.isArray(promptArray)) return false;
    const block = collectPendingInject();
    if (!block) return false;

    for (const message of promptArray) {
        if (message && typeof message.content === 'string') {
            message.content = message.content.replace(SEARCH_RESULTS_BLOCK_RE, '\n');
        }
    }

    // 优先塞进预留的 <fox_extra></fox_extra>
    for (const message of promptArray) {
        if (!message || typeof message.content !== 'string') continue;
        const match = message.content.match(/<\s*fox_extra\b[^>]*>([\s\S]*?)<\s*\/\s*fox_extra\s*>/i);
        if (!match) continue;
        message.content = message.content.replace(match[0], `<fox_extra>${match[1]}${block}</fox_extra>`);
        log('已注入到 <fox_extra> 内部');
        return true;
    }

    // 回退：插在最后一条 system 之后
    let index = promptArray.findIndex((m) => m?.role === 'system' && typeof m?.content === 'string');
    index = index >= 0 ? index + 1 : 0;
    promptArray.splice(index, 0, { role: 'system', content: block.trim() });
    log('已按回退策略插入 prompt 数组', index);
    return true;
}

function registerInjectionHooks() {
    const generateAfterData = eventTypes().GENERATE_AFTER_DATA;
    if (generateAfterData) {
        bus()?.on(generateAfterData, (data) => {
            try {
                if (Array.isArray(data?.prompt)) injectIntoPromptArray(data.prompt);
            } catch (err) {
                console.error(LOG_PREFIX, 'GENERATE_AFTER_DATA 注入失败', err);
            }
        });
    }
    const promptReady = eventTypes().CHAT_COMPLETION_PROMPT_READY;
    if (promptReady) {
        bus()?.on(promptReady, (data) => {
            try {
                if (Array.isArray(data?.chat)) injectIntoPromptArray(data.chat);
            } catch (err) {
                console.error(LOG_PREFIX, 'CHAT_COMPLETION_PROMPT_READY 注入失败', err);
            }
        });
    }
    // 生成结束后清掉一次性注入，避免重复膨胀
    const generated = eventTypes().GENERATION_ENDED;
    if (generated) {
        bus()?.on(generated, () => {
            if (state.pendingInject) {
                state.pendingInject = '';
                log('本轮注入已消费');
            }
        });
    }
}

function registerAutoSearchHooks() {
    const sent = eventTypes().MESSAGE_SENT;
    if (!sent) return;
    bus()?.on(sent, async () => {
        try {
            const settings = getSettings();
            if (settings.autoMode === 'manual') return;
            if (state.internalCall) return;
            state.sendCount += 1;
            const interval = Math.max(1, Number(settings.autoInterval) || 5);
            if (settings.autoMode === 'interval' && state.sendCount % interval !== 0) return;
            await executeSearch({ manual: false });
        } catch (err) {
            console.error(LOG_PREFIX, '发送时自动搜索失败', err);
        }
    });
}

/* ============================================================================
 * 面板 UI
 * ==========================================================================*/

function $(selector, root = document) {
    return root.querySelector(selector);
}

function bindInput(selector, key, type = 'text') {
    // 绑定「所有」同名元素：面板万一被挂载两次（或历史版本残留节点）也不会绑到看不见的那个
    const nodes = Array.from(document.querySelectorAll(selector));
    if (!nodes.length) return;
    const settings = getSettings();
    const eventName = type === 'checkbox' || type === 'select' ? 'change' : 'input';
    for (const el of nodes) {
        if (el.dataset.foxBound === '1') continue;
        el.dataset.foxBound = '1';
        if (type === 'checkbox') el.checked = !!settings[key];
        else el.value = settings[key] ?? '';
        const commit = () => {
            if (type === 'checkbox') settings[key] = !!el.checked;
            else if (type === 'number') settings[key] = Number(el.value);
            else settings[key] = el.value;
            persistSettings();
            if (key === 'searchApiUrl') updateSearchUrlHint();
        };
        el.addEventListener(eventName, commit);
        if (type === 'select') el.addEventListener('change', commit);
    }
    if (key === 'searchApiUrl') updateSearchUrlHint();
}

/** 实时显示「搜索实际会用的地址」，避免填到另一个「API 地址」栏还不自知 */
function updateSearchUrlHint() {
    const hint = $('#ag-api-url-hint');
    if (!hint) return;
    const settings = getSettings();
    const rawUrl = String(settings.searchApiUrl || '').trim();
    if (!rawUrl) {
        hint.textContent = '⚠️ 还没有搜索地址：打开自定义来源后必须填这里，否则搜不了。';
        return;
    }
    let host = '';
    try {
        host = new URL(rawUrl.replace(/\{keyword\}/g, 'x').replace(/\{language\}/g, 'x')).hostname;
    } catch { /* ignore */ }
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);
    const pageHost = window.location?.hostname || '';
    const pageLocal = ['localhost', '127.0.0.1', '::1'].includes(pageHost);
    let warn = '';
    if (loopback && !pageLocal) {
        warn = `　⚠️ 当前页面在 ${pageHost}，localhost 指的是这台设备自己，手机访问时请填电脑的局域网 IP 或内网穿透地址。`;
    }
    hint.textContent = `当前搜索实际会用：${rawUrl}${warn}`;
    hint.style.color = warn ? 'var(--SmartThemeWarningColor, #ffb3b3)' : 'var(--SmartThemeQuoteColor, #f0a070)';
}

/**
 * 用「输入框里此刻的值」直接测一次搜索地址。
 * 故意不读 extension_settings —— 这样即使用户填错了栏位、或另一个页面手里是旧设置，
 * 也能立刻看出「我填的这个地址到底通不通、返回能不能被解析」。
 */
async function testSearchUrlFromPanel() {
    const input = document.querySelector('#ag-api-url');
    const rawUrl = String(input?.value || '').trim();
    if (!rawUrl) {
        toast('⚠️ 「① 搜索用的 API 地址」是空的，先填上再测', 'warning');
        return false;
    }
    const probe = core.normalizeSettings({ ...getSettings(), searchApiUrl: rawUrl });
    let req;
    try {
        req = core.buildCustomRequest('测试', probe);
    } catch (err) {
        toast(`❌ 地址无法构造：${err.message}`, 'error');
        return false;
    }
    toast(`🔌 正在测：${core.safeUrl(req.url)}`, 'info');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(probe.searchTimeout) || 20000);
    try {
        const res = await fetch(req.url, { method: req.method, headers: req.headers, signal: controller.signal });
        const text = await res.text();
        if (!res.ok) {
            toast(`❌ HTTP ${res.status}：${text.slice(0, 160)}`, 'error');
            return false;
        }
        const mapped = core.mapCustomResults(JSON.parse(text), probe);
        if (mapped.error) {
            toast(`❌ 连通但字段映射失败：${mapped.error}（结果路径=${probe.searchApiResultPath}）`, 'error');
            return false;
        }
        if (!mapped.lines.length) {
            toast(`⚠️ 连通了，但映射出 0 条（原始 ${mapped.rawCount} 条）：检查 结果路径 / 标题字段 / 摘要字段`, 'warning');
            return false;
        }
        toast(`✅ 地址可用：映射出 ${mapped.lines.length} 条（原始 ${mapped.rawCount} 条）\n示例：${mapped.lines[0].slice(0, 80)}`, 'success');
        // 测通了就顺手把这地址写进设置（用户此刻的意图就是要用它）
        if (rawUrl !== getSettings().searchApiUrl) {
            const store = extSettings();
            store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), searchApiUrl: rawUrl, enableCustomSearch: true });
            state.settings = store[MODULE];
            saveSettings();
            updateSearchUrlHint();
            toast('🦊 已把这地址保存为搜索地址', 'success');
        }
        return true;
    } catch (err) {
        const hint =
            err?.name === 'AbortError'
                ? `（超过 ${probe.searchTimeout}ms 没响应）`
                : '（先在手机浏览器直接打开这个地址，能出 JSON 才说明网络通）';
        toast(`❌ 测不通：${err.message} ${hint}`, 'error');
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 从服务器重新载入酒馆设置。
 * 场景：在电脑上改了设置（写进了服务器 settings.json），手机上那个已经打开的页面还是旧副本，
 * 不刷新就永远看到旧值 —— 之前用户遇到的就是这个。
 */
async function reloadSettingsFromServer() {
    try {
        const res = await fetch('/api/settings/get', {
            method: 'POST',
            headers: { ...(stCore.getRequestHeaders?.() || { 'Content-Type': 'application/json' }) },
            body: JSON.stringify({}),
        });
        if (!res.ok) throw makeError('SETTINGS_HTTP_ERROR', `HTTP ${res.status}`);
        const data = await res.json();
        const incoming = data?.extension_settings?.[MODULE];
        if (!incoming || typeof incoming !== 'object') {
            toast('⚠️ 服务器设置里没有Agent 搜索配置（可能是还没保存过）', 'warning');
            return false;
        }
        const store = extSettings();
        const target = store[MODULE] && typeof store[MODULE] === 'object' ? store[MODULE] : {};
        Object.assign(target, core.normalizeSettings(incoming));
        store[MODULE] = target;
        state.settings = target;
        refreshPanel();
        updateSearchUrlHint();
        toast(`🦊 已从服务器重载设置（当前搜索地址：${core.safeUrl(String(target.searchApiUrl || ''))}）`, 'success');
        return true;
    } catch (err) {
        toast(`❌ 重载设置失败：${err.message}`, 'error');
        return false;
    }
}
function refreshPanel() {
    const settings = getSettings();
    bindInput('#ag-auto-mode', 'autoMode', 'select');
    bindInput('#ag-auto-interval', 'autoInterval', 'number');
    bindInput('#ag-background-silent', 'backgroundSilent', 'checkbox');
    bindInput('#ag-send-analyze', 'sendAnalyze', 'checkbox');

    bindInput('#ag-enable-wikipedia', 'enableWikipedia', 'checkbox');
    bindInput('#ag-enable-moegirl', 'enableMoegirl', 'checkbox');
    bindInput('#ag-enable-custom', 'enableCustomSearch', 'checkbox');
    bindInput('#ag-provider-mode', 'providerMode', 'select');
    bindInput('#ag-reader-max-urls', 'readerMaxUrls', 'number');
    bindInput('#ag-reader-max-chars', 'readerMaxChars', 'number');
    bindInput('#ag-reader-pages', 'readerPagesPerSource', 'number');
    bindInput('#ag-enable-jina', 'enableJinaFetch', 'checkbox');
    bindInput('#ag-enable-jina-prefilter', 'enableJinaPrefilter', 'checkbox');

    bindInput('#ag-max-keywords', 'maxKeywords', 'number');
    bindInput('#agent-search-results-count', 'searchResultsCount', 'number');
    bindInput('#ag-source-top-pages', 'sourceTopPages', 'number');
    bindInput('#ag-source-extract-chars', 'sourceExtractChars', 'number');
    bindInput('#agent-search-timeout', 'searchTimeout', 'number');
    bindInput('#ag-max-extract-length', 'maxExtractLength', 'number');
    bindInput('#ag-jina-page-timeout', 'jinaPageTimeout', 'number');
    bindInput('#ag-context-floors', 'contextFloors', 'number');
    bindInput('#ag-jina-max-urls', 'jinaMaxUrlsPerKeyword', 'number');
    bindInput('#ag-jina-max-total', 'jinaMaxUrlsTotal', 'number');
    bindInput('#ag-jina-concurrency', 'jinaConcurrency', 'number');
    bindInput('#ag-jina-budget', 'jinaTotalBudgetMs', 'number');
    bindInput('#ag-jina-min-length', 'jinaMinTextLength', 'number');

    bindInput('#ag-api-url', 'searchApiUrl');
    bindInput('#ag-api-method', 'searchApiMethod', 'select');
    bindInput('#ag-api-key', 'searchApiKey');
    bindInput('#ag-api-key-header', 'searchApiKeyHeaderName');
    bindInput('#ag-api-key-template', 'searchApiKeyHeaderTemplate');
    bindInput('#ag-api-query-param', 'searchApiQueryParam');
    bindInput('#ag-api-body-template', 'searchApiBodyTemplate');
    bindInput('#ag-api-result-path', 'searchApiResultPath');
    bindInput('#ag-api-title-field', 'searchApiTitleField');
    bindInput('#ag-api-snippet-field', 'searchApiSnippetField');
    bindInput('#ag-api-link-field', 'searchApiLinkField');
    bindInput('#ag-api-language', 'searchApiLanguage');
    bindInput('#ag-api-extra-params', 'searchApiExtraParams');

    bindInput('#ag-enable-content-filter', 'enableContentFilter', 'checkbox');
    bindInput('#ag-include-starts', 'includeTagStarts');
    bindInput('#ag-include-ends', 'includeTagEnds');
    bindInput('#ag-exclude-starts', 'excludeTagStarts');
    bindInput('#ag-exclude-ends', 'excludeTagEnds');

    bindInput('#ag-smart-skip', 'smartSkip', 'checkbox');
    bindInput('#ag-ai-filter', 'aiFilter', 'checkbox');
    bindInput('#ag-filter-mode', 'filterMode', 'select');

    bindInput('#ag-save-local', 'saveToHusouLocal', 'checkbox');
    bindInput('#ag-library-storage', 'libraryStorage', 'select');
    bindInput('#ag-library-inject', 'libraryInject', 'select');
    populateWorldNameSelect();
    bindInput('#ag-save-personality', 'saveToPersonality', 'checkbox');
    bindInput('#ag-inject-current', 'injectCurrentPrompt', 'checkbox');

    bindInput('#ag-analysis-api', 'analysisApi', 'select');
    bindInput('#ag-custom-api-url', 'customApiUrl');
    bindInput('#ag-custom-api-key', 'customApiKey');
    bindInput('#ag-custom-model', 'customModel');
    bindInput('#ag-custom-max-tokens', 'customMaxTokens', 'number');
    bindInput('#ag-reasoning-effort', 'analysisReasoningEffort', 'select');
    bindInput('#ag-custom-temperature', 'customTemperature', 'number');
    bindInput('#ag-analysis-max-chars', 'analysisMaxInputChars', 'number');

    bindInput('#ag-user-preference', 'userPreferenceText');
    bindInput('#ag-inject-head', 'foxSearchHead');
    bindInput('#ag-inject-tail', 'foxSearchTail');
    bindInput('#ag-debug-log', 'debugLog', 'checkbox');

    renderModelChips();
}

/* ============================================================================
 * 模型列表：自动从 /models 拉取，点选即可（不再手打模型名）
 * ==========================================================================*/

/** 由 chat/completions 地址推导出 /models 地址（实现在 ag-core，便于单测） */
const modelsEndpoint = (apiUrl) => core.modelsEndpoint(apiUrl);

/** 兼容各家 /models 返回结构（实现在 ag-core） */
const parseModelIds = (json) => core.parseModelIds(json);

function modelCacheKey() {
    return String(getSettings().customApiUrl || '').trim();
}

function renderModelChips() {
    const box = $('#ag-model-chips');
    const datalist = $('#ag-model-list');
    const status = $('#ag-model-status');
    if (!box) return;

    const settings = getSettings();
    const cache = settings.__modelListCache;
    const models = cache && cache.url === modelCacheKey() && Array.isArray(cache.models) ? cache.models : [];

    if (!models.length) {
        box.innerHTML = '';
        if (datalist) datalist.innerHTML = '';
        if (status && !status.textContent) {
            status.textContent = '还没拉取模型列表：填好 API 地址和 Key 后点「🔄 拉取模型列表」。';
        }
        return;
    }

    const current = String(settings.customModel || '');
    box.innerHTML = models
        .map(
            (m) =>
                `<span class="ag-model-chip${m === current ? ' is-active' : ''}" data-model="${escapeHtml(m)}" title="${escapeHtml(m)}">${escapeHtml(m)}</span>`,
        )
        .join('');
    if (datalist) {
        datalist.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    }
    box.querySelectorAll('.ag-model-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const model = chip.dataset.model || '';
            const input = $('#ag-custom-model');
            if (input) input.value = model;
            state.settings.customModel = model;
            persistSettings();
            renderModelChips();
            toast(`🦊 分析模型已设为：${model}`, 'success');
        });
    });
    if (status) {
        const at = cache?.at ? new Date(cache.at).toLocaleString() : '';
        status.textContent = `已拉取 ${models.length} 个模型${at ? `（${at}）` : ''}，点一下即可选用。`;
    }
}

async function fetchModelList({ silent = false } = {}) {
    const settings = getSettings();
    const url = modelsEndpoint(settings.customApiUrl);
    if (!url) {
        if (!silent) toast('⚠️ 先填「自定义 API 地址」，才能推导出 /models', 'warning');
        return [];
    }
    const headers = { Accept: 'application/json' };
    const key = String(settings.customApiKey || '').trim();
    if (key) headers.Authorization = `Bearer ${key}`;

    const status = $('#ag-model-status');
    if (status) status.textContent = `正在请求 ${safeDisplayUrl(url)} …`;

    try {
        const res = await fetchWithTimeout(url, { headers }, 20000);
        const text = await res.text();
        if (!res.ok) {
            throw makeError('MODELS_HTTP_ERROR', `HTTP ${res.status}（${safeDisplayUrl(url)}）`, { preview: text.slice(0, 200) });
        }
        let models = [];
        try {
            models = parseModelIds(JSON.parse(text));
        } catch {
            throw makeError('MODELS_JSON_INVALID', '模型列表返回不是合法 JSON', { preview: text.slice(0, 200) });
        }
        if (!models.length) throw makeError('MODELS_EMPTY', '接口通了，但没有解析到任何模型 id');

        state.settings.__modelListCache = { url: modelCacheKey(), models, at: Date.now() };
        persistSettings();
        renderModelChips();
        diag('模型列表:完成', { url: safeDisplayUrl(url), count: models.length });
        if (!silent) toast(`🦊 已拉取 ${models.length} 个模型，点一下就能选`, 'success');
        return models;
    } catch (err) {
        diag('模型列表:失败', { url: safeDisplayUrl(url), error: errorInfo(err) }, 'error');
        if (status) status.textContent = `拉取失败：${err.message}`;
        if (!silent) toast(`❌ 拉取模型列表失败：${err.message}`, 'error');
        return [];
    }
}

function safeDisplayUrl(url) {
    try {
        const u = new URL(String(url));
        return `${u.origin}${u.pathname}`;
    } catch {
        return String(url || '');
    }
}

/** 设置面板里的「绑定世界书」下拉：从服务器拉列表 */
async function populateWorldNameSelect() {
    const sel = $('#ag-library-world-name');
    if (!sel) return;
    const current = libraryWorldName();
    let worlds = libraryCache.worlds || [];
    if (!worlds.length) {
        try {
            worlds = await listWorldBooks();
            libraryCache.worlds = worlds;
        } catch { /* 服务器不可用时只显示当前值 */ }
    }
    const options = [...new Set([current, ...worlds])].filter(Boolean);
    sel.innerHTML = options.map((w) => `<option value="${escapeHtml(w)}"${w === current ? ' selected' : ''}>${escapeHtml(w)}</option>`).join('');
    if (!sel.dataset.foxBound) {
        sel.dataset.foxBound = '1';
        sel.addEventListener('change', async () => {
            const store = extSettings();
            store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), libraryWorldName: sel.value, libraryStorage: 'server' });
            state.settings = store[MODULE];
            saveSettings();
            await refreshLibrary({ notify: true });
        });
    }
}
function mountSettingsPanel() {
    const container = $('#extensions_settings') || $('#extensions_settings2');
    if (!container) {
        console.warn(LOG_PREFIX, '未找到扩展设置容器，面板未挂载');
        return Promise.resolve(false);
    }
    if ($('#agent-search-settings')) return Promise.resolve(true);

    return loadPanelHtml()
        .then((html) => {
            // 关键：绝不把 undefined/null 插进 DOM（否则界面上会多出一行字面量 "undefined"）
            if (typeof html !== 'string' || !html.trim()) {
                console.error(LOG_PREFIX, '设置面板 HTML 为空，已跳过插入（避免出现 undefined 行）');
                return false;
            }
            container.insertAdjacentHTML('beforeend', html);
            if (!$('#agent-search-settings')) {
                console.error(LOG_PREFIX, '设置面板插入后仍未找到根节点，请检查 settings.html');
                return false;
            }
            refreshPanel();
            bindPanelButtons();
            // 自定义连接已填好但还没拉过模型列表 → 静默拉一次，省得手打模型名
            const s = getSettings();
            if (s.analysisApi === 'custom' && s.customApiUrl && !s.__modelListCache) {
                fetchModelList({ silent: true });
            }
            log('设置面板已挂载');
            return true;
        })
        .catch((err) => {
            console.error(LOG_PREFIX, '设置面板挂载失败', err);
            return false;
        });
}

function openSettingsPanel() {
    mountSettingsPanel();
    setTimeout(() => {
        const el = document.querySelector('#agent-search-settings .inline-drawer-toggle, #agent-search-settings');
        if (el && !el.closest('.inline-drawer')?.classList.contains('openIcon')) {
            el.click?.();
        }
        el?.scrollIntoView?.({ block: 'center' });
        const drawer = document.querySelector('#agent-search-settings .inline-drawer-toggle');
        const body = document.querySelector('#agent-search-settings .inline-drawer-content');
        if (body) body.style.display = 'block';
        if (drawer) drawer.classList.add('openIcon');
    }, 120);
}

async function runSelfCheck() {
    const settings = getSettings();
    const lines = [];
    const push = (ok, text) => lines.push(`${ok === true ? '✅' : ok === false ? '❌' : '•'} ${text}`);

    // 0) 重复安装检测：装了两份扩展时两份各有一块面板/控制台，很容易改了一份、自检跑了另一份
    const instances = globalThis.__foxSearchInstances || [];
    push(
        instances.length <= 1,
        instances.length <= 1
            ? `扩展实例：1 个（${instances[0] || extRelPath()}）`
            : `扩展实例：${instances.length} 个 → ${instances.join('、')}；请删掉多余文件夹，否则会出现「改了地址却还是旧地址」`,
    );

    push(settings.enableWikipedia || settings.enableMoegirl || settings.enableCustomSearch ? true : false,
        `搜索源：Wikipedia=${settings.enableWikipedia ? '开' : '关'}，萌娘百科=${settings.enableMoegirl ? '开' : '关'}，自定义来源=${settings.enableCustomSearch ? '开' : '关'}`);
    push(settings.aiFilter ? true : null, `AI 过滤=${settings.aiFilter ? '开' : '关'}，Jina 全文抓取=${settings.enableJinaFetch ? '开' : '关'}`);
    push(true, `分析模型：整理方式=${settings.providerMode || 'reader'}，max_tokens=${settings.customMaxTokens}，reasoning_effort=${settings.analysisReasoningEffort || '（不干预）'}`);
    if (settings.enableCustomSearch) {
        const rawUrl = String(settings.searchApiUrl || '').trim();
        push(!!rawUrl, rawUrl ? `自定义来源地址（当前生效）：${core.safeUrl(rawUrl)}` : '未配置自定义来源地址');

        let req = null;
        if (rawUrl) {
            try {
                req = core.buildCustomRequest('测试', settings);
            } catch (err) {
                push(false, `地址构造失败：${err.message}`);
            }
        }

        // localhost 误用检测：手机上 localhost 指的是手机自己
        if (req) {
            let host = '';
            try {
                host = new URL(req.url).hostname;
            } catch { /* ignore */ }
            const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(host);
            const pageHost = window.location?.hostname || '';
            const pageLocal = ['localhost', '127.0.0.1', '::1'].includes(pageHost);
            if (isLoopback && !pageLocal) {
                push(false, `地址用的是 ${host}，但页面在 ${pageHost} —— 手机上 localhost 指的是手机自己，请填电脑的局域网 IP 或内网穿透地址`);
            }
            push(true, `本次实际请求：${req.method} ${core.safeUrl(req.url)}`);
        }

        if (req) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Number(settings.searchTimeout));
            try {
                const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined, signal: controller.signal });
                const text = await res.text();
                let ok = res.ok;
                let extra = `HTTP ${res.status}`;
                if (ok) {
                    try {
                        const mapped = core.mapCustomResults(JSON.parse(text), settings);
                        extra += `，映射出 ${mapped.lines.length} 条（原始 ${mapped.rawCount} 条）`;
                        ok = !mapped.error && mapped.lines.length > 0;
                        if (mapped.error) extra += ` — ${mapped.error}`;
                    } catch (e) {
                        ok = false;
                        extra += `，JSON 解析失败：${e.message}（SearXNG 需在 settings.yml 里开 formats: [html, json]）`;
                    }
                }
                push(ok, `自定义来源连通性：${extra}`);
            } catch (err) {
                const hint =
                    err?.name === 'AbortError'
                        ? `（超过 ${settings.searchTimeout}ms 未响应：地址不通或太慢）`
                        : '（Failed to fetch 一般是 地址写错/端口不通/被网络拦/证书问题；先拿手机浏览器直接打开该地址试试）';
                push(false, `自定义来源连通性失败：${err.message} ${hint}`);
            } finally {
                clearTimeout(timer);
            }
        }
    }
    {
        const mirror = readSettingsMirror();
        const cur = getSettings();
        const at = (v) => (v ? new Date(v).toLocaleTimeString() : '无');
        push(true, `设置保存：服务器 ${at(cur.__savedAt)} / 本地镜像 ${at(mirror?.__savedAt)}（镜像更新时会自动采用）`);
    }
    push(state.running ? false : true, state.running ? '当前有搜索任务在跑' : '当前无搜索任务');
    const lib = loadLocalText();
    const libWhere =
        libraryCache.source === 'server'
            ? `酒馆服务器 · 世界书「${libraryWorldName()}」（跨设备共用）`
            : libraryCache.source === 'local-fallback'
              ? `本浏览器（服务器读取失败：${libraryCache.error || '未知'}）`
              : '仅本浏览器 localStorage';
    push(libraryCache.source !== 'local-fallback', `资料库（${libWhere}）：${libraryCache.blocks.length} 条 / ${lib.length} 字符`);

    state.diagnostics.push({ ts: new Date().toISOString(), title: '自检', payload: { lines } });
    toast(`🦊 自检结果\n${lines.join('\n')}`, lines.some((l) => l.startsWith('❌')) ? 'warning' : 'success');
    return lines;
}

function updateQuickPanel() {
    const panel = $('#ag-quick-panel');
    if (!panel) return;
    const settings = getSettings();
    const status = $('#ag-quick-status');
    if (status) {
        const text = state.running ? '搜索中（可点取消）' : settings.autoMode === 'manual' ? '待机·手动' : `待机·自动(${settings.autoMode})`;
        status.textContent = `状态：${text}`;
        status.style.color = state.running ? '#f0a070' : '#c8b8ae';
    }
    const btn = $('#ag-quick-run');
    if (btn) btn.textContent = state.running ? '⏹ 取消' : '🔎 搜索';
    const info = $('#ag-quick-info');
    if (info) {
        const map = state.lastResult?.filteredMap;
        info.textContent = map ? `上次：${map.size} 条 / ${state.lastResult?.keywords?.length || 0} 关键词` : '';
    }
}

function updateKeywordPanel(keywords) {
    const panel = $('#ag-keyword-panel');
    if (!panel) return;
    if (!keywords?.length) {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = 'block';
    const count = $('#ag-keyword-count');
    const list = $('#ag-keyword-list');
    if (count) count.textContent = `共 ${keywords.length} 个`;
    if (list) list.textContent = keywords.join('、');
    panel._hideTimer && clearTimeout(panel._hideTimer);
    panel._hideTimer = setTimeout(() => {
        panel.style.display = 'none';
    }, 8000);
}

/**
 * 手动搜索执行器：面板顶部区块与悬浮窗共用。
 * 手机上悬浮窗可能被酒馆底栏遮住，所以面板内的入口必须是一等公民。
 */
async function runManualSearchUi({ inputSel, previewSel, statusSel }) {
    if (state.running) {
        state.abortController?.abort();
        toast('🦊 正在取消Agent 搜索…', 'info');
        return;
    }
    const input = document.querySelector(inputSel);
    const preview = document.querySelector(previewSel);
    const status = document.querySelector(statusSel);
    const setStatus = (text, color) => {
        if (!status) return;
        status.textContent = text;
        if (color) status.style.color = color;
    };

    const keywords = core.normalizeKeywords(input?.value || '');
    setStatus(
        keywords.length ? `状态：搜索中…（关键词：${keywords.join('、')}）` : '状态：搜索中…（正在让模型从上下文提取关键词）',
        'var(--SmartThemeQuoteColor, #f0a070)',
    );
    if (preview) preview.value = '搜索中…';

    const ok = await executeSearch({ keywords, manual: true });
    const last = state.lastResult;
    updateQuickPanel();

    if (!ok) {
        const summary = summarizeTasks(last?.summary);
        setStatus(`状态：本次无新信息或无结果\n${summary}`, 'var(--SmartThemeBodyColor, #e8e0da)');
        if (preview) preview.value = `本次无新信息\n${summary}`;
        return;
    }
    setStatus(
        `状态：完成 ✅ ${last.keywords.length} 个关键词，${last.filteredMap.size} 条资料（已就绪注入本轮生成）`,
        'var(--SmartThemeQuoteColor, #f0a070)',
    );
    if (preview) {
        preview.value = `关键词：${last.keywords.join('、')}\n${summarizeTasks(last.summary)}\n\n${core.mapToPlainText(last.filteredMap, last.keywords)}`;
    }
}
/**
 * 确保悬浮入口在视口里。
 *
 * ⚠️ 悬浮按钮按钮只能「挪位置」，**绝对不能改尺寸** ——
 * 之前这里对按钮也套了 width/maxHeight 兜底，结果把 52px 圆按钮拉成了一条宽圆角矩形（用户看到的"椭圆占满"）。
 * 只有展开的面板才允许做尺寸兜底。
 */
function ensureQuickPanelVisible({ quiet = true } = {}) {
    const fab = document.querySelector('#ag-quick-fab');
    const panel = document.querySelector('#ag-quick-panel');
    const target = fab || panel;
    if (!target) return { ok: false, reason: 'panel-not-found' };

    const vw = window.innerWidth || document.documentElement.clientWidth || 360;
    const vh = window.innerHeight || document.documentElement.clientHeight || 640;

    const moveToHtmlIfTransformed = (el) => {
        try {
            let node = el.parentElement;
            while (node && node !== document.body && node !== document.documentElement) {
                const s = getComputedStyle(node);
                if (s.transform && s.transform !== 'none') {
                    document.documentElement.appendChild(el);
                    diag('悬浮窗:祖先有 transform，已改挂到 <html>', { ancestor: node.id || node.tagName });
                    return true;
                }
                node = node.parentElement;
            }
        } catch { /* ignore */ }
        return false;
    };

    // ===== 1) 悬浮按钮按钮：只修位置与圆形兜底，尺寸固定 52×52 =====
    if (fab) {
        Object.assign(fab.style, {
            position: 'fixed',
            zIndex: '2147483000',
            display: 'flex',
            width: '52px',
            height: '52px',
            minWidth: '52px',
            maxWidth: '52px',
            minHeight: '52px',
            maxHeight: '52px',
            borderRadius: '50%',
            alignItems: 'center',
            justifyContent: 'center',
        });
        // 兜底配色（幂等）
        try {
            const cs0 = getComputedStyle(fab);
            if (!cs0.backgroundColor || cs0.backgroundColor === 'rgba(0, 0, 0, 0)' || cs0.backgroundColor === 'transparent') {
                fab.style.background = '#e8784a';
                fab.style.color = '#1b1512';
                fab.style.border = '2px solid rgba(255,255,255,0.35)';
                fab.style.fontSize = '26px';
                fab.style.boxShadow = '0 6px 18px rgba(0,0,0,0.45)';
            }
        } catch { /* ignore */ }

        moveToHtmlIfTransformed(fab);

        const r = fab.getBoundingClientRect();
        const offscreen =
            r.width < 20 ||
            r.height < 20 ||
            r.bottom < 20 ||
            r.right < 20 ||
            r.top > vh - 20 ||
            r.left > vw - 20;
        if (offscreen) {
            fab.style.left = 'auto';
            fab.style.top = 'auto';
            fab.style.right = '12px';
            fab.style.bottom = '96px';
            const store = extSettings();
            store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), quickFabPos: null });
            state.settings = store[MODULE];
            saveSettings();
            diag('悬浮窗:悬浮按钮在视口外，已复位到右下角', { before: { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width) }, vw, vh }, 'warn');
            if (!quiet) toast('🦊 悬浮按钮已复位到右下角', 'warning');
        }
        const after = fab.getBoundingClientRect();
        return { ok: true, offscreen, rect: { top: Math.round(after.top), left: Math.round(after.left), width: Math.round(after.width), height: Math.round(after.height) }, vw, vh };
    }

    // ===== 2) 展开的面板：允许尺寸兜底 =====
    Object.assign(panel.style, { position: 'fixed', zIndex: '2147483000' });
    try {
        const cs0 = getComputedStyle(panel);
        const transparent = !cs0.backgroundColor || cs0.backgroundColor === 'rgba(0, 0, 0, 0)' || cs0.backgroundColor === 'transparent';
        const r0 = panel.getBoundingClientRect();
        if (transparent || r0.height < 20) {
            Object.assign(panel.style, {
                background: 'rgba(24,19,17,0.97)',
                color: '#f0e8e2',
                border: '1px solid #e8784a',
                borderRadius: '14px',
                boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            });
            diag('悬浮窗:面板样式未生效，已套用内联兜底', { height: Math.round(r0.height) }, 'warn');
        }
    } catch { /* ignore */ }

    moveToHtmlIfTransformed(panel);

    const r = panel.getBoundingClientRect();
    const offscreen = r.width < 40 || r.height < 20 || r.bottom < 50 || r.top > vh - 50 || r.right < 50 || r.left > vw - 50;
    if (offscreen) {
        Object.assign(panel.style, {
            left: '8px',
            top: '8px',
            right: 'auto',
            bottom: 'auto',
            width: `${Math.min(340, vw - 16)}px`,
            maxHeight: `${Math.max(200, vh - 20)}px`,
            overflowY: 'auto',
        });
        diag('悬浮窗:面板原来在视口外，已挪到左上角', { before: { t: Math.round(r.top), l: Math.round(r.left) }, vw, vh }, 'warn');
        if (!quiet) toast('🦊 面板原来跑到视口外了，已挪到左上角', 'warning');
    }
    const after = panel.getBoundingClientRect();
    return { ok: true, offscreen, rect: { top: Math.round(after.top), left: Math.round(after.left), width: Math.round(after.width), height: Math.round(after.height) }, vw, vh };
}

/** 一键诊断：把悬浮窗的真实状态打出来，用户复制给作者即可定位 */
function diagnoseQuickPanel() {
    const panel = document.querySelector('#ag-quick-fab');
    const lines = [];
    lines.push(`悬浮按钮按钮：${panel ? '存在' : '不存在'}`);
    lines.push(`展开面板：${document.querySelector('#ag-quick-panel') ? '已创建' : '未创建'}`);
    if (panel) {
        const r = panel.getBoundingClientRect();
        const cs = getComputedStyle(panel);
        lines.push(`位置尺寸：left=${Math.round(r.left)} top=${Math.round(r.top)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
        lines.push(`视口：${window.innerWidth}x${window.innerHeight}`);
        lines.push(`display=${panel.style.display || cs.display} position=${cs.position} z-index=${cs.zIndex}`);
        lines.push(`父节点：${panel.parentElement?.tagName}${panel.parentElement?.id ? '#' + panel.parentElement.id : ''}`);
        const chained = (() => {
            let el = panel.parentElement;
            const bad = [];
            while (el) {
                const s = getComputedStyle(el);
                if (s.transform && s.transform !== 'none') bad.push(`${el.tagName}${el.id ? '#' + el.id : ''}(transform)`);
                if (s.overflow && s.overflow !== 'visible') bad.push(`${el.tagName}${el.id ? '#' + el.id : ''}(overflow:${s.overflow})`);
                el = el.parentElement;
            }
            return bad.slice(0, 6);
        })();
        lines.push(`可疑祖先：${chained.length ? chained.join('、') : '无'}`);
        lines.push(`悬浮按钮按钮：${document.querySelector('#ag-quick-fab') ? '在' : '不在'}；展开面板：${document.querySelector('#ag-quick-panel') ? '已创建' : '未创建'}；搜索按钮：${document.querySelector('#ag-quick-run') ? '在' : '不在'}`);
    }
    const text = lines.join('\n');
    console.log(LOG_PREFIX, '悬浮窗诊断\n', text);
    state.diagnostics.push({ ts: new Date().toISOString(), title: '悬浮窗诊断', payload: { text } });
    toast(`🦊 悬浮窗诊断\n${text}`, 'info');
    return text;
}
/**
 * 悬浮入口 = **一个悬浮按钮按钮**（不是一条横框）。
 * 平时只显示 🦊 圆按钮；点它才展开搜索面板，再点一次收起。
 * 按钮可拖动（鼠标 + 触摸），位置与展开状态都记住，跨设备同步。
 */
function buildQuickPanel() {
    if ($('#ag-quick-fab')) return;

    // —— 悬浮按钮按钮：关键样式内联写死，这样即使样式表没加载/被缓存，也永远是右下角一个圆形按钮
    const fab = document.createElement('div');
    fab.id = 'ag-quick-fab';
    fab.title = 'Agent 搜索：点击展开 / 收起';
    fab.textContent = '🦊';
    Object.assign(fab.style, {
        position: 'fixed',
        right: '12px',
        bottom: '96px',
        left: 'auto',
        top: 'auto',
        width: '52px',
        height: '52px',
        minWidth: '52px',
        maxWidth: '52px',
        minHeight: '52px',
        maxHeight: '52px',
        boxSizing: 'border-box',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '26px',
        lineHeight: '1',
        padding: '0',
        cursor: 'pointer',
        zIndex: '2147483000',
        background: '#e8784a',
        color: '#1b1512',
        border: '2px solid rgba(255,255,255,0.35)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
        userSelect: 'none',
        touchAction: 'none',
    });
    document.body.appendChild(fab);

    // —— 展开后的面板（默认隐藏，没有标题横条）
    const panel = document.createElement('div');
    panel.id = 'ag-quick-panel';
    Object.assign(panel.style, {
        display: 'none',
        position: 'fixed',
        width: 'min(320px, calc(100vw - 16px))',
        maxHeight: 'min(72vh, 560px)',
        boxSizing: 'border-box',
        borderRadius: '14px',
        zIndex: '2147483000',
        background: 'rgba(24,19,17,0.97)',
        color: '#f0e8e2',
        border: '1px solid #e8784a',
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
        fontSize: '12.5px',
        overflow: 'hidden',
    });
    panel.innerHTML = `
        <div id="ag-quick-body">
            <div id="ag-quick-status">状态：待机</div>
            <div id="ag-quick-info"></div>
            <input id="ag-quick-keywords" type="text" placeholder="关键词（可留空自动提取，多个用逗号分隔）">
            <div id="ag-quick-buttons">
                <button id="ag-quick-run">🔎 搜索</button>
                <button id="ag-quick-open">⚙️ 面板</button>
                <button id="ag-quick-check">🩺 自检</button>
                <button id="ag-quick-save">💾 存资料</button>
                <button id="ag-quick-library">📚 资料库</button>
                <button id="ag-quick-diag">📋 诊断</button>
                <button id="ag-quick-recenter">📌 复位</button>
            </div>
            <div id="ag-keyword-panel" style="display:none;">
                <div id="ag-keyword-count"></div>
                <div id="ag-keyword-list"></div>
            </div>
            <textarea id="ag-quick-preview" rows="6" placeholder="搜索结果预览"></textarea>
        </div>`;
    document.body.appendChild(panel);

    const body = $('#ag-quick-body');
    const runBtn = $('#ag-quick-run');
    if (!body || !runBtn) {
        console.warn(LOG_PREFIX, '悬浮控制台 DOM 不完整，跳过绑定');
        fab.remove?.();
        panel.remove?.();
        return;
    }

    // 面板内容也内联兜底排版，保证没吃到 CSS 时依然能用
    Object.assign(body.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '7px',
        padding: '10px',
        overflowY: 'auto',
        maxHeight: 'calc(72vh - 8px)',
        boxSizing: 'border-box',
    });
    const fabStyles = { fontSize: '26px' };
    Object.assign(fab.style, fabStyles);

    // —— 悬浮按钮按钮：单击展开/收起，拖动移动，长按复位
    // 关键：手机上触摸后会再合成一套 mouse 事件（touchstart→touchend→mousedown→mouseup），
    // 旧写法会「开一次再关一次」= 面板一闪而过。这里优先用 Pointer Events（天然不会重复），
    // 不支持时用触摸时间戳把合成鼠标事件挡掉。
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let lastTouchAt = 0;
    let longPressTimer = null;
    let longPressFired = false;
    let lastToggleAt = 0;

    const readPoint = (e) => (e.touches?.[0] ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY });

    const startDrag = (e) => {
        const p = readPoint(e);
        const rect = fab.getBoundingClientRect();
        dragging = true;
        moved = false;
        longPressFired = false;
        startX = p.x;
        startY = p.y;
        originLeft = rect.left;
        originTop = rect.top;
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
            if (!dragging || moved) return;
            longPressFired = true;
            resetQuickPanelPosition(); // 长按 = 复位到右下角
            toast('🦊 悬浮按钮已复位到右下角', 'success');
        }, 600);
    };
    const moveDrag = (e) => {
        if (!dragging) return;
        const p = readPoint(e);
        const dx = p.x - startX;
        const dy = p.y - startY;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
            moved = true;
            clearTimeout(longPressTimer);
        }
        const size = fab.offsetWidth || 52;
        const left = Math.min(Math.max(0, originLeft + dx), Math.max(0, window.innerWidth - size));
        const top = Math.min(Math.max(0, originTop + dy), Math.max(0, window.innerHeight - size));
        fab.style.left = `${left}px`;
        fab.style.top = `${top}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        if (panel.style.display !== 'none') positionPanelNearFab();
        e.preventDefault?.();
    };
    const endDrag = (e) => {
        if (!dragging) return;
        clearTimeout(longPressTimer);
        dragging = false;
        if (moved) {
            saveQuickFabPosition();
            return;
        }
        if (longPressFired) return; // 长按已复位，别再切面板
        const now = Date.now();
        if (now - lastToggleAt < 350) return; // 防抖：短时间内只切一次
        lastToggleAt = now;
        toggleQuickPanel();
    };

    if (typeof window.PointerEvent === 'function') {
        fab.addEventListener('pointerdown', (e) => {
            try { fab.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            startDrag(e);
        });
        fab.addEventListener('pointermove', moveDrag);
        fab.addEventListener('pointerup', endDrag);
        fab.addEventListener('pointercancel', () => {
            clearTimeout(longPressTimer);
            dragging = false;
        });
    } else {
        fab.addEventListener('touchstart', (e) => {
            lastTouchAt = Date.now();
            startDrag(e);
        }, { passive: true });
        document.addEventListener('touchmove', moveDrag, { passive: false });
        document.addEventListener('touchend', endDrag);
        fab.addEventListener('mousedown', (e) => {
            if (Date.now() - lastTouchAt < 800) return; // 触摸后合成的鼠标事件，忽略
            startDrag(e);
        });
        document.addEventListener('mousemove', moveDrag);
        document.addEventListener('mouseup', (e) => {
            if (Date.now() - lastTouchAt < 800) return;
            endDrag(e);
        });
    }

    runBtn.addEventListener('click', () =>
        runManualSearchUi({ inputSel: '#ag-quick-keywords', previewSel: '#ag-quick-preview', statusSel: '#ag-quick-status' }),
    );
    const openBtn = $('#ag-quick-open');
    const checkBtn = $('#ag-quick-check');
    const saveBtn = $('#ag-quick-save');
    const libBtn = $('#ag-quick-library');
    const diagBtn = $('#ag-quick-diag');
    if (openBtn) openBtn.addEventListener('click', openSettingsPanel);
    if (checkBtn) checkBtn.addEventListener('click', runSelfCheck);
    if (libBtn) libBtn.addEventListener('click', openLibrary);
    const recenterBtn = $('#ag-quick-recenter');
    if (recenterBtn) recenterBtn.addEventListener('click', () => ensureQuickPanelVisible({ quiet: false }));
    if (diagBtn) {
        diagBtn.addEventListener('click', () => {
            const text = formatDiag() || '（暂无诊断日志）';
            console.log(LOG_PREFIX, '诊断日志:\n', text);
            toast(`🦊 诊断日志已打印到控制台（${state.diagnostics.length} 条）`, 'info');
            const preview = $('#ag-quick-preview');
            if (preview) preview.value = text.slice(-4000);
        });
    }
    if (saveBtn) saveBtn.addEventListener('click', async () => {
        const map = state.lastResult?.filteredMap;
        if (!map?.size) {
            toast('⚠️ 还没有可保存的搜索结果', 'warning');
            return;
        }
        const out = await saveResults(map, state.lastResult.keywords);
        toast(`🦊 已保存到${out.savedTo === 'server' ? '世界书' : '本浏览器'}`, 'success');
    });

    // Esc 收起面板
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.style.display !== 'none') hideQuickPanel();
    });

    applyQuickFabPosition();
    updateQuickPanel();
}

/** 面板贴着悬浮按钮按钮展开（自动选上方/下方，避免出屏） */
function positionPanelNearFab() {
    const fab = $('#ag-quick-fab');
    const panel = $('#ag-quick-panel');
    if (!fab || !panel) return;
    const f = fab.getBoundingClientRect();
    const pw = Math.min(320, window.innerWidth - 16);
    panel.style.width = `${pw}px`;
    const ph = panel.offsetHeight || 320;
    let left = f.right - pw;
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - pw - 8));
    const above = f.top > ph + 12;
    const top = above ? f.top - ph - 8 : Math.min(f.bottom + 8, window.innerHeight - ph - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(8, top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

function showQuickPanel() {
    const panel = $('#ag-quick-panel');
    const fab = $('#ag-quick-fab');
    if (!fab) {
        // 按钮不存在 → 重建
        buildQuickPanel();
        if (!$('#ag-quick-fab')) {
            toast('⚠️ 悬浮按钮按钮没能创建，请用面板顶部的「🔎 手动搜索」区块（功能一样）', 'warning');
            return false;
        }
    }
    if (!panel && !$('#ag-quick-panel')) buildQuickPanel();
    ensureQuickPanelVisible({ quiet: true });
    const p = $('#ag-quick-panel');
    if (p) {
        p.style.display = 'block';
        p.style.zIndex = '2147483000';
        positionPanelNearFab();
    }
    saveQuickFabExpanded(true);
    return true;
}

function hideQuickPanel() {
    const panel = $('#ag-quick-panel');
    if (panel) panel.style.display = 'none';
    saveQuickFabExpanded(false);
}

function toggleQuickPanel() {
    const panel = $('#ag-quick-panel');
    if (!panel) return showQuickPanel();
    if (panel.style.display === 'none') showQuickPanel();
    else hideQuickPanel();
}

function saveQuickFabExpanded(expanded) {
    const store = extSettings();
    store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), quickFabOpen: !!expanded });
    state.settings = store[MODULE];
    saveSettings();
}

/** 记录悬浮按钮按钮位置（跨设备同步） */
function saveQuickFabPosition() {
    const fab = $('#ag-quick-fab');
    if (!fab) return;
    const r = fab.getBoundingClientRect();
    const store = extSettings();
    store[MODULE] = core.normalizeSettings({
        ...(store[MODULE] || {}),
        quickFabPos: { left: Math.round(r.left), top: Math.round(r.top) },
    });
    state.settings = store[MODULE];
    saveSettings();
}

/** 应用记忆的位置（没有就右下角） */
function applyQuickFabPosition() {
    const fab = $('#ag-quick-fab');
    if (!fab) return;
    const pos = getSettings().quickFabPos;
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        fab.style.left = `${Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - 56))}px`;
        fab.style.top = `${Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 56))}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    }
}

/** 把悬浮按钮按钮复位到右下角，并收起面板 */
function resetQuickPanelPosition() {
    const fab = $('#ag-quick-fab');
    if (!fab) return false;
    fab.style.left = 'auto';
    fab.style.top = 'auto';
    fab.style.right = '12px';
    fab.style.bottom = '96px';
    fab.style.zIndex = '2147483000';
    const store = extSettings();
    store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), quickFabPos: null });
    state.settings = store[MODULE];
    saveSettings();
    hideQuickPanel();
    return true;
}

/** 悬浮窗不见了就用这个：重建 + 复位 + 置顶 */

function bindPanelButtons() {
    const onClick = (selector, handler) => {
        const el = $(selector);
        if (el) el.addEventListener('click', handler);
    };

    onClick('#ag-fill-local-searxng', () => {
        const settings = getSettings();
        settings.searchApiUrl = core.LOCAL_SEARXNG_URL;
        settings.enableCustomSearch = true;
        persistSettings();
        refreshPanel();
        toast(`🦊 已填入本机 SearXNG：${core.LOCAL_SEARXNG_URL}`, 'success');
    });

    onClick('#ag-api-test', async () => {
        toast('🦊 正在测试自定义来源…', 'info');
        await runSelfCheck();
    });

    onClick('#ag-fetch-models', () => fetchModelList());
    onClick('#ag-clear-models', () => {
        state.settings.__modelListCache = null;
        persistSettings();
        const status = $('#ag-model-status');
        if (status) status.textContent = '列表已清空，可重新拉取。';
        renderModelChips();
    });

    onClick('#ag-self-check', runSelfCheck);
    onClick('#ag-open-quick', showQuickPanel);

    onClick('#ag-import-husou', () => {
        try {
            const raw = localStorage.getItem(HUSOU_COMPAT_STORAGE_KEY);
            if (!raw) {
                toast('⚠️ 没找到 localStorage["websearch_settings"]：这份预设的Agent 搜索配置还没在本浏览器保存过', 'warning');
                return;
            }
            const parsed = JSON.parse(raw);
            state.settings = core.normalizeSettings({ ...getSettings(), ...parsed });
            persistSettings();
            refreshPanel();
            toast('🦊 已导入原预设（原预设脚本）保存的Agent 搜索配置', 'success');
        } catch (err) {
            toast(`❌ 导入失败：${err.message}`, 'error');
        }
    });

    onClick('#ag-export-config', () => {
        const settings = getSettings();
        const blob = new Blob([JSON.stringify({ module: MODULE, version: core.VERSION, exportedAt: new Date().toISOString(), settings }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Agent 搜索配置_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    });

    const fileInput = $('#ag-import-file');
    if (fileInput) {
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                const parsed = JSON.parse(await file.text());
                const incoming = parsed?.settings || parsed;
                state.settings = core.normalizeSettings({ ...getSettings(), ...incoming });
                persistSettings();
                refreshPanel();
                toast('🦊 配置导入成功', 'success');
            } catch (err) {
                toast(`❌ 配置导入失败：${err.message}`, 'error');
            } finally {
                fileInput.value = '';
            }
        });
    }

    onClick('#ag-reset-config', () => {
        state.settings = core.normalizeSettings({});
        persistSettings();
        refreshPanel();
        toast('🦊 已恢复默认Agent 搜索配置（含预设原始默认值）', 'success');
    });

    onClick('#ag-open-library', openLibrary);

    onClick('#ag-manual-run', () => runManualSearchUi({ inputSel: '#ag-manual-keywords', previewSel: '#ag-manual-preview', statusSel: '#ag-manual-status' }));
    onClick('#ag-manual-cancel', () => {
        if (!state.running) {
            toast('🦊 当前没有在跑的搜索', 'info');
            return;
        }
        state.abortController?.abort();
        toast('🦊 正在取消Agent 搜索…', 'info');
    });
    onClick('#ag-manual-save', async () => {
        const map = state.lastResult?.filteredMap;
        if (!map?.size) {
            toast('⚠️ 还没有可保存的搜索结果，先搜一次', 'warning');
            return;
        }
        const out = await saveResults(map, state.lastResult.keywords);
        toast(`🦊 已保存到${out.savedTo === 'server' ? '服务器世界书' : '本浏览器'}`, 'success');
    });
    onClick('#ag-manual-openlib', openLibrary);
    onClick('#ag-manual-selfcheck', runSelfCheck);
    onClick('#ag-quick-diagnose', diagnoseQuickPanel);

    onClick('#ag-api-test-direct', testSearchUrlFromPanel);
    onClick('#ag-reload-settings', reloadSettingsFromServer);
    onClick('#ag-library-world-refresh', async () => {
        await refreshLibrary({ notify: false });
        await populateWorldNameSelect();
        toast('🦊 世界书列表已刷新', 'success');
    });
    onClick('#ag-library-world-create', async () => {
        const input = $('#ag-library-world-new');
        const name = String(input?.value || '').trim();
        if (!name) {
            toast('⚠️ 先填新世界书的名字', 'warning');
            return;
        }
        const store = extSettings();
        store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), libraryWorldName: name, libraryStorage: 'server' });
        state.settings = store[MODULE];
        saveSettings();
        await persistLibrary(libraryCache.entries); // 立刻落地，世界书文件就建出来了
        await refreshLibrary({ notify: true });
        await populateWorldNameSelect();
        if (input) input.value = '';
        toast(`🦊 已新建并绑定世界书「${name}」`, 'success');
    });
    onClick('#ag-reload-library', async () => {
        await refreshLibrary({ notify: true });
        renderLibrary();
    });

    onClick('#ag-clear-local', async () => {
        if (!confirm('确定清空资料库？服务器世界书里的条目也会一起删掉，不可恢复。')) return;
        const res = await persistLibrary([]);
        if (res.saved === 'server') {
            try {
                await stPost('/api/worldinfo/edit', { name: libraryWorldName(), data: core.blocksToWorldData(libraryWorldName(), []) });
            } catch (err) {
                diag('资料库:清空世界书失败', { error: errorInfo(err) }, 'error');
            }
        }
        toast('🦊 已清空资料库', 'success');
    });

    onClick('#ag-clear-injection', () => {
        state.pendingInject = '';
        state.lastResult = null;
        toast('🦊 已清空待注入结果（角色卡 personality 里的旧注入请在角色卡里手动删除，或用下方按钮）', 'info');
    });

    onClick('#ag-strip-personality', () => {
        try {
            const ctx = ctxGet();
            const character = ctx?.characters?.[ctx?.characterId];
            if (!character) throw new Error('没有选中角色卡');
            const before = character.personality || '';
            character.personality = core.stripSearchInjection(before);
            bus()?.emit(eventTypes().CHARACTER_EDITED, { detail: { id: ctx.characterId, character } });
            toast(`🦊 已从角色卡移除Agent 搜索注入（减少 ${before.length - character.personality.length} 字符）`, 'success');
        } catch (err) {
            toast(`❌ 清理失败：${err.message}`, 'error');
        }
    });

    onClick('#ag-show-diag', () => {
        const text = formatDiag() || '（暂无诊断日志）';
        toast(text.slice(-3000), 'info');
        console.log(LOG_PREFIX, '诊断日志:\n', text);
    });
}

/* ============================================================================
 * 斜杠命令
 * ==========================================================================*/

function registerSlashCommands() {
    try {
        stSlashParser.SlashCommandParser?.addCommandObject(
            stSlashCommand.SlashCommand?.fromProps({
                name: 'foxsearch',
                callback: async (_args, keywords) => {
                    const list = core.normalizeKeywords(keywords || '');
                    await executeSearch({ keywords: list, manual: true });
                    return state.lastResult?.injectText ? 'Agent 搜索完成' : 'Agent 搜索完成（无新信息）';
                },
                helpString: '🦊Agent 搜索：搜索并注入外部资料。<code>/foxsearch 原神 可莉</code>；留空则交给模型自动提取关键词。',
                returns: '执行结果',
                unnamedArgumentList: [
                    stSlashArgs.SlashCommandArgument?.fromProps({
                        description: '要搜索的关键词（空格/逗号分隔，可留空自动提取）',
                        typeList: [stSlashArgs.ARGUMENT_TYPE?.STRING],
                        isRequired: false,
                    }),
                ],
            }),
        );
    } catch (err) {
        console.warn(LOG_PREFIX, '注册斜杠命令失败', err);
    }
}

/* ============================================================================
 * 初始化
 * ==========================================================================*/

function migrateLegacySettings() {
    // 首次启用时，若存在原预设/酒馆 WebSearch 留下的配置，自动并入一次（**只做一次**）
    try {
        if (extSettings()[MODULE]?.__importedFromHusou) return;
        if (localStorage.getItem(MIGRATED_FLAG_KEY) === '1') return;
        const raw = localStorage.getItem(HUSOU_COMPAT_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        const merged = core.normalizeSettings({ ...DEFAULTS_FOR_MERGE(), ...parsed, ...(extSettings()[MODULE] || {}) });
        merged.__importedFromHusou = true;
        merged.__savedAt = Date.now();
        extSettings()[MODULE] = merged;
        state.settings = merged;
        try {
            localStorage.setItem(MIGRATED_FLAG_KEY, '1');
        } catch { /* ignore */ }
        writeSettingsMirror(merged);
        saveSettings();
        log('已自动并入遗留的Agent 搜索配置（只这一次）');
    } catch (err) {
        console.warn(LOG_PREFIX, '遗留配置并入失败', err);
    }
}

function DEFAULTS_FOR_MERGE() {
    return core.deepClone(core.DEFAULT_SETTINGS);
}

jQuery(async () => {
    if (!extSettings()[MODULE]) extSettings()[MODULE] = core.normalizeSettings({});
    state.settings = core.normalizeSettings(extSettings()[MODULE]);

    // 每一步独立兜底：任何一步失败都不该阻断插件整体加载
    const step = async (name, fn) => {
        try {
            await fn();
        } catch (err) {
            console.error(LOG_PREFIX, `${name} 初始化失败`, err);
        }
    };

    await step('接管旧狐搜配置', adoptLegacySettings);
    await step('设置镜像恢复', adoptSettingsMirror);
    await step('遗留配置并入', migrateLegacySettings);
    await step('资料库载入', () => refreshLibrary());
    await step('设置面板挂载', mountSettingsPanel);
    await step('悬浮控制台', buildQuickPanel);
    // 移动端酒馆布局是异步完成的，等一拍再校正一次位置（跑出视口就拉回来）；
    // 全部包在 try/catch 里：任何平台差异都不该挡住后面的钩子/命令注册
    try {
        setTimeout(() => {
            try {
                ensureQuickPanelVisible({ quiet: true });
            } catch (err) {
                console.warn(LOG_PREFIX, '悬浮窗可见性校正失败', err);
            }
        }, 1500);

        // 看门狗：某些移动端布局会在重排时清掉 body 下的自定义节点，发现没了就立刻重建
        var quickPanelWatchdog = setInterval(() => {
            try {
                if (!document.querySelector('#ag-quick-fab')) {
                    diag('悬浮窗:节点消失，自动重建', {}, 'warn');
                    buildQuickPanel();
                    ensureQuickPanelVisible({ quiet: true });
                }
            } catch (err) {
                console.warn(LOG_PREFIX, '悬浮窗看门狗异常', err);
            }
        }, 5000);

        if (typeof window.addEventListener === 'function') {
            window.addEventListener('resize', () => {
                try {
                    ensureQuickPanelVisible({ quiet: true });
                } catch { /* ignore */ }
            });
            window.addEventListener('orientationchange', () => {
                setTimeout(() => {
                    try {
                        ensureQuickPanelVisible({ quiet: true });
                    } catch { /* ignore */ }
                }, 400);
            });
            window.addEventListener('beforeunload', () => clearInterval(quickPanelWatchdog));
        }
    } catch (err) {
        console.warn(LOG_PREFIX, '悬浮窗监听注册失败（不影响其它功能）', err);
    }
    await step('注入钩子', registerInjectionHooks);
    await step('自动搜索钩子', registerAutoSearchHooks);
    await step('斜杠命令', registerSlashCommands);

    // 重复安装检测：同一份代码被装在两个文件夹时会加载两次，各持一块面板
    try {
        globalThis.__foxSearchInstances = globalThis.__foxSearchInstances || [];
        const me = extRelPath();
        if (!globalThis.__foxSearchInstances.includes(me)) globalThis.__foxSearchInstances.push(me);
        if (globalThis.__foxSearchInstances.length > 1) {
            console.warn(LOG_PREFIX, '检测到重复安装的Agent 搜索扩展：', globalThis.__foxSearchInstances);
            toast(
                `⚠️ 检测到装了 ${globalThis.__foxSearchInstances.length} 份Agent 搜索扩展：\n${globalThis.__foxSearchInstances.join('\n')}\n请删掉多余文件夹，只留一份，否则会出现「改了设置却还是旧值」`,
                'warning',
            );
        }
    } catch { /* ignore */ }

    console.log(`${LOG_PREFIX} 🦊Agent 搜索·独立版 v${core.VERSION} 已加载（设置面板在「扩展」里，右下角有悬浮控制台）`);
});

// 供其它脚本/调试使用
window.foxSearch = {
    version: core.VERSION,
    settings: () => getSettings(),
    search: (keywords) => executeSearch({ keywords: core.normalizeKeywords(keywords || ''), manual: true }),
    selfCheck: runSelfCheck,
    diagnostics: formatDiag,
    // 调试/自动化用：读取上次结果、手动触发注入、直接改设置
    lastResult: () => state.lastResult,
    lastKeywords: () => state.lastKeywordsByKw || {},
    lastSources: () => state.lastSources || {},
    inject: (promptArray) => injectIntoPromptArray(promptArray),
    mountPanel: () => mountSettingsPanel(),
    openLibrary,
    library: () => ({ source: libraryCache.source, world: libraryWorldName(), blocks: libraryCache.blocks, error: libraryCache.error }),
    reloadLibrary: (opts) => refreshLibrary(opts || {}),
    fetchModels: () => fetchModelList(),
    reloadSettings: () => reloadSettingsFromServer(),
    testSearchUrl: () => testSearchUrlFromPanel(),
    showPanel: () => showQuickPanel(),
    diagnosePanel: () => diagnoseQuickPanel(),
    checkPanel: () => ensureQuickPanelVisible({ quiet: false }),
    quickPanelExists: () => !!document.querySelector('#ag-quick-panel'),
    // 诊断用：本扩展实际被安装到的目录（文件夹名随便叫都对）
    settingsUrl: () => EXT_SETTINGS_URL,
    extRelPath,
    patchSettings: (patch) => {
        const store = extSettings();
        store[MODULE] = core.normalizeSettings({ ...(store[MODULE] || {}), ...patch });
        state.settings = store[MODULE];
        saveSettings();
        return state.settings;
    },
    core,
};
