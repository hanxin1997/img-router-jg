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
 * Extract image from markdown content
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
 * Add generate button to chat message
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
 */
function processChatMessages() {
    const chat = getContext().chat;
    if (!chat || chat.length === 0) return;

    $('#chat .mes').each(function(index) {
        const messageText = $(this).find('.mes_text').text().trim();
        if (messageText && messageText.length > 10) {
            addGenerateButtonToMessage(this, messageText);
        }
    });
}

/**
 * 处理消息中的 image###提示词### 关键词
 * 格式: image###这里是生图提示词###
 */
async function handleImageKeywordInMessage(messageId) {
    try {
        const context = getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return;

        // 获取最新消息
        const message = typeof messageId === 'number' ? chat[messageId] : chat[chat.length - 1];
        if (!message || !message.mes) return;

        const messageText = message.mes;

        // 匹配 image###提示词### 格式
        const imageKeywordRegex = /image###(.+?)###/gi;
        const matches = [...messageText.matchAll(imageKeywordRegex)];

        if (matches.length === 0) return;

        console.log(`[img-router] 检测到 ${matches.length} 个生图关键词`);

        for (const match of matches) {
            const prompt = match[1].trim();
            if (!prompt) continue;

            console.log(`[img-router] 自动生图提示词: ${prompt}`);
            toastr.info(`正在生成图片: ${prompt.substring(0, 50)}...`);

            // 调用生图API
            const content = await generateImage(prompt);

            if (content) {
                const imageUrl = extractImageFromContent(content);
                if (imageUrl) {
                    // 将生成的图片插入到聊天中
                    await insertGeneratedImageToChat(imageUrl, prompt, messageId);
                    toastr.success('图片生成成功!');
                } else {
                    toastr.warning('生成完成但未获取到图片');
                }
            } else {
                toastr.error('图片生成失败');
            }
        }
    } catch (error) {
        console.error('[img-router] 处理生图关键词失败:', error);
    }
}

/**
 * 将生成的图片插入到聊天中
 */
async function insertGeneratedImageToChat(imageUrl, prompt, messageId) {
    try {
        const context = getContext();
        const chat = context.chat;

        // 查找对应的消息元素
        const messageIndex = typeof messageId === 'number' ? messageId : chat.length - 1;
        const messageElement = $(`#chat .mes[mesid="${messageIndex}"]`);

        if (messageElement.length > 0) {
            // 在消息后插入生成的图片
            const imageContainer = $(`
                <div class="img-router-generated-inline">
                    <div class="img-router-generated-label">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 生成图片: ${prompt.substring(0, 30)}${prompt.length > 30 ? '...' : ''}
                    </div>
                    <img src="${imageUrl}" alt="Generated: ${prompt}" class="img-router-inline-image" />
                    <div class="img-actions">
                        <button class="img-router-inline-download" title="下载">
                            <i class="fa-solid fa-download"></i>
                        </button>
                        <button class="img-router-inline-copy" title="复制">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                    </div>
                </div>
            `);

            // 下载按钮
            imageContainer.find('.img-router-inline-download').on('click', () => {
                const link = document.createElement('a');
                link.href = imageUrl;
                link.download = `generated_${Date.now()}.png`;
                link.click();
            });

            // 复制按钮
            imageContainer.find('.img-router-inline-copy').on('click', async () => {
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

            // 插入到消息元素后
            messageElement.find('.mes_text').append(imageContainer);
        }
    } catch (error) {
        console.error('[img-router] 插入图片失败:', error);
    }
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
        setTimeout(processChatMessages, 100);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(processChatMessages, 100);
    });

    // 监听消息发送，检测 image###提示词### 关键词并自动生图
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

    function handleStart(e) {
        isDragging = true;
        hasMoved = false;

        const touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX;
        startY = touch.clientY;

        // 使用getBoundingClientRect获取正确的位置
        const rect = fabElement.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        fabElement.style.cursor = 'grabbing';
        fabElement.style.transition = 'none';
        $(fabElement).data('dragging', false);

        e.preventDefault();
    }

    function handleMove(e) {
        if (!isDragging) return;

        const touch = e.touches ? e.touches[0] : e;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;

        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            hasMoved = true;
            $(fabElement).data('dragging', true);
        }

        if (hasMoved) {
            let newX = initialLeft + dx;
            let newY = initialTop + dy;

            // Constrain to viewport
            newX = Math.max(0, Math.min(newX, window.innerWidth - fabElement.offsetWidth));
            newY = Math.max(0, Math.min(newY, window.innerHeight - fabElement.offsetHeight));

            fabElement.style.left = newX + 'px';
            fabElement.style.top = newY + 'px';
        }

        e.preventDefault();
    }

    function handleEnd() {
        if (isDragging) {
            isDragging = false;
            fabElement.style.cursor = 'grab';
            fabElement.style.transition = 'transform 0.2s, box-shadow 0.2s';
            setTimeout(() => {
                $(fabElement).data('dragging', false);
            }, 100);
        }
    }

    // Mouse events
    fabElement.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);

    // Touch events for mobile
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

        // 使用原生DOM创建FAB，确保兼容性（参考mobile-main实现）
        const fab = document.createElement('button');
        fab.id = 'img-router-fab';
        fab.title = '图像生成器';
        fab.innerHTML = '<i class="fa-solid fa-images"></i>';

        // 直接设置样式确保显示
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
        console.log('[img-router] FAB created and appended to body');

        // Create Modal Overlay using native DOM
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'img-router-modal-overlay';
        modalOverlay.innerHTML = `
            <div id="img-router-modal">
                <button id="img-router-modal-close">
                    <i class="fa-solid fa-times"></i>
                </button>
                <div id="img-router-modal-content"></div>
            </div>
        `;
        document.body.appendChild(modalOverlay);
        console.log('[img-router] Modal overlay created');

        // Load settings panel HTML
        try {
            // 尝试多个可能的路径
            const possiblePaths = [
                `${extensionFolderPath}/settings.html`,
                `/scripts/extensions/third_party/${extensionName}/settings.html`,
                `./scripts/extensions/third_party/${extensionName}/settings.html`,
                `extensions/third_party/${extensionName}/settings.html`,
            ];

            let settingsHtml = null;
            let loadedPath = null;

            for (const path of possiblePaths) {
                try {
                    console.log(`[img-router] Trying to load settings from: ${path}`);
                    settingsHtml = await $.get(path);
                    loadedPath = path;
                    break;
                } catch (e) {
                    console.log(`[img-router] Path failed: ${path}`);
                }
            }

            if (settingsHtml) {
                $('#img-router-modal-content').append(settingsHtml);
                console.log(`[img-router] Settings HTML loaded from: ${loadedPath}`);
            } else {
                throw new Error('All paths failed');
            }
        } catch (err) {
            console.error('[img-router] Failed to load settings.html:', err);
            // 如果加载失败，直接内嵌基础设置HTML
            $('#img-router-modal-content').html(`
                <div id="img-router-settings" class="img-router-panel">
                    <div class="img-router-header">
                        <h3>🎨 图像生成器</h3>
                        <span class="img-router-version">v1.1.0</span>
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
                            <input type="password" id="img-router-api-key" placeholder="根据密钥格式自动路由到对应渠道" />
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
                                <optgroup label="自动选择">
                                    <option value="">默认 (根据渠道自动选择)</option>
                                </optgroup>
                                <optgroup label="火山引擎 (豆包)">
                                    <option value="doubao-seedream-4-5-251128">doubao-seedream-4-5-251128 (推荐)</option>
                                    <option value="doubao-seedream-4-0-250828">doubao-seedream-4-0-250828</option>
                                </optgroup>
                                <optgroup label="Gitee 模力方舟 - 文生图">
                                    <option value="z-image-turbo">z-image-turbo (推荐)</option>
                                </optgroup>
                                <optgroup label="Gitee 模力方舟 - 图片编辑(同步)">
                                    <option value="Qwen-Image-Edit">Qwen-Image-Edit</option>
                                    <option value="HiDream-E1-Full">HiDream-E1-Full</option>
                                    <option value="FLUX.1-dev">FLUX.1-dev</option>
                                    <option value="FLUX.2-dev">FLUX.2-dev</option>
                                    <option value="FLUX.1-Kontext-dev">FLUX.1-Kontext-dev</option>
                                    <option value="HelloMeme">HelloMeme</option>
                                    <option value="Kolors">Kolors</option>
                                    <option value="OmniConsistency">OmniConsistency</option>
                                    <option value="InstantCharacter">InstantCharacter</option>
                                    <option value="DreamO">DreamO</option>
                                    <option value="LongCat-Image-Edit">LongCat-Image-Edit</option>
                                    <option value="AnimeSharp">AnimeSharp</option>
                                </optgroup>
                                <optgroup label="Gitee 模力方舟 - 图片编辑(异步)">
                                    <option value="Qwen-Image-Edit-2511">Qwen-Image-Edit-2511 (推荐)</option>
                                </optgroup>
                                <optgroup label="魔搭 ModelScope">
                                    <option value="Tongyi-MAI/Z-Image-Turbo">Tongyi-MAI/Z-Image-Turbo (文生图)</option>
                                    <option value="Qwen/Qwen-Image-Edit-2511">Qwen/Qwen-Image-Edit-2511 (图生图)</option>
                                </optgroup>
                                <optgroup label="HuggingFace">
                                    <option value="z-image-turbo">z-image-turbo (HF)</option>
                                    <option value="Qwen-Image-Edit-2511">Qwen-Image-Edit-2511 (HF)</option>
                                </optgroup>
                            </select>
                        </div>
                        <div class="img-router-field">
                            <label for="img-router-size">图片尺寸</label>
                            <select id="img-router-size">
                                <option value="">默认 (渠道推荐)</option>
                                <optgroup label="常用尺寸">
                                    <option value="512x512">512x512</option>
                                    <option value="768x768">768x768</option>
                                    <option value="1024x1024">1024x1024 (推荐)</option>
                                    <option value="1328x1328">1328x1328</option>
                                    <option value="2048x2048">2048x2048</option>
                                </optgroup>
                                <optgroup label="横向">
                                    <option value="1024x768">1024x768</option>
                                    <option value="1536x1024">1536x1024</option>
                                    <option value="1920x1080">1920x1080 (16:9)</option>
                                </optgroup>
                                <optgroup label="纵向">
                                    <option value="768x1024">768x1024</option>
                                    <option value="1024x1536">1024x1536</option>
                                    <option value="1080x1920">1080x1920 (9:16)</option>
                                </optgroup>
                                <optgroup label="火山引擎特殊">
                                    <option value="2K">2K (豆包推荐)</option>
                                </optgroup>
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
                            <small class="field-hint">对话中使用 image###提示词### 可自动触发生图</small>
                        </div>
                        <div class="img-router-field">
                            <button id="img-router-generate" class="menu_button menu_button_icon">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> 生成图片
                            </button>
                        </div>
                        <div id="img-router-result" class="img-router-result"></div>
                    </div>
                </div>
            `);
            console.log('[img-router] Using embedded fallback settings HTML');
        }

        // FAB click handler - toggle modal (点击开关切换)
        fab.addEventListener('click', function(e) {
            if (!$(this).data('dragging')) {
                // 切换模态框显示状态
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

        // FAB drag functionality
        initFabDrag(fab);

        // Load settings and setup handlers
        loadSettings();
        setupEventHandlers();

        // Process existing chat messages
        setTimeout(processChatMessages, 500);

        // 验证FAB是否在DOM中
        const fabCheck = document.getElementById('img-router-fab');
        if (fabCheck) {
            console.log('[img-router] FAB verification: element exists in DOM');
            console.log('[img-router] FAB computed style:', window.getComputedStyle(fabCheck).display);
            console.log('[img-router] FAB position:', fabCheck.getBoundingClientRect());
        } else {
            console.error('[img-router] FAB verification FAILED: element not found in DOM');
        }

        console.log('[img-router] Extension loaded successfully');
    } catch (error) {
        console.error('[img-router] Extension initialization failed:', error);
    }
});
