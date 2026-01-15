// Image Router Extension for SillyTavern
// Supports text-to-image, image-to-image, history gallery, prompt prefix, fixed reference mode
// Update: Added support for Raw Base64 responses (Auto-prefixing)

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../script.js';

import { extension_settings, getContext } from '../../../extensions.js';

const extensionName = 'img-router';

// Default settings
const defaultSettings = {
    apiUrl: 'http://127.0.0.1:10001',
    apiKey: '',
    model: '',
    size: '',
    stream: true,
    promptPrefix: '',
    referenceImages: [],
    generatedHistory: [],
    fixReferenceImages: false,
    enableInline: true,
    promptImageCache: {} // prompt -> imageUrl 缓存，用于刷新后恢复图片
};

// State
let isGenerating = false;
let chatObserver = null;

/**
 * Initialize extension settings
 */
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }
    
    // Update UI Inputs
    $('#img-router-api-url').val(extension_settings[extensionName].apiUrl);
    $('#img-router-api-key').val(extension_settings[extensionName].apiKey);
    $('#img-router-model').val(extension_settings[extensionName].model);
    $('#img-router-size').val(extension_settings[extensionName].size);
    $('#img-router-stream').prop('checked', extension_settings[extensionName].stream);
    $('#img-router-prefix').val(extension_settings[extensionName].promptPrefix);
    $('#img-router-fix-ref').prop('checked', extension_settings[extensionName].fixReferenceImages);
    $('#img-router-enable-inline').prop('checked', extension_settings[extensionName].enableInline);

    // Update UI Sections
    updateImagePreviews();
    renderHistoryGallery();
}

function saveSetting(key, value) {
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();
    if (key === 'enableInline') processChatMessages(); 
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function normalizeApiUrl(rawUrl) {
    let url = (rawUrl || '').trim();
    if (!url) return '';
    url = url.replace(/\/+$/, '');
    return url.replace(/\/v1(?:\/.*)?$/i, '');
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ================= 参考图片 (图生图) 逻辑 =================

function updateImagePreviews() {
    const container = $('#img-router-preview-container');
    const clearBtn = $('#img-router-clear-images');
    const images = extension_settings[extensionName].referenceImages || [];

    container.empty();
    if (images.length === 0) {
        clearBtn.hide();
    } else {
        clearBtn.show();
    }

    images.forEach((imgData, index) => {
        const previewItem = $(`
            <div class="img-router-preview-item" data-index="${index}">
                <img src="${imgData}" alt="Ref ${index + 1}" />
                <button class="remove-btn" data-index="${index}"><i class="fa-solid fa-times"></i></button>
            </div>
        `);
        container.append(previewItem);
    });
}

async function addReferenceImage(file) {
    const images = extension_settings[extensionName].referenceImages || [];
    if (images.length >= 3) {
        toastr.warning('最多上传 3 张参考图');
        return;
    }
    try {
        const base64 = await fileToBase64(file);
        images.push(base64);
        saveSetting('referenceImages', images);
        updateImagePreviews();
        toastr.success('参考图已添加');
    } catch (error) {
        console.error(error);
        toastr.error('图片读取失败');
    }
}

function removeReferenceImage(index) {
    const images = extension_settings[extensionName].referenceImages || [];
    images.splice(index, 1);
    saveSetting('referenceImages', images);
    updateImagePreviews();
}

function clearAllImages() {
    saveSetting('referenceImages', []);
    updateImagePreviews();
}

// ================= 历史记录画廊逻辑 =================

function addToHistory(imageUrl, prompt) {
    const history = extension_settings[extensionName].generatedHistory || [];
    history.unshift({
        url: imageUrl,
        prompt: prompt,
        time: new Date().toLocaleString()
    });
    if (history.length > 20) history.length = 20;
    saveSetting('generatedHistory', history);
    renderHistoryGallery();
}

function renderHistoryGallery() {
    const container = $('#img-router-history-container');
    const history = extension_settings[extensionName].generatedHistory || [];
    container.empty();
    
    if (history.length === 0) {
        container.html('<div style="text-align:center; opacity:0.5; padding:20px;">暂无生成记录</div>');
        return;
    }

    history.forEach((item, index) => {
        const safeTitle = escapeHtml(`${item.prompt} (${item.time})`);
        const div = $(`
            <div class="history-item" title="${safeTitle}">
                <img src="${item.url}" class="zoomable" onclick="clickZoom(this)" />
                <div class="history-actions">
                    <i class="fa-solid fa-download" onclick="const a=document.createElement('a');a.href='${item.url}';a.download='history_${index}.png';a.click();"></i>
                    <i class="fa-solid fa-trash" data-index="${index}"></i>
                </div>
            </div>
        `);
        container.append(div);
    });

    container.find('.fa-trash').on('click', function() {
        const idx = $(this).data('index');
        const currentHistory = extension_settings[extensionName].generatedHistory;
        currentHistory.splice(idx, 1);
        saveSetting('generatedHistory', currentHistory);
        renderHistoryGallery();
    });
}

function clearHistory() {
    if (confirm('确定要删除所有历史生成记录吗？')) {
        saveSetting('generatedHistory', []);
        renderHistoryGallery();
        toastr.info('历史记录已清空');
    }
}

// ================= API 交互逻辑 =================

async function testConnection() {
    const statusEl = $('#img-router-connection-status');
    const apiUrl = normalizeApiUrl($('#img-router-api-url').val());
    if (!apiUrl) return toastr.error('请输入 API 地址');

    statusEl.html('<i class="fa-solid fa-spinner fa-spin"></i> Testing...');
    try {
        const response = await fetch(`${apiUrl}/health`);
        if (response.ok) {
            statusEl.html('<span style="color:#4caf50">连接成功</span>');
            return;
        }

        const uiResponse = await fetch(`${apiUrl}/api/health`).catch(() => null);
        if (uiResponse && (uiResponse.ok || uiResponse.status === 401)) {
            statusEl.html('<span style="color:#f44336">当前是管理端口，请使用 API 端口 (默认 10001)</span>');
            return;
        }

        statusEl.html(`<span style="color:#f44336">错误: ${response.status}</span>`);
    } catch (error) {
        statusEl.html('<span style="color:#f44336">连接失败</span>');
    }
}

function buildMessages(prompt, images) {
    const content = [];
    if (prompt) content.push({ type: 'text', text: prompt });
    if (images && images.length > 0) {
        images.forEach(imgData => content.push({ type: 'image_url', image_url: { url: imgData } }));
    }
    return [{ role: 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content }];
}

async function generateImage(prompt, referenceImages = null) {
    if (isGenerating) {
        toastr.warning('正在生成中，请稍候...');
        return null;
    }

    const settings = extension_settings[extensionName];
    const apiUrl = normalizeApiUrl(settings.apiUrl);
    const apiKey = settings.apiKey;

    if (!apiUrl || !apiKey) {
        toastr.error('请先配置 API 地址和访问令牌');
        return null;
    }

    isGenerating = true;

    let finalPrompt = prompt;
    if (settings.promptPrefix && settings.promptPrefix.trim() !== '') {
        finalPrompt = `${settings.promptPrefix}, ${prompt}`;
    }

    const images = referenceImages || settings.referenceImages || [];
    const messages = buildMessages(finalPrompt, images);

    const requestBody = {
        model: settings.model || undefined,
        messages: messages,
        stream: settings.stream,
        size: settings.size || undefined,
    };

    Object.keys(requestBody).forEach(key => requestBody[key] === undefined && delete requestBody[key]);

    try {
        console.log('[img-router] Sending Request:', requestBody);
        const response = await fetch(`${apiUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            let message = '';
            try {
                const data = await response.json();
                message = data?.error?.message || data?.error || JSON.stringify(data);
            } catch {
                message = await response.text();
            }
            throw new Error(`API Error ${response.status}: ${message}`);
        }

        let content = '';
        
        if (settings.stream) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let rawBuffer = '';
            let lineBuffer = '';

            const appendDelta = (dataLine) => {
                if (!dataLine || dataLine === '[DONE]') return;
                try {
                    const json = JSON.parse(dataLine);
                    const delta = json.choices?.[0]?.delta?.content;
                    if (delta) content += delta;
                } catch (e) {}
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value, { stream: true });
                rawBuffer += chunk;
                lineBuffer += chunk;

                let newlineIndex;
                while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
                    const line = lineBuffer.slice(0, newlineIndex).trim();
                    lineBuffer = lineBuffer.slice(newlineIndex + 1);

                    if (!line.startsWith('data:')) continue;
                    const data = line.replace(/^data:\s*/, '');
                    appendDelta(data);
                }
            }

            const remaining = lineBuffer.trim();
            if (remaining.startsWith('data:')) {
                const data = remaining.replace(/^data:\s*/, '');
                appendDelta(data);
            }
            
            // 如果流解析为空，尝试解析整个 Buffer
            if (!content && rawBuffer.length > 0) {
                console.log('[img-router] Stream parsing empty, checking raw buffer...');
                const fallbackLines = rawBuffer.split('\n');
                for (const line of fallbackLines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const data = trimmed.replace(/^data:\s*/, '');
                    appendDelta(data);
                }

                if (!content) {
                    let parsedError = null;
                    try {
                        const json = JSON.parse(rawBuffer);
                        if (json?.error) {
                            parsedError = json.error.message || json.error.error || JSON.stringify(json.error);
                        } else {
                            content = json.choices?.[0]?.message?.content || 
                                      json.b64_json || 
                                      (json.images && json.images[0]) || 
                                      (json.data && (json.data[0]?.b64_json || json.data[0]?.url)) ||
                                      JSON.stringify(json);
                        }
                    } catch (e) {
                        content = rawBuffer.trim();
                    }
                    if (parsedError) throw new Error(parsedError);
                }
            }
        } else {
            const data = await response.json();
            content = data.choices?.[0]?.message?.content || 
                      data.b64_json || 
                      (data.images && data.images[0]) || 
                      '';
        }

        console.log('[img-router] Final Content Length:', content.length);

        if (content && images.length > 0) {
            if (!settings.fixReferenceImages) {
                clearAllImages();
            }
        }

        return content;
    } catch (error) {
        console.error('[img-router] Error:', error);
        toastr.error(`生成失败: ${error.message}`);
        return null;
    } finally {
        isGenerating = false;
    }
}

// === 核心修复：Base64 自动补全 ===
function extractImageFromContent(content) {
    if (!content) return null;
    
    // 1. Markdown
    const mdMatch = content.match(/!\[.*?\]\((.*?)\)/);
    if (mdMatch) return mdMatch[1];
    
    // 2. 纯 URL
    const urlMatch = content.match(/(https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|webp|gif|bmp))/i);
    if (urlMatch) return urlMatch[0];
    
    // 3. 标准 Base64 (带前缀)
    const base64Match = content.match(/(data:image\/[^;]+;base64,[^"\s]+)/);
    if (base64Match) return base64Match[1];
    
    // 4. Raw Base64 (无前缀) - 关键修复
    // 移除空白字符
    const cleanContent = content.trim().replace(/\s/g, '');
    // 简单的 Base64 检测：长度足够长，且只包含 Base64 字符
    if (cleanContent.length > 100 && /^[A-Za-z0-9+/=]+$/.test(cleanContent)) {
        console.log('[img-router] Detected Raw Base64, adding prefix...');
        return `data:image/png;base64,${cleanContent}`;
    }
    
    // 5. 兜底：如果字符串本身就是一个 URL
    const trimmed = content.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed.replace(/['"()]/g, '');
    }
    
    return null;
}

// ================= 聊天内联交互逻辑 =================

// 生成 prompt 的缓存 key（去除空白和特殊字符，取前100字符）
function getPromptCacheKey(prompt) {
    return prompt.replace(/<br\s*\/?>/gi, '\n').replace(/&[^;]+;/g, '').replace(/\s+/g, ' ').trim().substring(0, 100);
}

// 保存 prompt -> imageUrl 到缓存
function cachePromptImage(prompt, imageUrl) {
    const cache = extension_settings[extensionName].promptImageCache || {};
    const key = getPromptCacheKey(prompt);
    cache[key] = imageUrl;
    // 限制缓存大小，最多保存 50 条
    const keys = Object.keys(cache);
    if (keys.length > 50) {
        delete cache[keys[0]];
    }
    saveSetting('promptImageCache', cache);
}

// 从缓存获取图片
function getCachedImage(prompt) {
    const cache = extension_settings[extensionName].promptImageCache || {};
    const key = getPromptCacheKey(prompt);
    return cache[key] || null;
}

function processChatMessages() {
    const isEnabled = extension_settings[extensionName]?.enableInline ?? true;
    const chat = getContext().chat;
    if (!chat || chat.length === 0) return;

    $('#chat .mes').each(function() {
        const messageElement = $(this);
        const textContainer = messageElement.find('.mes_text');

        if (!isEnabled) return;

        const html = textContainer.html();
        // 适配多种格式：image###...### 或 image###<br>...<br>###
        // 使用更宽松的正则，匹配 image### 开头到 ### 结尾（中间可以有任何内容包括 <br>）
        const hasPlaceholder = /image###([\s\S]*?)###/.test(html);

        if (!hasPlaceholder) {
            if (textContainer.find('.img-router-inline-trigger, .img-router-inline-result').length > 0) {
                bindInlineEvents(textContainer);
            }
            return;
        }

        // 匹配 image### 和 ### 之间的内容（包括换行和 <br> 标签）
        const regex = /image###([\s\S]*?)###/g;

        const newHtml = html.replace(regex, (match, prompt) => {
            // 清理 prompt：移除 <br> 标签，转换 HTML 实体
            const cleanPrompt = prompt
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .trim();

            // 检查缓存中是否已有生成的图片
            const cachedImage = getCachedImage(cleanPrompt);
            if (cachedImage) {
                // 已有缓存，直接显示图片
                return `
                    <div class="img-router-inline-result">
                        <img src="${cachedImage}" class="zoomable" onclick="clickZoom(this)" alt="已生成图片" />
                        <div class="img-router-inline-actions">
                            <i class="fa-solid fa-download" title="下载" onclick="event.stopPropagation(); const a = document.createElement('a'); a.href='${cachedImage}'; a.download='gen_${Date.now()}.png'; a.click();"></i>
                        </div>
                    </div>
                `;
            }

            // 没有缓存，显示生成按钮
            const safePrompt = cleanPrompt.replace(/"/g, '&quot;');
            return `<span class="img-router-inline-trigger" data-prompt="${safePrompt}" title="点击生成图片">[生成图片]</span>`;
        });

        if (newHtml !== html) {
            textContainer.html(newHtml);
        }
        bindInlineEvents(textContainer);
    });
}

function bindInlineEvents(container) {
    container.find('.img-router-inline-trigger').off('click').on('click', async function(e) {
        e.stopPropagation();
        const trigger = $(this);
        const prompt = trigger.attr('data-prompt');

        if (isGenerating) return toastr.warning('已有任务进行中');

        trigger.removeClass('img-router-inline-trigger').addClass('img-router-loading');
        trigger.html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...');

        try {
            toastr.info('开始生成...');
            const content = await generateImage(prompt);
            
            if (content) {
                const imageUrl = extractImageFromContent(content);
                if (imageUrl) {
                    addToHistory(imageUrl, prompt);
                    cachePromptImage(prompt, imageUrl); // 缓存 prompt -> imageUrl，刷新后可恢复
                    const imgHtml = `
                        <div class="img-router-inline-result">
                            <img src="${imageUrl}" class="zoomable" onclick="clickZoom(this)" alt="${prompt}" />
                            <div class="img-router-inline-actions">
                                <i class="fa-solid fa-download" title="下载" onclick="event.stopPropagation(); const a = document.createElement('a'); a.href='${imageUrl}'; a.download='gen_${Date.now()}.png'; a.click();"></i>
                            </div>
                        </div>
                    `;
                    trigger.replaceWith(imgHtml);
                    saveSettingsDebounced();
                    toastr.success('生成成功，已保存');
                } else {
                    throw new Error('无法解析图片数据');
                }
            } else {
                throw new Error('API 返回为空');
            }
        } catch (err) {
            trigger.removeClass('img-router-loading').addClass('img-router-inline-trigger');
            trigger.html('[生成失败-点击重试]');
            toastr.error(err.message);
        }
    });
}

function startChatObserver() {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) {
        setTimeout(startChatObserver, 1000);
        return;
    }
    if (chatObserver) chatObserver.disconnect();
    chatObserver = new MutationObserver((mutations) => {
        let shouldProcess = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldProcess = true;
                break;
            }
        }
        if (shouldProcess) processChatMessages();
    });
    chatObserver.observe(chatContainer, { childList: true, subtree: true });
    console.log('[img-router] Chat Observer started.');
}

// ================= UI 注入与初始化 =================

function injectCustomStyles() {
    if (document.getElementById('img-router-injected-style')) return;
    const css = `
        .img-router-inline-trigger { color: #3b82f6; font-weight: bold; cursor: pointer; text-decoration: underline; margin: 0 4px; -webkit-tap-highlight-color: transparent; }
        .img-router-inline-trigger:hover { color: #60a5fa; }
        .img-router-loading { color: var(--SmartThemeQuoteColor); font-size: 0.9em; cursor: wait; }
        .img-router-inline-result { display: inline-block; position: relative; margin: 10px 0; max-width: 100%; }
        .img-router-inline-result img { max-width: 100%; max-height: 400px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); cursor: zoom-in; display: block; }
        .img-router-inline-actions { position: absolute; bottom: 5px; right: 5px; background: rgba(0,0,0,0.6); border-radius: 4px; padding: 4px; display: flex; gap: 5px; opacity: 0; transition: opacity 0.2s; }
        .img-router-inline-result:hover .img-router-inline-actions { opacity: 1; }
        .img-router-inline-actions i { color: white; cursor: pointer; font-size: 14px; padding: 2px; }
        .img-router-inline-actions i:hover { color: #3b82f6; }

        #img-router-modal-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
            z-index: 100000;
            display: none;
            align-items: flex-start;
            justify-content: center;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            padding: 16px;
            box-sizing: border-box;
        }
        #img-router-modal-overlay.active { display: flex !important; }

        #img-router-modal {
            background: var(--SmartThemeBlurTintColor, #1a1a2e);
            border-radius: 12px;
            width: 90%;
            max-width: 550px;
            max-height: calc(100vh - 32px);
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            margin: 0;
            box-shadow: 0 10px 40px rgba(0,0,0,0.5);
            border: 1px solid var(--SmartThemeBorderColor, #444);
            position: relative;
            display: flex;
            flex-direction: column;
            color: var(--SmartThemeBodyColor, #fff);
            flex-shrink: 0;
        }

        .img-router-header { border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 15px; padding-bottom: 10px; cursor: move; }
        .img-router-section { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.05); }
        .img-router-section h4 { margin: 0 0 10px 0; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px; font-size: 1em; }
        .img-router-field { margin-bottom: 10px; }
        .img-router-field label { display: block; font-size: 0.9em; margin-bottom: 4px; opacity: 0.9; }
        .img-router-input { width: 100%; padding: 8px; border-radius: 4px; border: 1px solid var(--SmartThemeBorderColor, #555); background: var(--SmartThemeEmColor, #222); color: var(--SmartThemeBodyColor, #fff); box-sizing: border-box; font-size: 16px; }
        .img-router-preview-list { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
        .img-router-preview-item { width: 60px; height: 60px; position: relative; border-radius: 4px; overflow: hidden; border: 1px solid #555; }
        .img-router-preview-item img { width: 100%; height: 100%; object-fit: cover; }
        .img-router-preview-item .remove-btn { position: absolute; top: 0; right: 0; background: rgba(255,0,0,0.7); color: white; border: none; width: 20px; height: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; }
        .img-router-upload-zone { display: block; border: 2px dashed #555; padding: 15px; text-align: center; border-radius: 6px; cursor: pointer; transition: 0.2s; margin-bottom: 0; }
        .img-router-upload-zone:hover { border-color: #3b82f6; background: rgba(59, 130, 246, 0.1); }
        #img-router-history-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 8px; max-height: 200px; overflow-y: auto; margin-top: 10px; }
        .history-item { position: relative; aspect-ratio: 1; border-radius: 4px; overflow: hidden; border: 1px solid #444; }
        .history-item img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
        .history-actions { position: absolute; bottom: 0; left: 0; width: 100%; background: rgba(0,0,0,0.7); display: flex; justify-content: space-around; padding: 4px 0; opacity: 0; transition: 0.2s; }
        .history-item:hover .history-actions { opacity: 1; }
        .history-actions i { color: white; cursor: pointer; font-size: 12px; }
        .history-actions i:hover { color: #3b82f6; }

        #img-router-modal-close { top: 8px; right: 8px; }

        @media (max-width: 768px) {
            #img-router-modal { width: 95%; }
            #img-router-modal-close { top: 8px; right: 8px; }
        }
    `;
    const style = document.createElement('style');
    style.id = 'img-router-injected-style';
    style.innerHTML = css;
    document.head.appendChild(style);
}

function setupEventHandlers() {
    $('#img-router-api-url').on('input', function() { saveSetting('apiUrl', $(this).val().trim()); });
    $('#img-router-api-key').on('input', function() { saveSetting('apiKey', $(this).val().trim()); });
    $('#img-router-model').on('change', function() { saveSetting('model', $(this).val()); });
    $('#img-router-size').on('change', function() { saveSetting('size', $(this).val()); });
    $('#img-router-stream').on('change', function() { saveSetting('stream', $(this).prop('checked')); });
    $('#img-router-prefix').on('input', function() { saveSetting('promptPrefix', $(this).val()); });
    $('#img-router-fix-ref').on('change', function() { saveSetting('fixReferenceImages', $(this).prop('checked')); });
    $('#img-router-enable-inline').on('change', function() { saveSetting('enableInline', $(this).prop('checked')); });

    $('#img-router-test-connection').on('click', testConnection);
    $('#img-router-clear-history').on('click', clearHistory);

    const uploadZone = $('#img-router-upload-area');
    const fileInput = $('#img-router-file-input');
    
    uploadZone.on('dragover', (e) => { e.preventDefault(); uploadZone.addClass('dragover'); });
    uploadZone.on('dragleave drop', (e) => { e.preventDefault(); uploadZone.removeClass('dragover'); });
    uploadZone.on('drop', async (e) => {
        const files = e.originalEvent.dataTransfer.files;
        for (const file of files) if (file.type.startsWith('image/')) await addReferenceImage(file);
    });
    
    fileInput.on('change', async function() {
        for (const file of this.files) await addReferenceImage(file);
        this.value = '';
    });
    
    $('#img-router-preview-container').on('click', '.remove-btn', function(e) {
        e.stopPropagation();
        removeReferenceImage(parseInt($(this).data('index')));
    });
    $('#img-router-clear-images').on('click', clearAllImages);

    eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(processChatMessages, 200));
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(processChatMessages, 200));
}

function toggleModal() {
    const overlay = document.getElementById('img-router-modal-overlay');
    if (overlay) {
        if (overlay.classList.contains('active')) {
            overlay.classList.remove('active');
        } else {
            overlay.classList.add('active');
        }
    }
}

function initFabDrag(fabElement) {
    let isDragging = false, hasMoved = false, startX, startY, initialLeft, initialTop;
    const clickThreshold = 5;

    function handleStart(e) {
        if (e.type === 'touchstart') e.preventDefault(); 
        isDragging = true; hasMoved = false;
        const touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX; startY = touch.clientY;
        const rect = fabElement.getBoundingClientRect();
        initialLeft = rect.left; initialTop = rect.top;
        fabElement.style.cursor = 'grabbing';
        fabElement.style.transition = 'none';
        fabElement.dataset.dragging = 'false';
    }

    function handleMove(e) {
        if (!isDragging) return;
        const touch = e.touches ? e.touches[0] : e;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dx) > clickThreshold || Math.abs(dy) > clickThreshold) {
            hasMoved = true;
            fabElement.dataset.dragging = 'true';
            e.preventDefault();
            let newX = Math.max(0, Math.min(initialLeft + dx, window.innerWidth - fabElement.offsetWidth));
            let newY = Math.max(0, Math.min(initialTop + dy, window.innerHeight - fabElement.offsetHeight));
            fabElement.style.left = newX + 'px';
            fabElement.style.top = newY + 'px';
        }
    }

    function handleEnd(e) {
        if (!isDragging) return;
        isDragging = false;
        fabElement.style.cursor = 'grab';
        fabElement.style.transition = 'transform 0.2s, box-shadow 0.2s';
        
        if (e.type === 'touchend' && !hasMoved) { 
            e.preventDefault(); 
            toggleModal(); 
        }
        
        setTimeout(() => fabElement.dataset.dragging = 'false', 100);
    }

    fabElement.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    fabElement.addEventListener('touchstart', handleStart, { passive: false });
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
}

function initModalDrag() {
    const modal = document.getElementById('img-router-modal');
    const header = modal.querySelector('.img-router-header');
    if (!modal || !header) return;

    let isDragging = false;
    let startX, startY, startTranslateX = 0, startTranslateY = 0;

    function getTranslateValues(element) {
        const style = window.getComputedStyle(element);
        const matrix = new WebKitCSSMatrix(style.transform);
        return { x: matrix.m41, y: matrix.m42 };
    }

    function handleStart(e) {
        if (e.target.closest('button')) return; 
        isDragging = true;
        const touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX;
        startY = touch.clientY;
        
        const current = getTranslateValues(modal);
        startTranslateX = current.x;
        startTranslateY = current.y;
        
        header.style.cursor = 'grabbing';
    }

    function handleMove(e) {
        if (!isDragging) return;
        e.preventDefault(); 
        const touch = e.touches ? e.touches[0] : e;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        
        modal.style.transform = `translate(${startTranslateX + dx}px, ${startTranslateY + dy}px)`;
    }

    function handleEnd() {
        isDragging = false;
        header.style.cursor = 'move';
    }

    header.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    header.addEventListener('touchstart', handleStart, { passive: false });
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
}

jQuery(async () => {
    try {
        console.log('[img-router] Init...');
        injectCustomStyles();

        const fab = document.createElement('button');
        fab.id = 'img-router-fab';
        fab.innerHTML = '<i class="fa-solid fa-images"></i>';
        fab.style.cssText = `position: fixed; bottom: 150px; left: 20px; width: 50px; height: 50px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; justify-content: center; align-items: center; cursor: grab; z-index: 99999; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); border: none; color: white; font-size: 24px; -webkit-tap-highlight-color: transparent; touch-action: none;`;
        document.body.appendChild(fab);

        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'img-router-modal-overlay';
        modalOverlay.innerHTML = `
            <div id="img-router-modal">
                <button id="img-router-modal-close" style="position: absolute; top: 8px; right: 8px; width: 36px; height: 36px; border-radius: 50%; background: #f44336; color: white; border: 2px solid white; cursor: pointer; z-index: 20001; display: flex; justify-content: center; align-items: center; box-shadow: 0 2px 8px rgba(0,0,0,0.3);"><i class="fa-solid fa-times"></i></button>
                <div id="img-router-modal-content" style="padding: 15px;">
                    <div class="img-router-header">
                        <h3 style="margin:0;">🎨 图像生成器 <span style="font-size:0.6em; opacity:0.7;">v2.4.0</span></h3>
                        <small style="opacity:0.6; font-size:0.7em;">按住此处可拖动</small>
                    </div>
                    
                    <div class="img-router-section" style="display:flex; align-items:center; justify-content:space-between; background:rgba(59, 130, 246, 0.1); border-color:#3b82f6;">
                        <span style="font-weight:bold;">启用聊天内联生成</span>
                        <label class="switch" style="margin:0;">
                            <input type="checkbox" id="img-router-enable-inline" checked>
                            <span class="slider round"></span>
                        </label>
                    </div>

                    <div class="img-router-section">
                        <h4>🔗 API 配置</h4>
                        <div class="img-router-field">
                            <label>服务器地址</label>
                            <input type="text" id="img-router-api-url" class="img-router-input" placeholder="http://127.0.0.1:10001" />
                        </div>
                        <div class="img-router-field">
                            <label>访问令牌</label>
                            <input type="text" id="img-router-api-key" class="img-router-input" placeholder="请输入 accessToken" />
                            <small style="opacity:0.7;">请在 img-router 管理后台创建访问令牌</small>
                        </div>
                        <button id="img-router-test-connection" class="menu_button">测试连接</button>
                        <span id="img-router-connection-status" style="margin-left:10px;"></span>
                    </div>
                    
                    <div class="img-router-section">
                        <h4>⚙️ 生成设置</h4>
                        <div class="img-router-field">
                            <label>提示词前缀 (自动添加到提示词开头)</label>
                            <textarea id="img-router-prefix" class="img-router-input" rows="2" placeholder="例如: high quality, masterpiece, 8k"></textarea>
                        </div>
                        <div class="img-router-field">
                            <label>模型</label>
                            <select id="img-router-model" class="img-router-input">
                                <option value="">默认 (自动)</option>
                                <optgroup label="火山引擎">
                                    <option value="doubao-seedream-4-5-251128">doubao-seedream-4-5-251128</option>
                                    <option value="doubao-seedream-4-0-250828">doubao-seedream-4-0-250828</option>
                                </optgroup>
                                <optgroup label="Gitee">
                                    <option value="z-image-turbo">z-image-turbo</option>
                                    <option value="Qwen-Image-Edit">Qwen-Image-Edit</option>
                                    <option value="Qwen-Image-Edit-2511">Qwen-Image-Edit-2511</option>
                                    <option value="FLUX.1-Kontext-dev">FLUX.1-Kontext-dev</option>
                                </optgroup>
                                <optgroup label="ModelScope">
                                    <option value="Tongyi-MAI/Z-Image-Turbo">Tongyi-MAI/Z-Image-Turbo</option>
                                    <option value="Qwen/Qwen-Image-Edit-2511">Qwen/Qwen-Image-Edit-2511</option>
                                </optgroup>
                                <optgroup label="HuggingFace">
                                    <option value="z-image-turbo">z-image-turbo</option>
                                    <option value="Qwen-Image-Edit-2511">Qwen-Image-Edit-2511</option>
                                </optgroup>
                            </select>
                        </div>
                        <div class="img-router-field">
                            <label>尺寸</label>
                            <select id="img-router-size" class="img-router-input">
                                <option value="">默认</option>
                                <option value="512x512">512x512</option>
                                <option value="768x768">768x768</option>
                                <option value="1024x1024">1024x1024</option>
                                <option value="768x1024">768x1024</option>
                                <option value="1024x768">1024x768</option>
                                <option value="1328x1328">1328x1328</option>
                                <option value="2048x2048">2048x2048</option>
                                <option value="2K">2K</option>
                            </select>
                        </div>
                        <label><input type="checkbox" id="img-router-stream" checked /> 流式响应</label>
                    </div>

                    <div class="img-router-section">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                            <h4 style="margin:0;">🖼️ 参考图片 (图生图)</h4>
                            <div style="display:flex; align-items:center; gap:10px;">
                                <label style="font-size:0.9em; cursor:pointer; display:flex; align-items:center;">
                                    <input type="checkbox" id="img-router-fix-ref" style="margin-right:4px;" /> 固定此图
                                </label>
                                <small id="img-router-clear-images" style="cursor:pointer; color:#f44336; display:none;">清除</small>
                            </div>
                        </div>
                        <label id="img-router-upload-area" class="img-router-upload-zone" for="img-router-file-input">
                            <i class="fa-solid fa-cloud-arrow-up" style="font-size: 2em; margin-bottom: 5px;"></i>
                            <p style="margin:0">点击或拖拽上传图片</p>
                        </label>
                        <input type="file" id="img-router-file-input" accept="image/*" multiple style="display:none;" />
                        <div id="img-router-preview-container" class="img-router-preview-list"></div>
                    </div>

                    <div class="img-router-section">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <h4>📜 历史生成 (最近20张)</h4>
                            <small id="img-router-clear-history" style="cursor:pointer; color:#f44336;">清空历史</small>
                        </div>
                        <div id="img-router-history-container"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modalOverlay);

        fab.addEventListener('click', function() { 
            if (this.dataset.dragging !== 'true') toggleModal(); 
        });
        
        document.getElementById('img-router-modal-close').onclick = (e) => { e.preventDefault(); e.stopPropagation(); modalOverlay.classList.remove('active'); };
        modalOverlay.onclick = (e) => { if (e.target === modalOverlay) modalOverlay.classList.remove('active'); };

        initFabDrag(fab);
        initModalDrag();
        loadSettings();
        setupEventHandlers();
        
        startChatObserver();
        setTimeout(processChatMessages, 1000);
        console.log('[img-router] Ready.');
    } catch (error) { console.error(error); }
});
