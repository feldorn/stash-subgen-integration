(function() {
    'use strict';
    
    // ════════════════════════════════════════════════════════════════
    // SUBGEN INTEGRATION PLUGIN FOR STASHAPP
    // Version: 3.3.0 - Fixed Subtitle Editor (using runPluginOperation)
    // ════════════════════════════════════════════════════════════════
    
    // Plugin settings
    let DEBUG = false; // Will be loaded from settings
    let CUSTOM_SUBGEN_URL = null; // Only set if user explicitly configures it
    let AUTO_FIX_PIPE_ISSUES = false; // Auto-fix pipe compatibility issues
    let CREATE_BACKUP = false; // Create backup files before remuxing
    
    // Logging utilities with timestamp
    function logInfo(message, ...args) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [Subgen Plugin] INFO:`, message, ...args);
    }
    
    function logDebug(message, ...args) {
        if (DEBUG) {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] [Subgen Plugin] DEBUG:`, message, ...args);
        }
    }
    
    function logError(message, ...args) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] [Subgen Plugin] ERROR:`, message, ...args);
    }
    
    logInfo('Subgen Integration Plugin loaded successfully');
    logDebug('Debug logging is ENABLED');
    
    // ════════════════════════════════════════════════════════════════
    // UTILITY FUNCTIONS
    // ════════════════════════════════════════════════════════════════
    
    /**
     * Wait for an element to appear in the DOM
     */
    function waitForElement(selector, callback, maxAttempts = 50) {
        let attempts = 0;
        
        const checkElement = () => {
            const element = document.querySelector(selector);
            if (element) {
                logDebug(`Element found: ${selector}`);
                callback(element);
                return true;
            }
            
            attempts++;
            if (attempts >= maxAttempts) {
                logDebug(`Element not found after ${maxAttempts} attempts: ${selector}`);
                return false;
            }
            
            setTimeout(checkElement, 100);
            return false;
        };
        
        return checkElement();
    }
    
    /**
     * Find the three-dot menu dropdown where we'll add our menu item
     */
    function findDropdownMenu() {
        // Look for the dropdown menu (appears when clicking the three dots)
        const dropdownMenuSelectors = [
            '.dropdown-menu',
            'div[class*="dropdown-menu"]',
            '.scene-dropdown-menu'
        ];
        
        for (const selector of dropdownMenuSelectors) {
            const element = document.querySelector(selector);
            if (element) {
                logDebug(`Found dropdown menu using selector: ${selector}`);
                return element;
            }
        }
        
        return null;
    }
    
    /**
     * Find the three-dot menu button
     */
    function findMenuButton() {
        // Look for buttons that might be the three-dot menu
        const buttons = document.querySelectorAll('button');
        for (const button of buttons) {
            // Check if button contains the vertical ellipsis icon
            if (button.querySelector('.fa-ellipsis-v') || 
                button.querySelector('.fa-ellipsis-vertical')) {
                logDebug('Found three-dot menu button');
                return button;
            }
        }
        
        logDebug('Three-dot menu button not found');
        return null;
    }
    
    /**
     * Check if we're currently on a scene detail page
     */
    function isSceneDetailPage() {
        const path = window.location.pathname;
        const isScenePage = /^\/scenes\/\d+$/.test(path);
        logDebug(`Checking if scene detail page. Path: ${path}, IsScenePage: ${isScenePage}`);
        return isScenePage;
    }
    
    /**
     * Extract scene ID from current URL
     */
    function getSceneIdFromUrl() {
        const path = window.location.pathname;
        const match = path.match(/^\/scenes\/(\d+)$/);
        const sceneId = match ? match[1] : null;
        logDebug(`Extracted scene ID: ${sceneId} from path: ${path}`);
        return sceneId;
    }
    
    // ════════════════════════════════════════════════════════════════
    // GRAPHQL API FUNCTIONS
    // ════════════════════════════════════════════════════════════════
    
    /**
     * Query scene data from Stashapp GraphQL API
     */
    async function querySceneData(sceneId) {
        logDebug(`Querying scene data for scene ID: ${sceneId}`);
        
        const query = `
            query FindScene($id: ID!) {
                findScene(id: $id) {
                    id
                    title
                    date
                    rating100
                    organized
                    o_counter
                    files {
                        path
                        basename
                        size
                        duration
                        video_codec
                        width
                        height
                    }
                    studio {
                        id
                        name
                    }
                    performers {
                        id
                        name
                    }
                }
            }
        `;
        
        const variables = { id: sceneId.toString() };
        
        try {
            logDebug('Sending GraphQL request to /graphql');
            logDebug('Query:', query);
            logDebug('Variables:', variables);
            
            const response = await fetch('/graphql', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query, variables })
            });
            
            // Always try to parse the response, even on error
            const result = await response.json();
            logDebug('GraphQL response:', result);
            
            if (!response.ok) {
                const errorMsg = result.errors 
                    ? JSON.stringify(result.errors, null, 2)
                    : `Status ${response.status}: ${response.statusText}`;
                logError('GraphQL request failed:', errorMsg);
                throw new Error(`GraphQL Error: ${errorMsg}`);
            }
            
            if (result.errors) {
                logError('GraphQL errors:', result.errors);
                throw new Error(`GraphQL errors: ${JSON.stringify(result.errors, null, 2)}`);
            }
            
            logDebug('Scene data retrieved successfully:', result.data.findScene);
            return result.data.findScene;
            
        } catch (error) {
            logError('Failed to query scene data:', error);
            throw error;
        }
    }
    
    /**
     * Reload subtitle track in Video.js player without disrupting playback
     */
    function reloadSubtitleTrack() {
        try {
            logDebug('Attempting to reload subtitle track in video player...');
            
            // Find the video element
            const videoElement = document.querySelector('video.video-js');
            if (!videoElement) {
                logDebug('Video element not found on page');
                return false;
            }
            
            // Get Video.js player instance
            let player = null;
            if (typeof videojs !== 'undefined' && videojs.getPlayer) {
                player = videojs.getPlayer(videoElement);
            } else if (videoElement.player) {
                player = videoElement.player;
            }
            
            if (!player) {
                logDebug('Video.js player instance not found');
                return false;
            }
            
            logDebug('Found Video.js player instance');
            
            // Save current playback state
            const currentTime = player.currentTime();
            const isPaused = player.paused();
            
            logDebug(`Current playback state: time=${currentTime}s, paused=${isPaused}`);
            
            // Find the current subtitle track
            const textTracks = player.textTracks();
            let subtitleTrack = null;
            let trackIndex = -1;
            
            for (let i = 0; i < textTracks.length; i++) {
                const track = textTracks[i];
                if (track.kind === 'subtitles' || track.kind === 'captions') {
                    subtitleTrack = track;
                    trackIndex = i;
                    break;
                }
            }
            
            if (!subtitleTrack) {
                logDebug('No subtitle track found in player');
                return false;
            }
            
            const wasShowing = subtitleTrack.mode === 'showing';
            const trackSrc = subtitleTrack.src || '';
            const trackLabel = subtitleTrack.label || 'English';
            const trackLanguage = subtitleTrack.language || 'en';
            
            logDebug(`Found subtitle track: src=${trackSrc}, showing=${wasShowing}`);
            
            // Remove the old track
            player.removeRemoteTextTrack(subtitleTrack);
            logDebug('Removed old subtitle track');
            
            // Add cache-busting parameter to force browser reload
            const cacheBuster = `?t=${Date.now()}`;
            const newSrc = trackSrc.split('?')[0] + cacheBuster;
            
            // Add the track back with cache-busting URL
            player.addRemoteTextTrack({
                kind: 'subtitles',
                src: newSrc,
                srclang: trackLanguage,
                label: trackLabel,
                mode: wasShowing ? 'showing' : 'disabled'
            }, false);
            
            logDebug(`Re-added subtitle track with cache-buster: ${newSrc}`);
            
            // Restore playback state
            player.currentTime(currentTime);
            if (!isPaused) {
                player.play();
            }
            
            logInfo('✓ Subtitle track reloaded successfully');
            return true;
            
        } catch (error) {
            logError('Error reloading subtitle track:', error);
            return false;
        }
    }
    
    // ════════════════════════════════════════════════════════════════
    // PYTHON TASK FUNCTIONS
    // ════════════════════════════════════════════════════════════════
    
    /**
     * Call Python backend task to generate subtitles
     * This runs server-side in the Stash container, avoiding CORS and network issues
     */
    async function callPythonTask(sceneId) {
        logInfo(`Calling Python backend task for scene ID: ${sceneId}`);
        
        const mutation = `
            mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args: [PluginArgInput!]) {
                runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args: $args)
            }
        `;
        
        // Build task arguments
        const taskArgs = [
            {
                key: "scene_id",
                value: {
                    str: sceneId.toString()
                }
            }
        ];
        
        // Only pass subgen_url if user has explicitly configured a custom URL
        // Otherwise, let Python use its default (http://subgen:9000)
        if (CUSTOM_SUBGEN_URL) {
            taskArgs.push({
                key: "subgen_url",
                value: {
                    str: CUSTOM_SUBGEN_URL
                }
            });
            logDebug(`Passing custom Subgen URL to Python backend: ${CUSTOM_SUBGEN_URL}`);
        } else {
            logDebug('Using Python backend default Subgen URL (http://subgen:9000)');
        }
        
        // Pass auto-fix pipe issues setting
        taskArgs.push({
            key: "auto_fix_pipe_issues",
            value: {
                b: AUTO_FIX_PIPE_ISSUES
            }
        });
        
        // Pass create backup setting
        taskArgs.push({
            key: "create_backup",
            value: {
                b: CREATE_BACKUP
            }
        });
        
        // Pass debug logging setting
        taskArgs.push({
            key: "debug_logging",
            value: {
                b: DEBUG
            }
        });
        
        const variables = {
            plugin_id: "subgen-integration",
            task_name: "Generate Subtitles",
            args: taskArgs
        };
        
        logDebug('Running plugin task with variables:', variables);
        
        try {
            const response = await fetch('/graphql', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: mutation,
                    variables: variables
                })
            });
            
            const result = await response.json();
            logDebug('Plugin task response:', result);
            
            if (!response.ok || result.errors) {
                const errorMsg = result.errors 
                    ? JSON.stringify(result.errors, null, 2)
                    : `HTTP ${response.status}: ${response.statusText}`;
                throw new Error(`Plugin task failed: ${errorMsg}`);
            }
            
            logInfo('✓ Python backend task completed successfully!');
            return result.data.runPluginTask;
            
        } catch (error) {
            logError('Python task call failed:', error);
            throw error;
        }
    }
    
    // ════════════════════════════════════════════════════════════════
    // BUTTON CREATION AND EVENT HANDLERS
    // ════════════════════════════════════════════════════════════════
    
    /**
     * Handle button click - Step 1: Just log the data
     */
    async function handleGenerateSubtitlesClick(event) {
        logInfo('═══════════════════════════════════════════════════════');
        logInfo('Generate Subtitles button clicked!');
        logInfo('═══════════════════════════════════════════════════════');
        
        const button = event.target;
        const originalText = button.innerHTML;
        
        try {
            // Reload settings to get latest values
            await loadSettings();
            
            // Disable button during processing
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin fa-lg" style="color: white;"></i>';
            
            // Get scene ID
            const sceneId = getSceneIdFromUrl();
            logInfo(`Scene ID: ${sceneId}`);
            
            if (!sceneId) {
                throw new Error('Could not extract scene ID from URL');
            }
            
            // Query scene data
            logInfo('Fetching scene data from Stashapp API...');
            const sceneData = await querySceneData(sceneId);
            
            // Log all retrieved data
            logInfo('═══════════════════════════════════════════════════════');
            logInfo('SCENE DATA RETRIEVED:');
            logInfo('═══════════════════════════════════════════════════════');
            logInfo('Scene ID:', sceneData.id);
            logInfo('Title:', sceneData.title);
            logInfo('Date:', sceneData.date);
            logInfo('Rating:', sceneData.rating100);
            logInfo('Organized:', sceneData.organized);
            logInfo('View Count (o_counter):', sceneData.o_counter);
            
            if (sceneData.studio) {
                logInfo('Studio:', sceneData.studio.name, `(ID: ${sceneData.studio.id})`);
            }
            
            if (sceneData.performers && sceneData.performers.length > 0) {
                logInfo('Performers:');
                sceneData.performers.forEach((performer, index) => {
                    logInfo(`  Performer ${index + 1}:`, performer.name, `(ID: ${performer.id})`);
                });
            }
            
            if (sceneData.files && sceneData.files.length > 0) {
                logInfo('Files:');
                sceneData.files.forEach((file, index) => {
                    logInfo(`  File ${index + 1}:`, {
                        path: file.path,
                        basename: file.basename,
                        size: `${(file.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
                        duration: file.duration ? `${(file.duration / 60).toFixed(2)} min` : 'N/A',
                        resolution: file.width && file.height ? `${file.width}x${file.height}` : 'N/A',
                        codec: file.video_codec || 'N/A'
                    });
                });
            } else {
                logInfo('No files found for this scene');
            }
            
            logInfo('═══════════════════════════════════════════════════════');
            logInfo('STEP 1 VALIDATION COMPLETE');
            logInfo('Next steps: Implement webhook call to Subgen');
            logInfo('═══════════════════════════════════════════════════════');
            
            // Success feedback - show alert with key info
            const filePath = sceneData.files && sceneData.files.length > 0 
                ? sceneData.files[0].path 
                : sceneData.path || 'No path found';
            
            alert(`✓ Step 1 Validation Complete!\n\nScene: ${sceneData.title || 'Untitled'}\nFile: ${filePath}\n\nOpen browser console (F12) to see all logged data.`);
            
            button.innerHTML = '<i class="fas fa-check fa-lg" style="color: #28a745;"></i>';
            
            setTimeout(() => {
                button.innerHTML = originalText;
                button.disabled = false;
            }, 3000);
            
        } catch (error) {
            logError('Error in handleGenerateSubtitlesClick:', error);
            
            // Show error in alert dialog for visibility
            const errorMsg = error.message || String(error);
            alert(`Subgen Plugin Error:\n\n${errorMsg}\n\nCheck browser console (F12) for detailed logs.`);
            
            // Error feedback
            button.innerHTML = '<i class="fas fa-exclamation-triangle fa-lg" style="color: #dc3545;"></i>';
            
            setTimeout(() => {
                button.innerHTML = originalText;
                button.disabled = false;
            }, 5000);
        }
    }
    
    /**
     * Click handler for menu context - no visual state changes to the menu item
     */
    async function handleGenerateSubtitlesClickFromMenu(event) {
        // Prevent default navigation behavior
        event.preventDefault();
        event.stopPropagation();
        
        logInfo('═══════════════════════════════════════════════════════');
        logInfo('Generate Subtitles menu item clicked!');
        logInfo('═══════════════════════════════════════════════════════');
        
        // Reload settings to get latest configuration changes
        await loadSettings();
        
        // Close the dropdown menu manually since we're async
        try {
            const menuButton = findMenuButton();
            if (menuButton) {
                // Try Bootstrap 5 API first
                if (window.bootstrap && window.bootstrap.Dropdown) {
                    const dropdown = window.bootstrap.Dropdown.getOrCreateInstance(menuButton);
                    dropdown.hide();
                    logDebug('Closed dropdown using Bootstrap API');
                } else {
                    // Fallback: manually trigger click to close menu
                    menuButton.click();
                    logDebug('Closed dropdown using click fallback');
                }
            }
        } catch (error) {
            logDebug('Error closing dropdown:', error);
        }
        
        try {
            // Get scene ID
            const sceneId = getSceneIdFromUrl();
            logInfo(`Scene ID: ${sceneId}`);
            
            if (!sceneId) {
                throw new Error('Could not extract scene ID from URL');
            }
            
            // Query scene data
            logInfo('Fetching scene data from Stashapp API...');
            const sceneData = await querySceneData(sceneId);
            
            // Log all retrieved data
            logInfo('═══════════════════════════════════════════════════════');
            logInfo('SCENE DATA RETRIEVED:');
            logInfo('═══════════════════════════════════════════════════════');
            logInfo('Scene ID:', sceneData.id);
            logInfo('Title:', sceneData.title);
            logInfo('Date:', sceneData.date);
            logInfo('Rating:', sceneData.rating100);
            logInfo('Organized:', sceneData.organized);
            logInfo('View Count (o_counter):', sceneData.o_counter);
            
            if (sceneData.studio) {
                logInfo('Studio:', sceneData.studio.name, `(ID: ${sceneData.studio.id})`);
            }
            
            if (sceneData.performers && sceneData.performers.length > 0) {
                logInfo('Performers:');
                sceneData.performers.forEach((performer, index) => {
                    logInfo(`  Performer ${index + 1}:`, performer.name, `(ID: ${performer.id})`);
                });
            }
            
            if (sceneData.files && sceneData.files.length > 0) {
                logInfo('Files:');
                sceneData.files.forEach((file, index) => {
                    logInfo(`  File ${index + 1}:`, {
                        path: file.path,
                        basename: file.basename,
                        size: `${(file.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
                        duration: file.duration ? `${(file.duration / 60).toFixed(2)} min` : 'N/A',
                        resolution: file.width && file.height ? `${file.width}x${file.height}` : 'N/A',
                        codec: file.video_codec || 'N/A'
                    });
                });
            } else {
                logInfo('No files found for this scene');
            }
            
            logInfo('═══════════════════════════════════════════════════════');
            logInfo('CALLING PYTHON BACKEND TASK');
            logInfo('═══════════════════════════════════════════════════════');
            
            // Call Python backend task (runs server-side in Stash container)
            const taskResponse = await callPythonTask(sceneId);
            
            logInfo('═══════════════════════════════════════════════════════');
            logInfo('✓ SUBTITLE GENERATION STARTED!');
            logInfo('Python task response:', taskResponse);
            logInfo('═══════════════════════════════════════════════════════');
            
            // Success feedback - concise popup
            const sceneTitle = sceneData.title || 'this scene';
            alert(`✓ Generating subtitles for "${sceneTitle}"\n\nThis may take several minutes. Check Stash logs for progress.`);
            
            // Menu closes automatically - no visual state changes needed
            
        } catch (error) {
            logError('Error in handleGenerateSubtitlesClickFromMenu:', error);
            
            // Show error in alert dialog for visibility
            const errorMsg = error.message || String(error);
            alert(`Subgen Plugin Error:\n\n${errorMsg}\n\nCheck browser console (F12) for detailed logs.`);
            
            // Menu closes automatically - no visual state changes needed
        }
    }
    
    /**
     * Add "Generate Subtitles" menu item to the three-dot dropdown menu
     */
    function addMenuItemToDropdown() {
        logDebug('Attempting to add menu item to dropdown');
        
        if (!isSceneDetailPage()) {
            logDebug('Not on scene detail page, skipping menu creation');
            return false;
        }
        
        // Check if menu item already exists
        if (document.getElementById('subgen-menu-item')) {
            logDebug('Subgen menu item already exists, skipping creation');
            return true;
        }
        
        // Find the menu button
        const menuButton = findMenuButton();
        if (!menuButton) {
            logDebug('Menu button not found');
            return false;
        }
        
        // Set up observer to detect when dropdown appears
        const observer = new MutationObserver((mutations) => {
            // Re-check that we're still on a scene detail page
            // (prevents adding menu to other dropdowns that appear)
            if (!isSceneDetailPage()) {
                return;
            }
            
            const dropdown = findDropdownMenu();
            if (dropdown && !document.getElementById('subgen-menu-item')) {
                logDebug('Dropdown menu detected, adding menu items');
                
                // Clone existing item structure for consistent styling
                const existingItem = dropdown.querySelector('.dropdown-item');
                const menuItem = existingItem ? existingItem.cloneNode(false) : document.createElement('button');
                
                menuItem.id = 'subgen-menu-item';
                
                // Remove navigation attributes from cloned element
                menuItem.removeAttribute('href');
                menuItem.removeAttribute('data-action');
                menuItem.removeAttribute('data-toggle');
                menuItem.removeAttribute('data-target');
                menuItem.removeAttribute('aria-label');
                
                // Set as button to prevent navigation
                if (menuItem.tagName === 'A') {
                    menuItem.setAttribute('role', 'button');
                    menuItem.setAttribute('href', '#');
                } else {
                    menuItem.type = 'button';
                }
                
                if (!existingItem) {
                    menuItem.className = 'dropdown-item';
                }
                
                // Clear and set text content (NO ICON)
                menuItem.innerHTML = '';
                menuItem.appendChild(document.createTextNode('Generate Subtitles'));
                
                // Attach click handler
                menuItem.addEventListener('click', (e) => {
                    handleGenerateSubtitlesClickFromMenu(e);
                });
                
                // Insert at bottom of menu
                dropdown.appendChild(menuItem);
                
                logInfo('✓ Generate Subtitles menu item added to bottom of dropdown');
                
                // Add "Edit Subtitles" menu item (async check if subtitle exists)
                // Don't await - let it add asynchronously if subtitle exists
                addEditSubtitlesMenuItem(dropdown).catch(err => {
                    logDebug('Error adding Edit Subtitles menu item:', err);
                });
                
                // Disconnect observer after successful injection
                observer.disconnect();
                logDebug('Observer disconnected after menu item injection');
            }
        });
        
        // Observe for dropdown menu appearing
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        logInfo('✓ Observer set up for dropdown menu');
        return true;
    }
    
    /**
     * Legacy function name kept for compatibility with retry logic
     */
    function createSubgenButton() {
        return addMenuItemToDropdown();
    }
    
    /**
     * Try to inject button with retry logic
     */
    function tryInjectButton(maxAttempts = 20) {
        // Early exit if not on a scene detail page - don't waste retry attempts
        if (!isSceneDetailPage()) {
            logDebug('Not on scene detail page, skipping injection retry loop');
            return;
        }
        
        let attempts = 0;
        
        const tryInject = () => {
            attempts++;
            logDebug(`Button injection attempt ${attempts}/${maxAttempts}`);
            
            if (createSubgenButton()) {
                logInfo(`Button successfully injected after ${attempts} attempt(s)`);
                return;
            }
            
            if (attempts < maxAttempts) {
                setTimeout(tryInject, 200);
            } else {
                logDebug(`Failed to inject button after ${maxAttempts} attempts`);
            }
        };
        
        tryInject();
    }
    
    // ════════════════════════════════════════════════════════════════
    // PLUGIN SETTINGS
    // ════════════════════════════════════════════════════════════════
    
    /**
     * Load plugin settings from Stashapp configuration via GraphQL
     */
    async function loadSettings() {
        logDebug('Loading plugin settings via GraphQL...');
        
        try {
            // Query plugin configuration from Stash API
            const query = `
                query Configuration {
                    configuration {
                        plugins
                    }
                }
            `;
            
            const response = await fetch('/graphql', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query })
            });
            
            const result = await response.json();
            
            if (result.errors) {
                logInfo('Could not load plugin settings via GraphQL:', result.errors);
                return {};
            }
            
            const pluginsConfig = result.data?.configuration?.plugins;
            
            if (pluginsConfig) {
                logDebug('Loaded plugins config from GraphQL:', pluginsConfig);
                
                // Try to find our plugin under different possible IDs
                let ourPluginSettings = null;
                const possibleIds = ['subgen-integration', 'Subgen', 'subgen'];
                
                for (const id of possibleIds) {
                    if (pluginsConfig[id]) {
                        logInfo(`✓ Found plugin settings under ID: "${id}"`);
                        ourPluginSettings = pluginsConfig[id];
                        break;
                    }
                }
                
                if (!ourPluginSettings) {
                    const pluginIds = Object.keys(pluginsConfig);
                    logInfo('Plugin settings not found. Available plugin IDs:', pluginIds);
                    return {};
                }
                
                logDebug('Plugin settings:', ourPluginSettings);
                    
                    // Load debug logging setting
                    if (ourPluginSettings.debugLogging !== undefined) {
                        DEBUG = ourPluginSettings.debugLogging;
                        logInfo(`Debug logging ${DEBUG ? 'ENABLED' : 'DISABLED'} via plugin settings`);
                    }
                    
                    // Only set custom URL if user has explicitly configured it
                    if (ourPluginSettings.subgenWebhookUrl && ourPluginSettings.subgenWebhookUrl.trim()) {
                        CUSTOM_SUBGEN_URL = ourPluginSettings.subgenWebhookUrl.trim();
                        logInfo(`✓ Loaded custom Subgen webhook URL from settings: ${CUSTOM_SUBGEN_URL}`);
                    } else {
                        logInfo('Using Python backend default Subgen URL (http://subgen:9000)');
                    }
                    
                    // Load auto-fix pipe issues setting
                    if (ourPluginSettings.autoFixPipeIssues !== undefined) {
                        AUTO_FIX_PIPE_ISSUES = Boolean(ourPluginSettings.autoFixPipeIssues);
                        logInfo(`✓ Auto-fix pipe issues: ${AUTO_FIX_PIPE_ISSUES ? 'ENABLED' : 'DISABLED'}`);
                    }
                    
                    // Load create backup setting
                    if (ourPluginSettings.createBackupFiles !== undefined) {
                        CREATE_BACKUP = Boolean(ourPluginSettings.createBackupFiles);
                        logInfo(`✓ Create backup files: ${CREATE_BACKUP ? 'ENABLED' : 'DISABLED'}`);
                    }
                
                return ourPluginSettings;
            } else {
                logInfo('No plugins config found in GraphQL response');
                return {};
            }
            
        } catch (error) {
            logInfo('Could not load settings via GraphQL:', error.message);
            return {};
        }
    }
    
    // ════════════════════════════════════════════════════════════════
    // SUBTITLE EDITOR FUNCTIONALITY
    // ════════════════════════════════════════════════════════════════
    
    /**
     * Generic function to call Python plugin operation with different modes
     * Uses runPluginOperation for synchronous execution with immediate return
     */
    async function callPluginTask(sceneId, mode, content = null) {
        const mutation = `
            mutation RunPluginOperation($plugin_id: ID!, $args: Map!) {
                runPluginOperation(plugin_id: $plugin_id, args: $args)
            }
        `;
        
        // Build args as a plain object (Map type)
        const args = {
            scene_id: sceneId.toString(),
            mode: mode
        };
        
        // Add content for save mode
        if (mode === 'save_subtitle' && content !== null) {
            args.content = content;
        }
        
        const variables = {
            plugin_id: "subgen-integration",
            args: args
        };
        
        logDebug(`Calling plugin operation with mode: ${mode}`);
        
        const response = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: mutation, variables: variables })
        });
        
        const result = await response.json();
        
        if (!response.ok || result.errors) {
            const errorMsg = result.errors 
                ? JSON.stringify(result.errors, null, 2)
                : `HTTP ${response.status}: ${response.statusText}`;
            throw new Error(`Plugin operation failed: ${errorMsg}`);
        }
        
        const output = result.data.runPluginOperation;
        logDebug(`Plugin operation returned:`, output);
        
        // runPluginOperation already parses the JSON for us, so output is an object
        if (typeof output === 'object' && output !== null) {
            logDebug(`Python response (already parsed):`, output);
            return output;
        } else {
            logError(`Unexpected output type from plugin operation:`, typeof output, output);
            throw new Error(`Unexpected output from Python backend: ${output}`);
        }
    }
    
    /**
     * Check if subtitle file exists for current scene
     */
    async function checkSubtitleExists(sceneId) {
        try {
            logDebug(`Checking if subtitle exists for scene ${sceneId}`);
            const response = await callPluginTask(sceneId, 'read_subtitle');
            logDebug(`Python backend response:`, response);
            logDebug(`Response structure: output=${response?.output}, mode=${response?.mode}, result=${JSON.stringify(response?.result)}`);
            const exists = response && response.result && response.result.success;
            logDebug(`Subtitle exists for scene ${sceneId}: ${exists}`);
            return exists;
        } catch (error) {
            logDebug(`Subtitle check failed for scene ${sceneId}: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Open subtitle editor modal
     */
    async function openSubtitleEditor(event) {
        event.preventDefault();
        event.stopPropagation();
        
        const sceneId = getSceneIdFromUrl();
        if (!sceneId) {
            alert('Could not get scene ID');
            return;
        }
        
        try {
            logInfo('Opening subtitle editor for scene:', sceneId);
            
            // Read subtitle file using new generic function
            const response = await callPluginTask(sceneId, 'read_subtitle');
            
            if (!response || !response.result || !response.result.success) {
                throw new Error('Failed to read subtitle file');
            }
            
            const content = response.result.content;
            const filePath = response.result.file_path;
            
            logInfo(`Loaded subtitle file: ${filePath}`);
            
            // Create modal
            showSubtitleEditorModal(sceneId, content, filePath);
            
        } catch (error) {
            logError('Error opening subtitle editor:', error);
            alert(`Error loading subtitle file:\n\n${error.message}`);
        }
    }
    
    /**
     * Show subtitle editor modal with line numbers
     */
    function showSubtitleEditorModal(sceneId, content, filePath) {
        // Remove existing modal if present
        const existingModal = document.getElementById('subgen-editor-modal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Create modal HTML
        const modal = document.createElement('div');
        modal.id = 'subgen-editor-modal';
        modal.className = 'modal fade';
        modal.setAttribute('tabindex', '-1');
        modal.innerHTML = `
            <div class="modal-dialog modal-xl">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Edit Subtitles</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-2">
                            <small class="text-muted">${filePath}</small>
                        </div>
                        <div style="display: flex; border: 1px solid #444;">
                            <div id="subgen-line-numbers" style="
                                background: #2b2b2b;
                                padding: 10px 8px;
                                text-align: right;
                                user-select: none;
                                font-family: 'Courier New', monospace;
                                font-size: 14px;
                                line-height: 1.5;
                                color: #888;
                                border-right: 1px solid #444;
                                min-width: 50px;
                            "></div>
                            <textarea 
                                id="subgen-editor-textarea" 
                                class="form-control" 
                                style="
                                    font-family: 'Courier New', monospace;
                                    font-size: 14px;
                                    line-height: 1.5;
                                    border: none;
                                    border-radius: 0;
                                    resize: none;
                                    flex: 1;
                                    background: #1e1e1e;
                                    color: #d4d4d4;
                                    min-height: 500px;
                                "
                                spellcheck="false"
                            >${content}</textarea>
                        </div>
                        <div class="mt-2">
                            <small class="text-muted">
                                <i class="fas fa-info-circle"></i> 
                                Use Ctrl+F (or Cmd+F) to search. Line numbers shown on the left.
                            </small>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                        <button type="button" class="btn btn-primary" id="subgen-save-btn">
                            <i class="fas fa-save"></i> Save
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Update line numbers
        const textarea = document.getElementById('subgen-editor-textarea');
        const lineNumbers = document.getElementById('subgen-line-numbers');
        
        function updateLineNumbers() {
            const lines = textarea.value.split('\n').length;
            lineNumbers.innerHTML = Array.from({length: lines}, (_, i) => i + 1).join('<br>');
        }
        
        updateLineNumbers();
        textarea.addEventListener('input', updateLineNumbers);
        textarea.addEventListener('scroll', () => {
            lineNumbers.scrollTop = textarea.scrollTop;
        });
        
        // Save button handler
        document.getElementById('subgen-save-btn').addEventListener('click', async () => {
            await saveSubtitleFile(sceneId, textarea.value, modal);
        });
        
        // Show modal - use direct manipulation since Bootstrap may not be globally available
        modal.classList.add('show');
        modal.style.display = 'block';
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('role', 'dialog');
        modal.removeAttribute('aria-hidden');
        
        // Add backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop fade show';
        document.body.appendChild(backdrop);
        document.body.classList.add('modal-open');
        
        // Helper function to close modal
        function closeModal(modalEl, backdropEl) {
            modalEl.classList.remove('show');
            modalEl.style.display = 'none';
            modalEl.setAttribute('aria-hidden', 'true');
            modalEl.removeAttribute('aria-modal');
            modalEl.removeAttribute('role');
            backdropEl.remove();
            document.body.classList.remove('modal-open');
            modalEl.remove();
        }
        
        // Close on backdrop click
        backdrop.addEventListener('click', () => {
            closeModal(modal, backdrop);
        });
        
        // Close on ALL buttons with data-bs-dismiss="modal" (both cancel and X button)
        const closeButtons = modal.querySelectorAll('[data-bs-dismiss="modal"]');
        closeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                closeModal(modal, backdrop);
            });
        });
    }
    
    /**
     * Save subtitle file
     */
    async function saveSubtitleFile(sceneId, content, modal) {
        const saveBtn = document.getElementById('subgen-save-btn');
        const originalText = saveBtn.innerHTML;
        
        try {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
            
            logInfo('Saving subtitle file for scene:', sceneId);
            
            // Save subtitle file using new generic function
            const response = await callPluginTask(sceneId, 'save_subtitle', content);
            
            if (!response || !response.result || !response.result.success) {
                throw new Error('Failed to save subtitle file');
            }
            
            logInfo('✓ Subtitle file saved successfully');
            
            // Try to reload the subtitle track in the video player
            const reloaded = reloadSubtitleTrack();
            
            if (reloaded) {
                saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved & Reloaded!';
            } else {
                saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved!';
                logInfo('Note: Subtitle track not reloaded (may need page refresh to see changes)');
            }
            
            setTimeout(() => {
                // Close modal manually
                modal.classList.remove('show');
                modal.style.display = 'none';
                const backdrop = document.querySelector('.modal-backdrop');
                if (backdrop) backdrop.remove();
                document.body.classList.remove('modal-open');
                modal.remove();
            }, 1000);
            
        } catch (error) {
            logError('Error saving subtitle file:', error);
            alert(`Error saving subtitle file:\n\n${error.message}`);
            saveBtn.innerHTML = originalText;
            saveBtn.disabled = false;
        }
    }
    
    /**
     * Add "Edit Subtitles" menu item (only if subtitle exists)
     */
    async function addEditSubtitlesMenuItem(dropdown) {
        try {
            logDebug('addEditSubtitlesMenuItem called');
            
            if (!dropdown) {
                logDebug('No dropdown provided to addEditSubtitlesMenuItem');
                return;
            }
            
            const sceneId = getSceneIdFromUrl();
            logDebug(`Scene ID from URL: ${sceneId}`);
            
            if (!sceneId) {
                logDebug('No scene ID found, skipping Edit Subtitles menu');
                return;
            }
            
            // Check if menu item already exists
            if (document.getElementById('subgen-edit-menu-item')) {
                logDebug('Edit Subtitles menu item already exists');
                return;
            }
            
            // Check if subtitle exists
            logDebug('About to check if subtitle exists...');
            const subtitleExists = await checkSubtitleExists(sceneId);
            
            if (!subtitleExists) {
                logDebug('No subtitle file found, skipping Edit Subtitles menu item');
                return;
            }
            
            logInfo('Subtitle file exists! Adding Edit Subtitles menu item...');
            
            // Clone existing item structure
            const existingItem = dropdown.querySelector('.dropdown-item');
            const menuItem = existingItem ? existingItem.cloneNode(false) : document.createElement('button');
            
            menuItem.id = 'subgen-edit-menu-item';
            menuItem.removeAttribute('href');
            menuItem.removeAttribute('data-action');
            menuItem.removeAttribute('data-toggle');
            menuItem.removeAttribute('data-target');
            menuItem.removeAttribute('aria-label');
            
            if (menuItem.tagName === 'A') {
                menuItem.setAttribute('role', 'button');
                menuItem.setAttribute('href', '#');
            } else {
                menuItem.type = 'button';
            }
            
            if (!existingItem) {
                menuItem.className = 'dropdown-item';
            }
            
            menuItem.innerHTML = '';
            menuItem.appendChild(document.createTextNode('Edit Subtitles'));
            
            menuItem.addEventListener('click', openSubtitleEditor);
            
            dropdown.appendChild(menuItem);
            
            logInfo('✓ Edit Subtitles menu item added to dropdown');
            
        } catch (error) {
            logError('Error in addEditSubtitlesMenuItem:', error);
        }
    }
    
    // ════════════════════════════════════════════════════════════════
    // PAGE MONITORING AND INITIALIZATION
    // ════════════════════════════════════════════════════════════════
    
    /**
     * Initialize plugin on page load and handle SPA navigation
     */
    async function initializePlugin() {
        logDebug('Initializing Subgen plugin');
        
        // Load plugin settings first
        await loadSettings();
        
        // Initial button creation with retry logic
        setTimeout(() => tryInjectButton(), 500);
        
        // Monitor for page changes (SPA navigation)
        let lastPath = window.location.pathname;
        
        const observer = new MutationObserver((mutations) => {
            const currentPath = window.location.pathname;
            
            // Check for path changes (SPA navigation)
            if (currentPath !== lastPath) {
                logDebug(`Path changed from ${lastPath} to ${currentPath}`);
                lastPath = currentPath;
                
                // Remove old menu item if it exists
                const oldMenuItem = document.getElementById('subgen-menu-item');
                if (oldMenuItem) {
                    oldMenuItem.remove();
                    logDebug('Removed old menu item for page navigation');
                }
                
                // Try to inject button on new page with delay
                setTimeout(() => tryInjectButton(), 500);
            }
            // Only check for missing menu item on path changes, not every DOM mutation
            // This prevents excessive re-injection attempts
        });
        
        // Observe the entire document for changes
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        logInfo('Subgen plugin initialized. Monitoring for scene detail pages...');
    }
    
    // ════════════════════════════════════════════════════════════════
    // START PLUGIN
    // ════════════════════════════════════════════════════════════════
    
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializePlugin);
    } else {
        initializePlugin();
    }
    
    logInfo('Subgen Integration Plugin script executed');
    
})();
