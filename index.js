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
    referenceImages: [], // Base64 encoded images
};

// State
let isGenerating = false;

/**
 * Initialize extension settings
 */
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    // Apply defaults for missing settings
    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }

    // Update UI with saved settings
    $('#img-router-api-url').val(extension_settings[extensionName].apiUrl);
    $('#img-router-api-key').val(extension_settings[extensionName].apiKey);
    $('#img-router-model').val(extension_settings[extensionName].model);
    $('#img-router-size').val(extension_settings[extensionName].size);
    $('#img-router-stream').prop('checked', extension_settings[extensionName].stream);

    // Restore reference images
    updateImagePreviews();
}

/**
 * Save a specific setting
 */
function saveSetting(key, value) {
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();
}

/**
 * Convert file to Base64
 */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Update image preview container
 */
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

/**
 * Add reference image
 */
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

/**
 * Remove reference image
 */
function removeReferenceImage(index) {
    const images = extension_settings[extensionName].referenceImages || [];
    images.splice(index, 1);
    saveSetting('referenceImages', images);
    updateImagePreviews();
}

/**
 * Clear all reference images
 */
function clearAllImages() {
    saveSetting('referenceImages', []);
    updateImagePreviews();
    toastr.info('All images cleared');
}

/**
 * Test API connection
 */
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
        console.error('Connection test failed:', error);
    }
}

/**
 * Build request messages for API
 */
function buildMessages(prompt, images) {
    const content = [];

    // Add text prompt
    if (prompt) {
        content.push({
            type: 'text',
            text: prompt,
        });
    }

    // Add reference images
    if (images && images.length > 0) {
        images.forEach(imgData => {
            content.push({
                type: 'image_url',
                image_url: { url: imgData },
            });
        });
    }

    return [{
        role: 'user',
        content: content.length === 1 && content[0].type === 'text'
            ? content[0].text
            : content,
    }];
}

/**
 * Generate image via API
 */
async function generateImage(prompt, referenceImages = null) {
    if (isGenerating) {
        toastr.warning('Generation in progress...');
        return null;
    }

    const settings = extension_settings[extensionName];
    const apiUrl = settings.apiUrl;
    const apiKey = settings.apiKey;

    if (!apiUrl) {
        toastr.error('Please configure API URL first');
        return null;
    }

    if (!apiKey) {
        toastr.error('Please configure API Key first');
        return null;
    }

    if (!prompt && (!referenceImages || referenceImages.length === 0)) {
        toastr.error('Please provide a prompt or reference images');
        return null;
    }

    isGenerating = true;

    const images = referenceImages || settings.referenceImages || [];
    const messages = buildMessages(prompt, images);

    const requestBody = {
        model: settings.model || undefined,
        messages: messages,
        stream: settings.stream,
        size: settings.size || undefined,
    };

    // Remove undefined fields
    Object.keys(requestBody).forEach(key => {
        if (requestBody[key] === undefined) {
            delete requestBody[key];
        }
    });

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
            // Handle SSE streaming response
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
                            if (delta) {
                                content += delta;
                            }
                        } catch (e) {
                            // Skip invalid JSON
                        }
                    }
                }
            }
        } else {
            // Handle JSON response
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

/**
 * Extract image from content
 */
function extractImageFromContent(content) {
    if (!content) return null;

    // Match markdown image syntax: ![alt](url)
    const match = content.match(/!\[.*?\]\((data:image\/[^)]+|https?:\/\/[^)]+)\)/);
    if (match) {
        return match[1];
    }

    return null;
}

/**
 * Handle quick generate button click
 */
async function handleQuickGenerate() {
    const prompt = $('#img-router-prompt').val().trim();
    const resultContainer = $('#img-router-result');

    resultContainer.html('<div class="loading"><i class="fa-solid fa-spinner"></i> Generating...</div>');

    const content = await generateImage(prompt);

    if (content) {
        const imageUrl = extractImageFromContent(content);
        if (imageUrl) {
            resultContainer.html(`
                <img src="${imageUrl}" alt="Generated Image" />
                <div class="img-actions">
                    <button class="img-router-download-btn">
                        <i class="fa-solid fa-download"></i> Download
                    </button>
                    <button class="img-router-copy-btn">
                        <i class="fa-solid fa-copy"></i> Copy
                    </button>
                </div>
            `);

            // Download button handler
            resultContainer.find('.img-router-download-btn').on('click', () => {
                const link = document.createElement('a');
                link.href = imageUrl;
                link.download = `generated_${Date.now()}.png`;
                link.click();
            });

            // Copy button handler
            resultContainer.find('.img-router-copy-btn').on('click', async () => {
                try {
                    if (imageUrl.startsWith('data:')) {
                        const response = await fetch(imageUrl);
                        const blob = await response.blob();
                        await navigator.clipboard.write([
                            new ClipboardItem({ [blob.type]: blob })
                        ]);
                    } else {
                        await navigator.clipboard.writeText(imageUrl);
                    }
                    toastr.success('Image copied to clipboard');
                } catch (e) {
                    toastr.error('Failed to copy image');
                }
            });
        } else {
            resultContainer.html(`<div class="error">No image in response</div>`);
        }
    } else {
        resultContainer.html(`<div class="error">Generation failed</div>`);
    }
}

/**
 * Add generate button to chat message (Manual trigger)
 */
function addGenerateButtonToMessage(messageElement, messageText) {
    // Check if button already exists
    if ($(messageElement).find('.img-router-chat-btn').length > 0) {
        return;
    }

    const button = $(`
        <button class="img-router-chat-btn" title="Generate image from this text">
            <i class="fa-solid fa-image"></i> Generate
        </button>
    `);

    button.on('click', async function(e) {
        e.stopPropagation();

        const btn = $(this);
        const originalHtml = btn.html();
        btn.html('<i class="fa-solid fa-spinner fa-spin"></i>').prop('disabled', true);

        const content = await generateImage(messageText);

        btn.html(originalHtml).prop('disabled', false);

        if (content) {
            const imageUrl = extractImageFromContent(content);
            if (imageUrl) {
                // Insert generated image after the message
                const imageContainer = $(`
                    <div class="img-router-generated">
                        <img src="${imageUrl}" alt="Generated Image" />
                        <div class="img-actions">
                            <button class="download-btn">
                                <i class="fa-solid fa-download"></i> Download
                            </button>
                        </div>
                    </div>
                `);

                imageContainer.find('.download-btn').on('click', () => {
                    const link = document.createElement('a');
                    link.href = imageUrl;
                    link.download = `generated_${Date.now()}.png`;
                    link.click();
                });

                $(messageElement).after(imageContainer);
                toastr.success('Image generated!');
            }
        }
    });

    // Append button to message actions area or end of message
    const actionsArea = $(messageElement).find('.mes_buttons');
    if (actionsArea.length > 0) {
        actionsArea.append(button);
    } else {
        $(messageElement).append(button);
    }
}

/**
 * Process chat messages and add generate buttons
 * 修复：同时扫描历史消息中的 image### 关键词
 */
function processChatMessages() {
    const chat = getContext().chat;
    if (!chat || chat.length === 0) return;

    $('#chat .mes').each(function(index) {
        // 1. 添加通用的“生成”小按钮
        const messageText = $(this).find('.mes_text').text().trim();
        if (messageText && messageText.length > 10) {
            addGenerateButtonToMessage(this, messageText);
        }

        // 2. 扫描该消息是否包含 image### 关键词并渲染大按钮
        // 获取消息ID (mesid)
        const mesId = $(this).attr('mesid');
        if (mesId !== undefined) {
             handleImageKeywordInMessage(parseInt(mesId));
        }
    });
}

/**
 * 处理消息中的 image###提示词### 关键词
 * 修复：支持多行匹配 ([\s\S]+?)
 */
async function handleImageKeywordInMessage(messageId) {
    try {
        const context = getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return;

        // 获取最新消息或指定消息
        const messageIndex = typeof messageId === 'number' ? messageId : chat.length - 1;
        const message = chat[messageIndex];
        
        if (!message || !message.mes) return;

        const messageText = message.mes;

        // 匹配 image###提示词### 格式
        // 修复：使用 [\s\S] 替代 . 以匹配换行符
        const imageKeywordRegex = /image###([\s\S]+?)###/gi;
        const matches = [...messageText.matchAll(imageKeywordRegex)];

        if (matches.length === 0) return;

        console.log(`[img-router] 检测到 ${matches.length} 个生图关键词 (MsgID: ${messageIndex})`);

        for (const match of matches) {
            const prompt = match[1].trim();
            if (!prompt) continue;

            // 调用插入按钮的函数
            await insertGenerateButtonForKeyword(prompt, messageIndex);
        }
    } catch (error) {
        console.error('[img-router] 处理生图关键词失败:', error);
    }
}

/**
 * 插入“点击生成”按钮卡片
 */
async function insertGenerateButtonForKeyword(prompt, messageId) {
    const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
    if (messageElement.length === 0) return;

    const messageTextContainer = messageElement.find('.mes_text');
    
    // 防止重复添加：检查是否已经存在针对该提示词的按钮或结果
    // 使用简单的替换来处理引号，防止选择器报错
    const safePrompt = prompt.replace(/"/g, '&quot;');
    const existingButton = messageTextContainer.find(`.img-router-pending-block[data-prompt="${safePrompt}"]`);
    const existingResult = messageTextContainer.find(`.img-router-generated-inline[data-prompt="${safePrompt}"]`);
    
    if (existingButton.length > 0 || existingResult.length > 0) {
        return; 
    }

    // 创建待处理卡片 UI
    const pendingContainer = $(`
        <div class="img-router-generated-inline img-router-pending-block" data-prompt="${safePrompt}">
            <div class="img-router-generated-label" style="color: var(--SmartThemeBodyColor);">
                <i class="fa-solid fa-paint-brush"></i> 检测到生图请求
            </div>
            <div style="padding: 10px; background: rgba(0,0,0,0.1); border-radius: 6px; margin: 5px 0; font-size: 0.9em; font-style: italic; white-space: pre-wrap;">"${prompt}"</div>
            <div class="img-actions" style="justify-content: center;">
                <button class="img-router-trigger-btn menu_button">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> 立即生成图片
                </button>
            </div>
        </div>
    `);

    // 绑定点击生成事件
    pendingContainer.find('.img-router-trigger-btn').on('click', async function() {
        const btn = $(this);
        const container = btn.closest('.img-router-pending-block');
        
        // 1. 切换到加载状态
        btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 正在请求 API...');
        
        try {
            toastr.info(`开始生成...`);
            
            // 2. 调用生成 API
            const content = await generateImage(prompt);
            
            if (content) {
                const imageUrl = extractImageFromContent(content);
                if (imageUrl) {
                    // 3. 生成成功：构建结果 UI
                    const resultHtml = createResultHtml(imageUrl, prompt);
                    const resultElement = $(resultHtml);
                    
                    // 绑定结果 UI 的按钮事件
                    bindResultEvents(resultElement, imageUrl);
                    
                    // 替换原有卡片
                    container.replaceWith(resultElement);
                    toastr.success('图片生成完毕');
                } else {
                    throw new Error('未获取到图片 URL');
                }
            } else {
                throw new Error('生成返回为空');
            }
        } catch (error) {
            // 4. 生成失败：恢复按钮状态并显示错误
            console.error(error);
            toastr.error('生成失败，请重试');
            btn.prop('disabled', false).html('<i class="fa-solid fa-rotate-right"></i> 生成失败 - 点击重试');
            
            // 移除旧的错误信息（如果有）
            container.find('.error-msg').remove();
            container.append(`<div class="error-msg" style="color: red; font-size: 0.8em; text-align: center; margin-top: 5px;">${error.message}</div>`);
        }
    });

    // 插入到消息末尾
    messageTextContainer.append(pendingContainer);
}

/**
 * 辅助函数：创建结果 HTML 结构
 */
function createResultHtml(imageUrl, prompt) {
    const safePrompt = prompt.replace(/"/g, '&quot;');
    return `
        <div class="img-router-generated-inline" data-prompt="${safePrompt}">
            <div class="img-router-generated-label">
                <i class="fa-solid fa-wand-magic-sparkles"></i> 生成完成
            </div>
            <img src="${imageUrl}" alt="Generated Image" class="img-router-inline-image" />
            <div class="img-actions">
                <button class="img-router-inline-download" title="下载">
                    <i class="fa-solid fa-download"></i>
                </button>
                <button class="img-router-inline-copy" title="复制">
                    <i class="fa-solid fa-copy"></i>
                </button>
            </div>
        </div>
    `;
}

/**
 * 辅助函数：绑定结果 UI 的事件（下载/复制）
 */
function bindResultEvents(element, imageUrl) {
    // 下载按钮
    element.find('.img-router-inline-download').on('click', () => {
        const link = document.createElement('a');
        link.href = imageUrl;
        link.download = `generated_${Date.now()}.png`;
        link.click();
    });

    // 复制按钮
    element.find('.img-router-inline-copy').on('click', async () => {
        try {
            if (imageUrl.startsWith('data:')) {
                const response = await fetch(imageUrl);
                const blob = await response.blob();
                await navigator.clipboard.write([
                    new ClipboardItem({ [blob.type]: blob })
                ]);
            } else {
                await navigator.clipboard.writeText(imageUrl);
            }
            toastr.success('图片已复制到剪贴板');
        } catch (e) {
            toastr.error('复制失败');
        }
    });
}

/**
 * Setup event handlers
 */
function setupEventHandlers() {
    // Settings panel input handlers
    $('#img-router-api-url').on('input', function() {
        saveSetting('apiUrl', $(this).val().trim());
    });

    $('#img-router-api-key').on('input', function() {
        saveSetting('apiKey', $(this).val().trim());
    });

    $('#img-router-model').on('change', function() {
        saveSetting('model', $(this).val());
    });

    $('#img-router-size').on('change', function() {
        saveSetting('size', $(this).val());
    });

    $('#img-router-stream').on('change', function() {
        saveSetting('stream', $(this).prop('checked'));
    });

    // Test connection button
    $('#img-router-test-connection').on('click', testConnection);

    // Image upload handlers
    const uploadZone = $('#img-router-upload-area');
    const fileInput = $('#img-router-file-input');

    uploadZone.on('click', () => fileInput.trigger('click'));

    uploadZone.on('dragover', function(e) {
        e.preventDefault();
        $(this).addClass('dragover');
    });

    uploadZone.on('dragleave drop', function(e) {
        e.preventDefault();
        $(this).removeClass('dragover');
    });

    uploadZone.on('drop', async function(e) {
        const files = e.originalEvent.dataTransfer.files;
        for (const file of files) {
            if (file.type.startsWith('image/')) {
                await addReferenceImage(file);
            }
        }
    });

    fileInput.on('change', async function() {
        const files = this.files;
        for (const file of files) {
            await addReferenceImage(file);
        }
        this.value = '';
    });

    // Remove image button (delegated)
    $('#img-router-preview-container').on('click', '.remove-btn', function(e) {
        e.stopPropagation();
        const index = parseInt($(this).data('index'));
        removeReferenceImage(index);
    });

    // Clear all images button
    $('#img-router-clear-images').on('click', clearAllImages);

    // Quick generate button
    $('#img-router-generate').on('click', handleQuickGenerate);

    // Listen for new messages to add generate buttons
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        setTimeout(processChatMessages, 500);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(processChatMessages, 500);
    });

    // 监听消息发送，检测 image###提示词### 关键词
    eventSource.on(event_types.MESSAGE_SENT, async (messageId) => {
        await handleImageKeywordInMessage(messageId);
    });

    // 监听AI回复消息，检测 image###提示词### 关键词
    eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId) => {
        await handleImageKeywordInMessage(messageId);
    });
}

/**
 * Initialize FAB drag functionality (mobile & desktop)
 */
function initFabDrag(fabElement) {
    let isDragging = false;
    let hasMoved = false;
    let startX, startY, initialLeft, initialTop;
    const clickThreshold = 5; 

    function handleStart(e) {
        if (e.type === 'touchstart') {
            e.preventDefault();
        }
        
        isDragging = true;
        hasMoved = false; 

        const touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX;
        startY = touch.clientY;

        const rect = fabElement.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

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

            let newX = initialLeft + dx;
            let newY = initialTop + dy;

            newX = Math.max(0, Math.min(newX, window.innerWidth - fabElement.offsetWidth));
            newY = Math.max(0, Math.min(newY, window.innerHeight - fabElement.offsetHeight));

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
            fabElement.click(); 
        }

        setTimeout(() => {
            fabElement.dataset.dragging = 'false';
        }, 100);
    }

    fabElement.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);

    fabElement.addEventListener('touchstart', handleStart, { passive: false });
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
}

/**
 * Initialize the extension
 */
jQuery(async () => {
    try {
        console.log('[img-router] Starting extension initialization...');

        // 1. 创建 FAB
        const fab = document.createElement('button');
        fab.id = 'img-router-fab';
        fab.title = '图像生成器';
        fab.innerHTML = '<i class="fa-solid fa-images"></i>';
        fab.style.cssText = `
            position: fixed !important;
            top: 65vh;
            left: 20px;
            width: 50px !important;
            height: 50px !important;
            border-radius: 50% !important;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
            display: flex !important;
            justify-content: center !important;
            align-items: center !important;
            cursor: grab !important;
            z-index: 99999 !important;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4) !important;
            transition: transform 0.2s, box-shadow 0.2s !important;
            user-select: none !important;
            border: none !important;
            visibility: visible !important;
            opacity: 1 !important;
            pointer-events: auto !important;
        `;
        document.body.appendChild(fab);

        // 2. 创建 Modal Overlay
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'img-router-modal-overlay';
        
        // 修复手机端滚动问题：添加特定样式
        // 在移动端禁用 flex 居中，改用顶部边距，防止内容被遮挡
        const style = document.createElement('style');
        style.innerHTML = `
            @media (max-width: 768px) {
                #img-router-modal-overlay {
                    display: block !important; /* 禁用 flex 居中 */
                    overflow-y: auto !important; /* 允许 overlay 滚动 */
                    padding-top: 50px !important;
                    padding-bottom: 50px !important;
                }
                #img-router-modal {
                    margin: 0 auto !important; /* 水平居中 */
                    max-height: none !important; /* 允许 modal 撑开 */
                    height: auto !important;
                    position: relative !important;
                }
            }
        `;
        document.head.appendChild(style);

        modalOverlay.innerHTML = `
            <div id="img-router-modal">
                <button id="img-router-modal-close">
                    <i class="fa-solid fa-times"></i>
                </button>
                <div id="img-router-modal-content"></div>
            </div>
        `;
        document.body.appendChild(modalOverlay);

        // 3. 加载设置 HTML (内嵌回退方案)
        // 修复：API Key 改为 type="text"
        const embeddedSettingsHtml = `
            <div id="img-router-settings" class="img-router-panel">
                <div class="img-router-header">
                    <h3>🎨 图像生成器</h3>
                    <span class="img-router-version">v1.2.0</span>
                </div>
                <div class="img-router-section">
                    <h4>🔗 API 配置</h4>
                    <div class="img-router-field">
                        <label for="img-router-api-url">img-router 服务器地址</label>
                        <input type="text" id="img-router-api-url" placeholder="http://127.0.0.1:10001" />
                        <small class="field-hint">运行 img-router-main 服务的地址</small>
                    </div>
                    <div class="img-router-field">
                        <label for="img-router-api-key">API 密钥</label>
                        <!-- 修复：type="text" 显示明文 -->
                        <input type="text" id="img-router-api-key" placeholder="根据密钥格式自动路由到对应渠道" />
                        <small class="field-hint">
                            支持: 豆包(UUID格式) | Gitee(30-60位字母数字) | 魔搭(ms-开头) | HuggingFace(hf_开头)
                        </small>
                    </div>
                    <div class="img-router-field">
                        <button id="img-router-test-connection" class="menu_button">测试连接</button>
                        <span id="img-router-connection-status"></span>
                    </div>
                </div>
                <div class="img-router-section">
                    <h4>⚙️ 生成设置</h4>
                    <div class="img-router-field">
                        <label for="img-router-model">模型选择</label>
                        <select id="img-router-model">
                            <option value="">默认 (根据渠道自动选择)</option>
                            <optgroup label="火山引擎 (豆包)">
                                <option value="doubao-seedream-4-5-251128">doubao-seedream-4-5-251128 (推荐)</option>
                                <option value="doubao-seedream-4-0-250828">doubao-seedream-4-0-250828</option>
                            </optgroup>
                            <optgroup label="Gitee 模力方舟">
                                <option value="z-image-turbo">z-image-turbo</option>
                                <option value="Qwen-Image-Edit-2511">Qwen-Image-Edit-2511</option>
                                <option value="FLUX.1-Kontext-dev">FLUX.1-Kontext-dev</option>
                            </optgroup>
                            <optgroup label="魔搭 ModelScope">
                                <option value="Tongyi-MAI/Z-Image-Turbo">Tongyi-MAI/Z-Image-Turbo</option>
                                <option value="Qwen/Qwen-Image-Edit-2511">Qwen/Qwen-Image-Edit-2511</option>
                            </optgroup>
                        </select>
                    </div>
                    <div class="img-router-field">
                        <label for="img-router-size">图片尺寸</label>
                        <select id="img-router-size">
                            <option value="">默认 (渠道推荐)</option>
                            <option value="1024x1024">1024x1024 (1:1)</option>
                            <option value="1024x768">1024x768 (4:3)</option>
                            <option value="768x1024">768x1024 (3:4)</option>
                            <option value="1920x1080">1920x1080 (16:9)</option>
                            <option value="1080x1920">1080x1920 (9:16)</option>
                        </select>
                    </div>
                    <div class="img-router-field">
                        <label><input type="checkbox" id="img-router-stream" checked /> 启用流式响应</label>
                    </div>
                </div>
                <div class="img-router-section">
                    <h4>🖼️ 参考图片 (图生图)</h4>
                    <div class="img-router-field">
                        <div id="img-router-upload-area" class="img-router-upload-zone">
                            <div class="upload-placeholder">
                                <i class="fa-solid fa-cloud-arrow-up"></i>
                                <p>点击或拖拽图片到此处</p>
                                <small>支持 PNG, JPG, WebP (最多3张)</small>
                            </div>
                            <input type="file" id="img-router-file-input" accept="image/*" multiple hidden />
                        </div>
                        <div id="img-router-preview-container" class="img-router-preview-list"></div>
                        <button id="img-router-clear-images" class="menu_button" style="display:none;">清除所有图片</button>
                    </div>
                </div>
                <div class="img-router-section">
                    <h4>✨ 快速生成</h4>
                    <div class="img-router-field">
                        <label for="img-router-prompt">提示词</label>
                        <textarea id="img-router-prompt" rows="3" placeholder="请输入图片描述..."></textarea>
                    </div>
                    <div class="img-router-field">
                        <button id="img-router-generate" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> 生成图片
                        </button>
                    </div>
                    <div id="img-router-result" class="img-router-result"></div>
                </div>
            </div>
        `;

        // 尝试加载外部 HTML，失败则使用内嵌
        try {
            const possiblePaths = [
                `${extensionFolderPath}/settings.html`,
                `/scripts/extensions/third_party/${extensionName}/settings.html`
            ];
            
            let loaded = false;
            for (const path of possiblePaths) {
                try {
                    const html = await $.get(path);
                    if (html) {
                        $('#img-router-modal-content').append(html);
                        // 如果加载了外部文件，记得手动修改 input type
                        $('#img-router-api-key').attr('type', 'text');
                        loaded = true;
                        break;
                    }
                } catch(e) {}
            }
            
            if (!loaded) {
                $('#img-router-modal-content').html(embeddedSettingsHtml);
            }
        } catch (err) {
            $('#img-router-modal-content').html(embeddedSettingsHtml);
        }

        // FAB click handler
        fab.addEventListener('click', function(e) {
            if (this.dataset.dragging !== 'true') {
                if (modalOverlay.classList.contains('active')) {
                    modalOverlay.classList.remove('active');
                } else {
                    modalOverlay.classList.add('active');
                }
            }
        });

        // Close modal handlers
        document.getElementById('img-router-modal-close').addEventListener('click', function() {
            modalOverlay.classList.remove('active');
        });

        modalOverlay.addEventListener('click', function(e) {
            if (e.target === this) {
                modalOverlay.classList.remove('active');
            }
        });

        initFabDrag(fab);
        loadSettings();
        setupEventHandlers();
        
        // 延迟执行消息扫描，确保 DOM 已完全渲染
        setTimeout(processChatMessages, 1000);

        console.log('[img-router] Extension loaded successfully');
    } catch (error) {
        console.error('[img-router] Extension initialization failed:', error);
    }
});