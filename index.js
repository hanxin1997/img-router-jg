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
}

/**
 * Initialize the extension
 */
jQuery(async () => {
    // Load settings panel HTML
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);

    // Add settings panel to extensions panel
    $('#extensions_settings').append(settingsHtml);

    // Add sidebar button
    const sidebarButton = $(`
        <div id="img-router-button" class="list-group-item flex-container flexGap5" title="Image Router">
            <i class="fa-solid fa-images"></i>
            <span>Image Router</span>
        </div>
    `);

    // Insert into sidebar (extensions menu area)
    $('#extensionsMenu').append(sidebarButton);

    // Click handler for sidebar button - scroll to settings
    sidebarButton.on('click', function() {
        // Open extensions panel if not visible
        if (!$('#extensions_settings').is(':visible')) {
            $('#extensions_settings_button').trigger('click');
        }

        // Scroll to Image Router settings
        setTimeout(() => {
            const settingsPanel = $('#img-router-settings');
            if (settingsPanel.length) {
                settingsPanel[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 100);
    });

    // Load settings and setup handlers
    loadSettings();
    setupEventHandlers();

    // Process existing chat messages
    setTimeout(processChatMessages, 500);

    console.log('Image Router extension loaded');
});
