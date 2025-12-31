// Image Router Extension for SillyTavern
// Supports text-to-image, image-to-image, history gallery, prompt prefix, fixed reference mode
// Fix: Mobile drag & drop (touch-action: none), MutationObserver, Inline Switch

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
    enableInline: true
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
        const div = $(`
            <div class="history-item" title="${item.prompt} (${item.time})">
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
    const apiUrl = $('#img-router-api-url').val().trim();
    if (!apiUrl) return toastr.error('请输入 API 地址');

    statusEl.html('<i class="fa-solid fa-spinner fa-spin"></i> Testing...');
    try {
        const response = await fetch(`${apiUrl}/health`);
        if (response.ok) statusEl.html('<span style="color:#4caf50">连接成功</span>');
        else statusEl.html(`<span style="color:#f44336">错误: ${response.status}</span>`);
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
    const apiUrl = settings.apiUrl;
    const apiKey = settings.apiKey;

    if (!apiUrl || !apiKey) {
        toastr.error('请先配置 API 地址和密钥');
        return null;
    }

    isGenerating = true;

    let finalPrompt = prompt;
    if (settings.promptPrefix && settings.promptPrefix.trim() !== '') {
        finalPrompt = `${settings.promptPrefix}, ${prompt}`;
        console.log(`[img-router] Applied Prefix: ${settings.promptPrefix}`);
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
        const response = await fetch(`${apiUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const txt = await response.text();
            throw new Error(`API Error ${response.status}: ${txt}`);
        }

        let content = '';
        if (settings.stream) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.substring(6).trim();
                        if (data === '[DONE]') continue;
                        try {
                            const json = JSON.parse(data);
                            const delta = json.choices?.[0]?.delta?.content;
                            if (delta) content += delta;
                        } catch (e) {}
                    }
                }
            }
        } else {
            const data = await response.json();
            content = data.choices?.[0]?.message?.content || '';
        }

        if (content && images.length > 0) {
            if (!settings.fixReferenceImages) {
                console.log('[img-router] Auto-clearing reference images');
                clearAllImages();
            }
        }

        return content;
    } catch (error) {
        console.error(error);
        toastr.error(`生成失败: ${error.message}`);
        return null;
    } finally {
        isGenerating = false;
    }
}

function extractImageFromContent(content) {
    if (!content) return null;
    const mdMatch = content.match(/!\[.*?\]\((.*?)\)/);
    if (mdMatch) return mdMatch[1];
    const urlMatch = content.match(/(https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|webp|gif|bmp))/i);
    if (urlMatch) return urlMatch[0];
    const base64Match = content.match(/(data:image\/[^;]+;base64,[^"\s]+)/);
    if (base64Match) return base64Match[1];
    const trimmed = content.trim();
    if ((trimmed.startsWith('http') || trimmed.startsWith('data:image')) && !trimmed.includes(' ')) return trimmed;
    return null;
}

// ================= 聊天内联交互逻辑 =================

function processChatMessages() {
    const isEnabled = extension_settings[extensionName]?.enableInline ?? true;
    const chat = getContext().chat;
    if (!chat || chat.length === 0) return;

    $('#chat .mes').each(function() {
        const messageElement = $(this);
        const textContainer = messageElement.find('.mes_text');
        
        if (!isEnabled) return;
        if (textContainer.find('.img-router-inline-trigger, .img-router-inline-result').length > 0) {
            bindInlineEvents(textContainer);
            return;
        }

        let html = textContainer.html();
        const regex = /image###([\s\S]+?)###/g;

        if (regex.test(html)) {
            const newHtml = html.replace(regex, (match, prompt) => {
                const safePrompt = prompt.replace(/"/g, '&quot;');
                return `<span class="img-router-inline-trigger" data-prompt="${safePrompt}" title="点击生成: ${safePrompt}">[生成图片]</span>`;
            });
            textContainer.html(newHtml);
            bindInlineEvents(textContainer);
        }
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
                    throw new Error('无法解析图片地址');
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
        for (const mutation of mutations) if (mutation.addedNodes.length > 0) { shouldProcess = true; break; }
        if (shouldProcess) processChatMessages();
    });
    chatObserver.observe(chatContainer, { childList: true, subtree: true });
    console.log('[img-router] Chat Observer started.');
}

// ================= UI 注入与初始化 =================

function injectCustomStyles() {
    if (document.getElementById('img-router-injected-style')) return;
    const css = `
        .img-router-inline-trigger { color: #3b82f6; font-weight: bold; cursor: pointer; text-decoration: underline; margin: 0 4px; }
        .img-router-inline-trigger:hover { color: #60a5fa; }
        .img-router-loading { color: var(--SmartThemeQuoteColor); font-size: 0.9em; cursor: wait; }
        .img-router-inline-result { display: inline-block; position: relative; margin: 10px 0; max-width: 100%; }
        .img-router-inline-result img { max-width: 100%; max-height: 400px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); cursor: zoom-in; display: block; }
        .img-router-inline-actions { position: absolute; bottom: 5px; right: 5px; background: rgba(0,0,0,0.6); border-radius: 4px; padding: 4px; display: flex; gap: 5px; opacity: 0; transition: opacity 0.2s; }
        .img-router-inline-result:hover .img-router-inline-actions { opacity: 1; }
        .img-router-inline-actions i { color: white; cursor: pointer; font-size: 14px; padding: 2px; }
        .img-router-inline-actions i:hover { color: #3b82f6; }
        #img-router-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); backdrop-filter: blur(3px); z-index: 20000; display: none; overflow-y: auto; padding: 20px 0; }
        #img-router-modal-overlay.active { display: flex; justify-content: center; align-items: flex-start; }
        #img-router-modal { background: var(--SmartThemeBlurTintColor, #1a1a2e); border-radius: 12px; width: 90%; max-width: 550px; margin: 40px auto; box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid var(--SmartThemeBorderColor, #444); position: relative; display: flex; flex-direction: column; color: var(--SmartThemeBodyColor, #fff); }
        .img-router-section { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.05); }
        .img-router-section h4 { margin: 0 0 10px 0; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px; font-size: 1em; }
        .img-router-field { margin-bottom: 10px; }
        .img-router-field label { display: block; font-size: 0.9em; margin-bottom: 4px; opacity: 0.9; }
        .img-router-input { width: 100%; padding: 8px; border-radius: 4px; border: 1px solid var(--SmartThemeBorderColor, #555); background: var(--SmartThemeEmColor, #222); color: var(--SmartThemeBodyColor, #fff); box-sizing: border-box; }
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
        
        /* 移动端适配 */
        @media (max-width: 768px) {
            #img-router-modal { width: 95%; margin: 60px auto 20px auto; }
            #img-router-modal-close { top: -20px; right: 0; }
            .img-router-input { font-size: 16px; }
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

/**
 * 修复版 FAB 拖拽逻辑
 * 1. 使用 touch-action: none 禁止浏览器默认滚动
 * 2. 移除 preventDefault 以允许点击
 * 3. 优化坐标计算
 */
function initFabDrag(fabElement) {
    // 关键：禁止浏览器处理触摸手势（如滚动、缩放），完全交由 JS 处理
    fabElement.style.touchAction = 'none';
    
    let isDragging = false;
    let hasMoved = false;
    let startX, startY;
    let initialLeft, initialTop;
    const clickThreshold = 5;

    // 统一处理开始事件
    function handleStart(e) {
        isDragging = true;
        hasMoved = false;
        
        // 获取触摸点或鼠标点
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        
        startX = clientX;
        startY = clientY;
        
        const rect = fabElement.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        
        fabElement.style.cursor = 'grabbing';
        fabElement.style.transition = 'none'; // 拖拽时移除过渡效果，防止延迟
        fabElement.dataset.dragging = 'false';
    }

    // 统一处理移动事件
    function handleMove(e) {
        if (!isDragging) return;
        
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        
        const dx = clientX - startX;
        const dy = clientY - startY;

        // 只有移动超过阈值才视为拖拽
        if (Math.abs(dx) > clickThreshold || Math.abs(dy) > clickThreshold) {
            hasMoved = true;
            fabElement.dataset.dragging = 'true';
            
            // 阻止默认事件（如页面滚动）仅在确认是拖拽时
            if (e.cancelable) e.preventDefault();

            let newX = initialLeft + dx;
            let newY = initialTop + dy;

            // 边界限制
            const maxX = window.innerWidth - fabElement.offsetWidth;
            const maxY = window.innerHeight - fabElement.offsetHeight;
            
            newX = Math.max(0, Math.min(newX, maxX));
            newY = Math.max(0, Math.min(newY, maxY));

            fabElement.style.left = newX + 'px';
            fabElement.style.top = newY + 'px';
        }
    }

    // 统一处理结束事件
    function handleEnd(e) {
        if (!isDragging) return;
        isDragging = false;
        
        fabElement.style.cursor = 'grab';
        fabElement.style.transition = 'transform 0.2s, box-shadow 0.2s';
        
        // 如果没有移动，视为点击，手动触发（因为 touch-action: none 可能影响）
        if (!hasMoved) {
            // 这里的点击逻辑由 fab.addEventListener('click') 处理
            // 我们只需要确保 dataset.dragging 为 false
        }
        
        setTimeout(() => {
            fabElement.dataset.dragging = 'false';
        }, 50);
    }

    // 绑定事件
    fabElement.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);

    // 移动端事件
    fabElement.addEventListener('touchstart', handleStart, { passive: false });
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
        
        // 初始位置设定为具体的像素值，避免 vh 在移动端键盘弹出时乱跳
        // 默认位置：左下角上方一点
        fab.style.cssText = `
            position: fixed; 
            top: ${window.innerHeight - 150}px; 
            left: 20px; 
            width: 50px; 
            height: 50px; 
            border-radius: 50%; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            cursor: grab; 
            z-index: 19999; 
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); 
            border: none; 
            color: white; 
            font-size: 24px;
            touch-action: none; /* 关键：修复移动端拖拽 */
        `;
        document.body.appendChild(fab);

        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'img-router-modal-overlay';
        modalOverlay.innerHTML = `
            <div id="img-router-modal">
                <button id="img-router-modal-close" style="position: absolute; top: -15px; right: -10px; width: 36px; height: 36px; border-radius: 50%; background: #f44336; color: white; border: 2px solid white; cursor: pointer; z-index: 20001; display: flex; justify-content: center; align-items: center; box-shadow: 0 2px 8px rgba(0,0,0,0.3);"><i class="fa-solid fa-times"></i></button>
                <div id="img-router-modal-content" style="padding: 15px;">
                    <div class="img-router-header" style="border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 15px; padding-bottom: 10px;">
                        <h3 style="margin:0;">🎨 图像生成器 <span style="font-size:0.6em; opacity:0.7;">v1.9.0</span></h3>
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
                            <label>API 密钥</label>
                            <input type="text" id="img-router-api-key" class="img-router-input" placeholder="请输入 API Key" />
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
                                <optgroup label="火山引擎"><option value="doubao-seedream-4-5-251128">doubao-seedream-4-5-251128</option></optgroup>
                                <optgroup label="Gitee"><option value="z-image-turbo">z-image-turbo</option><option value="Qwen-Image-Edit-2511">Qwen-Image-Edit-2511</option></optgroup>
                            </select>
                        </div>
                        <div class="img-router-field">
                            <label>尺寸</label>
                            <select id="img-router-size" class="img-router-input">
                                <option value="">默认</option>
                                <option value="1024x1024">1024x1024</option>
                                <option value="768x1024">768x1024</option>
                                <option value="1024x768">1024x768</option>
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

        fab.addEventListener('click', function() { if (this.dataset.dragging !== 'true') modalOverlay.classList.toggle('active'); });
        document.getElementById('img-router-modal-close').onclick = (e) => { e.preventDefault(); e.stopPropagation(); modalOverlay.classList.remove('active'); };
        modalOverlay.onclick = (e) => { if (e.target === modalOverlay) modalOverlay.classList.remove('active'); };

        initFabDrag(fab);
        loadSettings();
        setupEventHandlers();
        startChatObserver();
        
        setTimeout(processChatMessages, 1000);
        console.log('[img-router] Ready.');
    } catch (error) { console.error(error); }
});