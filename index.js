// Image Router Extension for SillyTavern
// Supports text-to-image and image-to-image generation via img-router API

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../script.js';

import { extension_settings, getContext } from '../../../extensions.js';

const extensionName = 'img-router';
const extensionFolderPath = `scripts/extensions/third_party/${extensionName}`;

// Default settings
const defaultSettings = {
    apiUrl: 'http://127.0.0.1:10001',
    apiKey: '',
    model: '',
    size: '',
    stream: true,
    referenceImages: [],
};

// State
let isGenerating = false;

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
    // Update UI
    $('#img-router-api-url').val(extension_settings[extensionName].apiUrl);
    $('#img-router-api-key').val(extension_settings[extensionName].apiKey);
    $('#img-router-model').val(extension_settings[extensionName].model);
    $('#img-router-size').val(extension_settings[extensionName].size);
    $('#img-router-stream').prop('checked', extension_settings[extensionName].stream);
    updateImagePreviews();
}

function saveSetting(key, value) {
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function updateImagePreviews() {
    const container = $('#img-router-preview-container');
    const clearBtn = $('#img-router-clear-images');
    const images = extension_settings[extensionName].referenceImages || [];

    container.empty();
    if (images.length === 0) {
        clearBtn.hide();
        return;
    }
    clearBtn.show();

    images.forEach((imgData, index) => {
        const previewItem = $(`
            <div class="img-router-preview-item" data-index="${index}">
                <img src="${imgData}" alt="Reference ${index + 1}" />
                <button class="remove-btn" data-index="${index}">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
        `);
        container.append(previewItem);
    });
}

async function addReferenceImage(file) {
    const images = extension_settings[extensionName].referenceImages || [];
    if (images.length >= 3) {
        toastr.warning('Maximum 3 reference images allowed');
        return;
    }
    try {
        const base64 = await fileToBase64(file);
        images.push(base64);
        saveSetting('referenceImages', images);
        updateImagePreviews();
        toastr.success('Image added');
    } catch (error) {
        console.error('Failed to add image:', error);
        toastr.error('Failed to add image');
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
    toastr.info('All images cleared');
}

async function testConnection() {
    const statusEl = $('#img-router-connection-status');
    const apiUrl = $('#img-router-api-url').val().trim();

    if (!apiUrl) {
        statusEl.removeClass('success loading').addClass('error').text('URL required');
        return;
    }

    statusEl.removeClass('success error').addClass('loading').html('<i class="fa-solid fa-spinner fa-spin"></i> Testing...');

    try {
        const response = await fetch(`${apiUrl}/health`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });

        if (response.ok) {
            statusEl.removeClass('loading error').addClass('success').text('Connected!');
        } else {
            statusEl.removeClass('loading success').addClass('error').text(`Error: ${response.status}`);
        }
    } catch (error) {
        statusEl.removeClass('loading success').addClass('error').text('Connection failed');
    }
}

function buildMessages(prompt, images) {
    const content = [];
    if (prompt) {
        content.push({ type: 'text', text: prompt });
    }
    if (images && images.length > 0) {
        images.forEach(imgData => {
            content.push({ type: 'image_url', image_url: { url: imgData } });
        });
    }
    return [{
        role: 'user',
        content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
    }];
}

async function generateImage(prompt, referenceImages = null) {
    if (isGenerating) {
        toastr.warning('Generation in progress...');
        return null;
    }

    const settings = extension_settings[extensionName];
    const apiUrl = settings.apiUrl;
    const apiKey = settings.apiKey;

    if (!apiUrl) { toastr.error('Please configure API URL'); return null; }
    if (!apiKey) { toastr.error('Please configure API Key'); return null; }

    isGenerating = true;
    const images = referenceImages || settings.referenceImages || [];
    const messages = buildMessages(prompt, images);

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
            const errorText = await response.text();
            throw new Error(`API Error (${response.status}): ${errorText}`);
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
        return content;
    } catch (error) {
        console.error('Image generation failed:', error);
        toastr.error(`Generation failed: ${error.message}`);
        return null;
    } finally {
        isGenerating = false;
    }
}

function extractImageFromContent(content) {
    if (!content) return null;
    const match = content.match(/!\[.*?\]\((data:image\/[^)]+|https?:\/\/[^)]+)\)/);
    return match ? match[1] : null;
}

/**
 * 核心功能：扫描消息并替换关键词为蓝色链接
 */
function processChatMessages() {
    const chat = getContext().chat;
    if (!chat || chat.length === 0) return;

    $('#chat .mes').each(function() {
        const messageElement = $(this);
        const textContainer = messageElement.find('.mes_text');
        
        // 如果已经处理过（避免重复替换），检查是否包含特定的 class
        if (textContainer.find('.img-router-inline-trigger, .img-router-inline-result').length > 0) {
            // 即使已经处理过，也要确保事件绑定是活跃的（SillyTavern 可能会重绘）
            bindInlineEvents(textContainer);
            return;
        }

        let html = textContainer.html();
        // 正则匹配 image###...### (支持换行)
        const regex = /image###([\s\S]+?)###/g;

        if (regex.test(html)) {
            // 执行替换：将文本替换为 span 标签
            const newHtml = html.replace(regex, (match, prompt) => {
                const safePrompt = prompt.replace(/"/g, '&quot;');
                // 返回蓝色链接 HTML
                return `<span class="img-router-inline-trigger" data-prompt="${safePrompt}" title="${safePrompt}">[生成图片]</span>`;
            });

            textContainer.html(newHtml);
            bindInlineEvents(textContainer);
        }
    });
}

/**
 * 绑定内联点击事件
 */
function bindInlineEvents(container) {
    // 1. 绑定“生成图片”点击事件
    container.find('.img-router-inline-trigger').off('click').on('click', async function(e) {
        e.stopPropagation();
        const trigger = $(this);
        const prompt = trigger.attr('data-prompt'); // 使用 attr 获取原始值

        if (isGenerating) {
            toastr.warning('已有任务正在进行中...');
            return;
        }

        // 变为加载状态
        trigger.removeClass('img-router-inline-trigger').addClass('img-router-loading');
        trigger.html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...');

        try {
            toastr.info('开始生成图片...');
            const content = await generateImage(prompt);
            
            if (content) {
                const imageUrl = extractImageFromContent(content);
                if (imageUrl) {
                    // 生成成功：替换为图片
                    const imgHtml = `
                        <div class="img-router-inline-result">
                            <img src="${imageUrl}" class="zoomable" onclick="clickZoom(this)" alt="${prompt}" />
                            <div class="img-router-inline-actions">
                                <i class="fa-solid fa-download" title="下载" onclick="event.stopPropagation(); const a = document.createElement('a'); a.href='${imageUrl}'; a.download='gen_${Date.now()}.png'; a.click();"></i>
                            </div>
                        </div>
                    `;
                    trigger.replaceWith(imgHtml);
                    toastr.success('生成成功');
                } else {
                    throw new Error('未获取到图片');
                }
            } else {
                throw new Error('API返回为空');
            }
        } catch (err) {
            // 失败：恢复链接状态并提示
            trigger.removeClass('img-router-loading').addClass('img-router-inline-trigger');
            trigger.html('[生成失败-点击重试]');
            toastr.error(err.message);
        }
    });
}

/**
 * 注入 CSS 样式 (解决 UI 问题)
 */
function injectCustomStyles() {
    const styleId = 'img-router-injected-style';
    if (document.getElementById(styleId)) return;

    const css = `
        /* 蓝色链接样式 */
        .img-router-inline-trigger {
            color: #3b82f6; /* 亮蓝色 */
            font-weight: bold;
            cursor: pointer;
            text-decoration: underline;
            transition: color 0.2s;
            margin: 0 4px;
        }
        .img-router-inline-trigger:hover {
            color: #60a5fa;
        }

        /* 加载状态 */
        .img-router-loading {
            color: var(--SmartThemeQuoteColor);
            font-size: 0.9em;
            cursor: wait;
        }

        /* 生成结果图片容器 */
        .img-router-inline-result {
            display: inline-block;
            position: relative;
            margin: 10px 0;
            max-width: 100%;
        }
        
        /* 图片本身 */
        .img-router-inline-result img {
            max-width: 100%;
            max-height: 400px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            cursor: zoom-in;
            display: block;
        }

        /* 图片右下角小工具栏 */
        .img-router-inline-actions {
            position: absolute;
            bottom: 5px;
            right: 5px;
            background: rgba(0,0,0,0.6);
            border-radius: 4px;
            padding: 4px;
            display: flex;
            gap: 5px;
            opacity: 0;
            transition: opacity 0.2s;
        }
        .img-router-inline-result:hover .img-router-inline-actions {
            opacity: 1;
        }
        .img-router-inline-actions i {
            color: white;
            cursor: pointer;
            font-size: 14px;
            padding: 2px;
        }
        .img-router-inline-actions i:hover {
            color: #3b82f6;
        }

        /* 修复 Modal 移动端显示问题 */
        #img-router-modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(3px);
            z-index: 20000; /* 提高层级 */
            display: none;
            /* 关键：移动端允许滚动，不强制居中 */
            overflow-y: auto; 
            padding: 20px 0; 
        }
        #img-router-modal-overlay.active {
            display: flex;
            justify-content: center;
            align-items: flex-start; /* 顶部对齐 */
        }

        #img-router-modal {
            background: var(--SmartThemeBlurTintColor, #1a1a2e);
            border-radius: 12px;
            width: 90%;
            max-width: 500px;
            /* 移除 max-height 限制，让内容撑开 */
            margin: 40px auto; /* 上下留出空间 */
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            border: 1px solid var(--SmartThemeBorderColor, #333);
            position: relative;
            display: flex;
            flex-direction: column;
        }

        /* 关闭按钮修复 */
        #img-router-modal-close {
            position: absolute;
            top: -15px; /* 移到框外右上角，防止遮挡内容 */
            right: -10px;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            background: #f44336;
            color: white;
            border: 2px solid white;
            cursor: pointer;
            z-index: 20001;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }

        /* 移动端特殊适配 */
        @media (max-width: 768px) {
            #img-router-modal {
                width: 95%;
                margin: 60px auto 20px auto; /* 顶部留出更多空间给状态栏 */
            }
            #img-router-modal-close {
                top: -20px;
                right: 0;
            }
            /* 确保输入框文字不被遮挡 */
            .img-router-field input {
                font-size: 16px; 
            }
        }
    `;

    const style = document.createElement('style');
    style.id = styleId;
    style.innerHTML = css;
    document.head.appendChild(style);
}

function setupEventHandlers() {
    $('#img-router-api-url').on('input', function() { saveSetting('apiUrl', $(this).val().trim()); });
    $('#img-router-api-key').on('input', function() { saveSetting('apiKey', $(this).val().trim()); });
    $('#img-router-model').on('change', function() { saveSetting('model', $(this).val()); });
    $('#img-router-size').on('change', function() { saveSetting('size', $(this).val()); });
    $('#img-router-stream').on('change', function() { saveSetting('stream', $(this).prop('checked')); });
    $('#img-router-test-connection').on('click', testConnection);

    const uploadZone = $('#img-router-upload-area');
    const fileInput = $('#img-router-file-input');
    uploadZone.on('click', () => fileInput.trigger('click'));
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
    
    // 监听消息变化
    eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(processChatMessages, 200));
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(processChatMessages, 200));
    eventSource.on(event_types.MESSAGE_SENT, () => setTimeout(processChatMessages, 200));
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
        if (e.type === 'touchend' && !hasMoved) { e.preventDefault(); fabElement.click(); }
        setTimeout(() => fabElement.dataset.dragging = 'false', 100);
    }

    fabElement.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    fabElement.addEventListener('touchstart', handleStart, { passive: false });
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
}

jQuery(async () => {
    try {
        console.log('[img-router] Starting extension initialization...');
        
        // 注入 CSS
        injectCustomStyles();

        // 创建 FAB
        const fab = document.createElement('button');
        fab.id = 'img-router-fab';
        fab.innerHTML = '<i class="fa-solid fa-images"></i>';
        // FAB 样式也内联一部分，防止 style.css 缺失
        fab.style.cssText = `position: fixed; top: 65vh; left: 20px; width: 50px; height: 50px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; justify-content: center; align-items: center; cursor: grab; z-index: 19999; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); border: none; color: white; font-size: 24px;`;
        document.body.appendChild(fab);

        // 创建 Modal
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'img-router-modal-overlay';
        modalOverlay.innerHTML = `
            <div id="img-router-modal">
                <button id="img-router-modal-close"><i class="fa-solid fa-times"></i></button>
                <div id="img-router-modal-content">
                    <!-- 内嵌设置面板 HTML -->
                    <div id="img-router-settings" class="img-router-panel" style="padding: 15px;">
                        <div class="img-router-header" style="border-bottom: 1px solid #444; margin-bottom: 15px; padding-bottom: 10px;">
                            <h3 style="margin:0;">🎨 图像生成器 <span style="font-size:0.6em; opacity:0.7;">v1.3.0</span></h3>
                        </div>
                        <div class="img-router-section" style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; margin-bottom: 15px;">
                            <h4 style="margin-top:0;">🔗 API 配置</h4>
                            <div class="img-router-field" style="margin-bottom: 10px;">
                                <label>服务器地址</label>
                                <input type="text" id="img-router-api-url" placeholder="http://127.0.0.1:10001" style="width:100%; padding:8px; border-radius:4px; border:1px solid #555; background:#222; color:white;" />
                            </div>
                            <div class="img-router-field" style="margin-bottom: 10px;">
                                <label>API 密钥 (明文)</label>
                                <input type="text" id="img-router-api-key" placeholder="请输入 API Key" style="width:100%; padding:8px; border-radius:4px; border:1px solid #555; background:#222; color:white;" />
                            </div>
                            <button id="img-router-test-connection" class="menu_button">测试连接</button>
                            <span id="img-router-connection-status" style="margin-left:10px;"></span>
                        </div>
                        
                        <div class="img-router-section" style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; margin-bottom: 15px;">
                            <h4 style="margin-top:0;">⚙️ 生成设置</h4>
                            <div class="img-router-field" style="margin-bottom: 10px;">
                                <label>模型</label>
                                <select id="img-router-model" style="width:100%; padding:8px; border-radius:4px; border:1px solid #555; background:#222; color:white;">
                                    <option value="">默认 (自动)</option>
                                    <optgroup label="火山引擎"><option value="doubao-seedream-4-5-251128">doubao-seedream-4-5-251128</option></optgroup>
                                    <optgroup label="Gitee"><option value="z-image-turbo">z-image-turbo</option><option value="Qwen-Image-Edit-2511">Qwen-Image-Edit-2511</option></optgroup>
                                </select>
                            </div>
                            <div class="img-router-field" style="margin-bottom: 10px;">
                                <label>尺寸</label>
                                <select id="img-router-size" style="width:100%; padding:8px; border-radius:4px; border:1px solid #555; background:#222; color:white;">
                                    <option value="">默认</option>
                                    <option value="1024x1024">1024x1024</option>
                                    <option value="768x1024">768x1024</option>
                                    <option value="1024x768">1024x768</option>
                                </select>
                            </div>
                            <label><input type="checkbox" id="img-router-stream" checked /> 流式响应</label>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modalOverlay);

        // 事件绑定
        fab.addEventListener('click', function() {
            if (this.dataset.dragging !== 'true') modalOverlay.classList.toggle('active');
        });

        // 强制关闭逻辑：直接绑定到 ID，防止冒泡问题
        const closeBtn = document.getElementById('img-router-modal-close');
        closeBtn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            modalOverlay.classList.remove('active');
        };

        modalOverlay.onclick = function(e) {
            if (e.target === this) modalOverlay.classList.remove('active');
        };

        initFabDrag(fab);
        loadSettings();
        setupEventHandlers();
        
        // 延迟扫描消息
        setTimeout(processChatMessages, 1000);

        console.log('[img-router] Extension loaded.');
    } catch (error) {
        console.error('[img-router] Init failed:', error);
    }
});