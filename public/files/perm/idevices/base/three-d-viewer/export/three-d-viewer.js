/* global eXe */

/**
 * Three D Viewer iDevice (export runtime)
 *
 * - Loads the model-viewer web component (ES module) once per page.
 * - Renders a <model-viewer> using the JSON stored by the edition view.
 * - Works on initial page load (refresh) without entering Edit mode.
 */

(function () {
    const globalScope = typeof window !== 'undefined' ? window : globalThis;

    /** Default background color */
    const DEFAULT_BACKGROUND = '#f5f5f5';

    /** Fallback translations when i18n is not available */
    const FALLBACK_TRANSLATIONS = {
        'viewer.empty_state': 'Select a 3D model to display',
        'viewer.animation_paused': 'Animation paused',
        'viewer.animation_enabled': 'Animation enabled',
        'viewer.local_warning_title': '3D Viewer not available',
        'viewer.local_warning_message': 'The 3D viewer requires a web server to work. Open this content from a web server or use eXeLearning preview.'
    };

    /**
     * Simple i18n helper. Falls back to built-in translations if _() is not present.
     * @param {string} key
     * @returns {string}
     */
    function translate(key) {
        try {
            if (typeof globalScope._ === 'function') {
                const translated = globalScope._(key);
                // If translation returns the key, use fallback
                if (translated !== key) {
                    return translated;
                }
            }
        } catch (err) {}
        return FALLBACK_TRANSLATIONS[key] || key;
    }

    /**
     * Build an absolute URL for an app-relative path using eXe symfony baseURL/basePath.
     * @param {string} path
     * @returns {string}
     */
    function resolveAssetUrl(path) {
        const sym = globalScope.eXeLearning?.symfony || {};
        const baseURL = String(sym.baseURL || '').replace(/\/+$/g, '');
        const basePath = sym.basePath ? '/' + String(sym.basePath).replace(/^\/+|\/+$/g, '') : '';
        const norm = String(path || '').replace(/^\/+/, '');
        const prefix = (baseURL + basePath).replace(/\/+$/g, '');
        return prefix ? `${prefix}/${norm}` : `/${norm}`;
    }

    /**
     * Detect the current execution mode for path resolution.
     *
     * Modes are checked in priority order but may overlap:
     * 1. Static mode - PWA/offline build (isStaticMode or isOfflineInstallation in config)
     * 2. Server mode - Running on eXeLearning server (config.baseURL is defined)
     * 3. Export mode - Standalone HTML export (html id starts with 'exe-')
     * 4. Preview mode - Inside workarea preview panel (AssetManager available)
     *
     * WHY check html[id^="exe-"]: Exported HTML files have the root element id
     * set to 'exe-index' or 'exe-{pageId}', which distinguishes them from
     * the workarea or server-rendered pages.
     *
     * @returns {{isStaticMode: boolean, isServerMode: boolean, isExportMode: boolean, isOnIndexPage: boolean, isPreviewMode: boolean}}
     */
    function detectMode() {
        const config = globalScope.eXeLearning?.config;
        const parsedConfig = typeof config === 'string'
            ? (function() { try { return JSON.parse(config); } catch(e) { return null; } })()
            : config;

        return {
            isStaticMode: !!(parsedConfig?.isStaticMode || parsedConfig?.isOfflineInstallation),
            isServerMode: parsedConfig?.baseURL !== undefined,
            isExportMode: document.documentElement.id === 'exe-index' ||
                          document.querySelector('html[id^="exe-"]') !== null,
            isOnIndexPage: document.documentElement.id === 'exe-index',
            isPreviewMode: !!getAssetManager()
        };
    }

    /**
     * Compute the resources base path for offline export: content/resources/<ideviceId>/
     * Falls back to ../content/resources when not on index.
     * @param {string} ideviceId
     * @returns {string}
     */
    function getIdeviceResourcesBase(ideviceId) {
        if (!ideviceId) return '';
        const onIndex = document.documentElement.id === 'exe-index';
        return onIndex
            ? `content/resources/${ideviceId}/`
            : `../content/resources/${ideviceId}/`;
    }

    /**
     * Get the URL for the model-viewer library.
     *
     * Mode-aware path resolution:
     * - Static mode: Returns `./files/perm/...` (relative to app root)
     * - Server mode: Returns resolved absolute URL via resolveAssetUrl
     * - Export mode on index: Returns `./idevices/...` (relative to index.html)
     * - Export mode on subpage: Returns `../idevices/...` (up one level from html/)
     * - Fallback: Uses symfony config via resolveAssetUrl
     *
     * WHY different paths for export: Exported packages have a specific structure
     * where libraries are in `idevices/<type>/` folder. Index.html is at the root,
     * while subpages are in `html/` folder, requiring the `../` prefix.
     *
     * @returns {string} URL to model-viewer.min.js
     */
    function getModelViewerLibUrl() {
        const mode = detectMode();

        if (mode.isStaticMode) {
            return './files/perm/idevices/base/three-d-viewer/export/model-viewer.min.js';
        }
        if (mode.isServerMode) {
            return resolveAssetUrl('files/perm/idevices/base/three-d-viewer/export/model-viewer.min.js');
        }
        if (mode.isExportMode) {
            return mode.isOnIndexPage
                ? './idevices/three-d-viewer/model-viewer.min.js'
                : '../idevices/three-d-viewer/model-viewer.min.js';
        }
        // Fallback to resolveAssetUrl
        return resolveAssetUrl('files/perm/idevices/base/three-d-viewer/export/model-viewer.min.js');
    }

    /**
     * Get the base URL for Three.js modules (STLLoader, OrbitControls, etc.).
     *
     * WHY mode-aware: Different execution contexts need different path strategies:
     * - Static: Uses origin for absolute URL (prevents path duplication in dynamic imports)
     * - Server: Builds from config.baseURL + basePath (handles subdirectory installs)
     * - Export: Uses page URL base + relative paths (./idevices or ../idevices)
     *   based on whether we're on index.html or a subpage in html/ folder
     * - Fallback: Uses symfony config (legacy support for workarea)
     *
     * WHY absolute URLs for imports: Dynamic import() resolves paths relative to the
     * current module's location. If we return a relative path and the module is loaded
     * from a nested location, the browser may resolve it incorrectly, causing path
     * duplication (e.g., `/path/to/files/perm/.../path/to/...`). Using absolute URLs
     * with protocol (http://... or https://...) prevents this issue entirely.
     *
     * @returns {string} Absolute URL ending with trailing slash for module base path
     */
    function getThreeJSBaseUrl() {
        const mode = detectMode();

        if (mode.isStaticMode) {
            // Static mode: use origin + absolute path for dynamic imports
            return `${globalScope.location.origin}/files/perm/idevices/base/three-d-viewer/export/`;
        }
        if (mode.isServerMode) {
            // Server mode: build absolute URL with protocol
            const config = globalScope.eXeLearning?.config;
            const baseURL = (config?.baseURL || globalScope.location.origin).replace(/\/+$/g, '');
            const basePath = config?.basePath ? `/${config.basePath.replace(/^\/+|\/+$/g, '')}` : '';
            return `${baseURL}${basePath}/files/perm/idevices/base/three-d-viewer/export/`;
        }
        if (mode.isExportMode) {
            // Export mode: resolve relative to current page location
            const currentUrl = globalScope.location.href;
            const baseUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/') + 1);
            const prefix = mode.isOnIndexPage ? '' : '../';
            return `${baseUrl}${prefix}idevices/three-d-viewer/`;
        }
        // Fallback: use symfony config with absolute URL
        const sym = globalScope.eXeLearning?.symfony || {};
        const baseURL = (sym.baseURL || globalScope.location.origin).replace(/\/+$/g, '');
        const basePath = sym.basePath ? '/' + String(sym.basePath).replace(/^\/+|\/+$/g, '') : '';
        return `${baseURL}${basePath}/files/perm/idevices/base/three-d-viewer/export/`;
    }

    /**
     * Check if a path refers to an STL file.
     * @param {string} path
     * @returns {boolean}
     */
    function isSTLFile(path) {
        if (!path) return false;
        const filename = path.split('/').pop() || '';
        return filename.toLowerCase().endsWith('.stl');
    }

    /**
     * Check if we're running from file:// protocol (local HTML file).
     * ES modules and model-viewer don't work with file:// due to CORS restrictions.
     * @returns {boolean}
     */
    function isLocalFileProtocol() {
        try {
            return globalScope.location?.protocol === 'file:';
        } catch (e) {
            return false;
        }
    }

    /**
     * Build the HTML for the local file warning.
     * @returns {string}
     */
    function buildLocalWarningHTML() {
        const title = translate('viewer.local_warning_title');
        const message = translate('viewer.local_warning_message');
        return `
            <div class="three-d-viewer-local-warning" style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100%;
                min-height: 200px;
                padding: 2rem;
                text-align: center;
                background: linear-gradient(135deg, #f5f5f5 0%, #e0e0e0 100%);
                border-radius: 8px;
                border: 2px dashed #ccc;
            ">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="1.5" style="margin-bottom: 1rem; opacity: 0.7;">
                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </svg>
                <strong style="font-size: 1.1rem; color: #333; margin-bottom: 0.5rem;">${title}</strong>
                <p style="color: #666; margin: 0; max-width: 300px; line-height: 1.4;">${message}</p>
            </div>
        `;
    }

    /**
     * Normalize input path.
     * - Trim, unify slashes, strip leading slash.
     * - Keep absolute URLs as-is.
     * @param {string} path
     * @returns {string}
     */
    function normalizePath(path) {
        const clean = String(path || '').trim().replace(/\\+/g, '/');
        if (!clean) return '';
        if (/^(https?:)?\/\//i.test(clean)) return clean;
        return clean.replace(/^\/+/, '');
    }

    /**
     * Get the AssetManager from current window or parent window (for preview iframe).
     * @returns {object|null}
     */
    function getAssetManager() {
        // Check current window
        let assetManager = globalScope.eXeLearning?.app?.project?.assetManager ||
                           globalScope.eXeLearning?.app?.project?._yjsBridge?.assetManager;
        if (assetManager) return assetManager;

        // Check parent window (for preview iframe)
        try {
            assetManager = globalScope.parent?.eXeLearning?.app?.project?.assetManager ||
                           globalScope.parent?.eXeLearning?.app?.project?._yjsBridge?.assetManager;
            if (assetManager) return assetManager;
        } catch (e) {
            // Cross-origin access denied - we're in a true export context
        }

        return null;
    }

    /**
     * Check if we're in preview/online context (AssetManager available).
     * In preview context, asset:// URLs should be kept for blob resolution.
     * In export context (offline HTML), they should be converted to content/resources/.
     * @returns {boolean}
     */
    function isPreviewContext() {
        return !!getAssetManager();
    }

    /**
     * Try to use ODE session-based temporary path if available, then fall back to plain asset path.
     * Accept already sessionized or absolute URLs as-is.
     * Handles asset:// URLs by resolving to iDevice resources path in export context.
     * In preview context, resolves asset:// URLs to blob URLs via AssetManager.
     * @param {string} path
     * @param {string} [ideviceId] - Optional iDevice ID for asset:// resolution
     * @returns {string}
     */
    function resolveRuntimeSrc(path, ideviceId) {
        const clean = normalizePath(path);
        if (!clean) return '';
        if (/^(https?:)?\/\//i.test(clean)) return clean;
        if (clean.startsWith('blob:')) return clean;
        if (clean.startsWith('files/tmp/')) return resolveAssetUrl(clean);

        // Handle asset:// URLs
        if (clean.startsWith('asset://')) {
            // In preview/online context, resolve to blob URL via AssetManager
            const assetManager = getAssetManager();
            if (assetManager) {
                if (typeof assetManager.resolveAssetURLSync === 'function') {
                    const blobUrl = assetManager.resolveAssetURLSync(clean);
                    console.log('[3D Viewer] resolveRuntimeSrc asset://', clean, '-> blob:', blobUrl ? blobUrl.substring(0, 50) : 'null');
                    if (blobUrl) {
                        return blobUrl;
                    }
                }
                // If AssetManager can't resolve it yet, return empty to prevent 404
                // The async resolution in applyConfig will handle it
                console.log('[3D Viewer] Asset not resolved yet, will try async:', clean);
                return '';
            }

            // In export context (offline HTML), resolve to content/resources path
            // asset://uuid.glb -> content/resources/uuid.glb
            const assetPath = clean.substring('asset://'.length);
            if (assetPath) {
                const onIndex = document.documentElement.id === 'exe-index';
                return (onIndex ? 'content/resources/' : '../content/resources/') + assetPath;
            }
            return '';
        }

        // If the edition stored "file_manager/..." and an ODE session exists, build the session path.
        const sessionId = (function () {
            const s = globalScope.eXeLearning?.app?.project?.odeSession;
            return typeof s === 'string' && s.trim().length >= 8 ? s.trim() : '';
        })();

        if (sessionId) {
            const year = sessionId.substring(0, 4);
            const month = sessionId.substring(4, 6);
            const day = sessionId.substring(6, 8);
            const sessionPath = `files/tmp/${year}/${month}/${day}/${sessionId}/${clean}`;
            return resolveAssetUrl(sessionPath);
        }

        // Plain file inside app
        return resolveAssetUrl(clean);
    }

    /**
     * Resolve asset:// URL to blob URL asynchronously.
     * Waits for AssetManager to be available and the asset to be loaded.
     * @param {string} assetUrl - asset:// URL
     * @param {number} [timeout=10000] - Max wait time in ms
     * @returns {Promise<string|null>}
     */
    async function resolveAssetUrlAsync(assetUrl, timeout = 10000) {
        if (!assetUrl || !assetUrl.startsWith('asset://')) {
            return null;
        }

        const startTime = Date.now();
        const pollInterval = 100;

        while (Date.now() - startTime < timeout) {
            const assetManager = getAssetManager();
            if (assetManager) {
                // Try sync method first (faster if asset is already loaded)
                if (typeof assetManager.resolveAssetURLSync === 'function') {
                    const blobUrl = assetManager.resolveAssetURLSync(assetUrl);
                    if (blobUrl) {
                        return blobUrl;
                    }
                }
                // Try async method which will load the asset if needed
                if (typeof assetManager.resolveAssetURL === 'function') {
                    try {
                        const blobUrl = await assetManager.resolveAssetURL(assetUrl);
                        if (blobUrl) {
                            return blobUrl;
                        }
                    } catch (err) {
                        // Asset not ready yet, keep polling
                    }
                }
            }
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        console.warn('[3D Viewer] Timeout resolving asset URL:', assetUrl);
        return null;
    }

    /**
     * Append a single <link rel="modulepreload"> if not present.
     * @param {string} href
     */
    function appendModulePreloadOnce(href) {
        if (!href) return;
        if (document.querySelector(`link[rel="modulepreload"][href="${href}"]`)) return;
        const l = document.createElement('link');
        l.rel = 'modulepreload';
        l.href = href;
        document.head.appendChild(l);
    }

    /**
     * Ensure Three.js modules are loaded for STL rendering.
     * Uses dynamic imports with ES modules.
     * @returns {Promise<void>}
     */
    async function ensureThreeJSLoaded() {
        if (globalScope.THREE?.STLLoader && globalScope.THREE?.OrbitControls) {
            return;
        }

        globalScope.$exeLibs = globalScope.$exeLibs || {};
        if (globalScope.$exeLibs.threeJSPromise) {
            return globalScope.$exeLibs.threeJSPromise;
        }

        const basePath = getThreeJSBaseUrl();

        globalScope.$exeLibs.threeJSPromise = (async () => {
            try {
                const THREE = await import(basePath + 'three.module.min.js');
                const { STLLoader } = await import(basePath + 'STLLoader.js');
                const { OrbitControls } = await import(basePath + 'OrbitControls.js');

                globalScope.THREE = globalScope.THREE || {};
                Object.assign(globalScope.THREE, THREE);
                globalScope.THREE.STLLoader = STLLoader;
                globalScope.THREE.OrbitControls = OrbitControls;
            } catch (err) {
                console.error('[3D Viewer] Failed to load Three.js modules:', err);
                throw err;
            }
        })();

        return globalScope.$exeLibs.threeJSPromise;
    }

    /**
     * Ensure the model-viewer module is loaded and defined.
     * Uses a global promise to prevent duplicate loading.
     * @param {string} ideviceId
     */
    async function ensureModelViewerModule(ideviceId) {
        // Early exit if already registered
        if (globalScope.customElements?.get?.('model-viewer')) return;

        // Use global namespace to coordinate loading across edition/export
        globalScope.$exeLibs = globalScope.$exeLibs || {};

        // If another context (edition) is already loading, wait for it
        if (globalScope.$exeLibs.modelViewerPromise) {
            try {
                await globalScope.$exeLibs.modelViewerPromise;
            } catch (err) {}
            return;
        }

        // Re-check after awaiting (edition may have finished loading)
        if (globalScope.customElements?.get?.('model-viewer')) return;

        const candidates = [
            getModelViewerLibUrl(),
            getIdeviceResourcesBase(ideviceId) ? getIdeviceResourcesBase(ideviceId) + 'model-viewer.min.js' : null
        ].filter(Boolean);

        globalScope.$exeLibs.modelViewerPromise = (async () => {
            for (const url of candidates) {
                // Skip if already registered (race condition check)
                if (globalScope.customElements?.get?.('model-viewer')) return;

                try {
                    // Inject script and wait for it to load
                    await new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = url;
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    });
                    break;
                } catch (err) {
                    // Try next candidate
                }
            }
        })();

        try {
            await globalScope.$exeLibs.modelViewerPromise;
            if (globalScope.customElements?.whenDefined) {
                await globalScope.customElements.whenDefined('model-viewer');
            }
        } catch (err) {
            // Keep going; runtime will attempt again if needed
        }
    }

    /**
     * Build the <model-viewer> tag with initial attributes.
     * @param {object} data
     * @param {string} [ideviceId] - Optional iDevice ID for asset:// resolution
     * @returns {string}
     */
    function buildModelMarkup(data, ideviceId) {
        const attributes = [
            ['shadow-intensity', '1'],
            ['tone-mapping', 'pbr-neutral'],
            ['reveal', 'auto'],
            ['style', `background-color: ${data.backgroundColor || DEFAULT_BACKGROUND};`]
        ];

        const initialSrc = resolveRuntimeSrc(data.src, ideviceId);
        if (initialSrc) attributes.push(['src', initialSrc]);
        if (data.alt) {
            attributes.push(['alt', data.alt]);
            attributes.push(['aria-label', data.alt]);
        }
        if (data.cameraControls !== false) attributes.push(['camera-controls', '']);
        if (data.autoRotate) {
            attributes.push(['auto-rotate', '']);
            attributes.push(['rotation-per-second', `${data.autoRotateSpeed || 30}deg`]);
        }

        const attrString = attributes
            .map(([k, v]) => (v === '' ? k : `${k}="${v}"`))
            .join(' ');

        return `<model-viewer ${attrString}></model-viewer>`;
    }

    /**
     * Encode config as base64 for safe HTML attribute storage.
     * This avoids any HTML escaping issues with special characters.
     * @param {any} obj
     * @returns {string}
     */
    function serializeConfig(obj) {
        try {
            const json = JSON.stringify(obj);
            // Use base64 encoding to avoid any HTML attribute parsing issues
            return btoa(unescape(encodeURIComponent(json)));
        } catch (err) {
            return '';
        }
    }

    /**
     * Decode base64 config back to object.
     * @param {string} encoded
     * @returns {object}
     */
    function deserializeConfig(encoded) {
        if (!encoded) return {};
        try {
            const json = decodeURIComponent(escape(atob(encoded)));
            return JSON.parse(json);
        } catch (err) {
            // Fallback: try parsing as regular JSON (for backwards compatibility)
            try {
                return JSON.parse(encoded);
            } catch (err2) {
                console.warn('[3D Viewer] Failed to parse config, using defaults. Input:', encoded.substring(0, 50) + '...');
                return {};
            }
        }
    }

    /**
     * Runtime controller for each wrapper.
     */
    class ThreeDViewerRuntime {
        /**
         * @param {HTMLElement} wrapper
         * @param {object} config
         */
        constructor(wrapper, config) {
            this.wrapper = wrapper;
            this.ideviceId = wrapper.id || '';
            this.modelViewer = wrapper.querySelector('model-viewer');
            this.emptyState = wrapper.querySelector('[data-empty]');
            this.ariaLive = wrapper.querySelector('[data-live]');
            this.config = this.normalizeConfig(config);
            this.availableAnimations = [];
            this.init();
        }

        /**
         * Normalize and coerce config values.
         * @param {object} config
         * @returns {object}
         */
        normalizeConfig(config = {}) {
            const anim = config.animation || {};
            const parsedSpeed = parseFloat(anim.speed);

            return {
                src: normalizePath(config.src),
                alt: config.alt || '',
                backgroundColor: config.backgroundColor || DEFAULT_BACKGROUND,
                cameraControls: config.cameraControls !== false,
                autoRotate: config.autoRotate !== false,
                autoRotateSpeed: Number.isFinite(parseFloat(config.autoRotateSpeed))
                    ? parseFloat(config.autoRotateSpeed)
                    : 30,
                animation: {
                    enabled: !!anim.enabled,
                    name: anim.name || '',
                    speed: Number.isFinite(parsedSpeed) ? parsedSpeed : 1
                }
            };
        }

        /**
         * Initialize runtime: apply config and hook events.
         */
        async init() {
            // Check if we're running from file:// protocol - show warning
            if (isLocalFileProtocol()) {
                this.showLocalWarning();
                return;
            }

            // Check if this is an STL file - render with Three.js instead
            if (isSTLFile(this.config.src)) {
                await this.renderSTL();
            } else {
                this.applyConfig();
                this.setupEvents();
            }
        }

        /**
         * Show warning when running from local file:// protocol.
         */
        showLocalWarning() {
            // Hide model-viewer and empty state
            if (this.modelViewer) {
                this.modelViewer.style.display = 'none';
            }
            if (this.emptyState) {
                this.emptyState.style.display = 'none';
            }

            // Insert warning HTML
            const warningDiv = document.createElement('div');
            warningDiv.innerHTML = buildLocalWarningHTML();
            this.wrapper.appendChild(warningDiv.firstElementChild);

            console.log('[3D Viewer] Running from file:// protocol - showing warning');
        }

        /**
         * Render STL file directly with Three.js.
         */
        async renderSTL() {
            const cfg = this.config;

            // Resolve the STL file URL
            let stlUrl = resolveRuntimeSrc(cfg.src, this.ideviceId);
            if (!stlUrl && cfg.src && cfg.src.startsWith('asset://')) {
                stlUrl = await resolveAssetUrlAsync(cfg.src);
            }

            if (!stlUrl) {
                console.warn('[3D Viewer] No STL URL resolved for:', cfg.src);
                this.toggleEmpty();
                return;
            }

            // Hide model-viewer, create canvas for Three.js
            if (this.modelViewer) {
                this.modelViewer.style.display = 'none';
            }

            // Create canvas
            let canvas = this.wrapper.querySelector('.three-js-canvas');
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.className = 'three-js-canvas';
                canvas.style.cssText = 'width: 100%; height: 100%; display: block;';
                this.wrapper.appendChild(canvas);
            }

            try {
                await ensureThreeJSLoaded();
                const THREE = globalScope.THREE;

                const width = this.wrapper.clientWidth || 400;
                const height = this.wrapper.clientHeight || 300;

                // Create scene
                const scene = new THREE.Scene();
                scene.background = new THREE.Color(cfg.backgroundColor || DEFAULT_BACKGROUND);

                // Create camera
                const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);

                // Create renderer
                const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
                renderer.setSize(width, height);
                renderer.setPixelRatio(globalScope.devicePixelRatio || 1);

                // Add lights
                const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
                scene.add(ambientLight);
                const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
                directionalLight.position.set(1, 1, 1);
                scene.add(directionalLight);
                const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
                directionalLight2.position.set(-1, -1, -1);
                scene.add(directionalLight2);

                // Load STL
                const response = await fetch(stlUrl);
                const arrayBuffer = await response.arrayBuffer();
                const loader = new THREE.STLLoader();
                const geometry = loader.parse(arrayBuffer);

                // Center and scale geometry
                geometry.computeBoundingBox();
                geometry.center();

                const bbox = geometry.boundingBox;
                const size = new THREE.Vector3();
                bbox.getSize(size);
                const maxDim = Math.max(size.x, size.y, size.z);
                const scale = 2 / maxDim;
                geometry.scale(scale, scale, scale);

                if (!geometry.hasAttribute('normal')) {
                    geometry.computeVertexNormals();
                }

                // Create mesh
                const material = new THREE.MeshStandardMaterial({
                    color: 0x808080,
                    metalness: 0.2,
                    roughness: 0.6,
                });
                const mesh = new THREE.Mesh(geometry, material);
                scene.add(mesh);

                // Position camera
                camera.position.set(3, 3, 3);
                camera.lookAt(0, 0, 0);

                // Add OrbitControls if camera controls enabled
                let controls = null;
                if (cfg.cameraControls && THREE.OrbitControls) {
                    controls = new THREE.OrbitControls(camera, canvas);
                    controls.enableDamping = true;
                    controls.dampingFactor = 0.05;
                }

                // Animation loop
                const autoRotate = cfg.autoRotate;
                const rotationSpeed = (cfg.autoRotateSpeed || 30) * Math.PI / 180 / 60;

                const animate = () => {
                    this._animationId = requestAnimationFrame(animate);

                    if (autoRotate && mesh) {
                        mesh.rotation.y += rotationSpeed;
                    }

                    if (controls) {
                        controls.update();
                    }

                    renderer.render(scene, camera);
                };
                animate();

                // Store references for cleanup
                this._threeJSRenderer = renderer;
                this._threeJSControls = controls;

                // Hide empty state
                if (this.emptyState) {
                    this.emptyState.style.display = 'none';
                }

                console.log('[3D Viewer] STL rendered with Three.js');

            } catch (err) {
                console.error('[3D Viewer] Failed to render STL:', err);
                this.toggleEmpty();
            }
        }

        /**
         * Hook model-viewer events once the element is defined.
         */
        setupEvents() {
            if (!this.modelViewer) return;

            // Hide empty state when model loads
            this.modelViewer.addEventListener('load', () => {
                this.updateAnimationOptions();
                this.applyAnimation();
                this.toggleEmpty();
            });

            // Also observe src attribute changes (for async blob URL resolution)
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                        this.toggleEmpty();
                    }
                }
            });
            observer.observe(this.modelViewer, { attributes: true, attributeFilter: ['src'] });
        }

        /**
         * Apply config to the <model-viewer> element.
         */
        async applyConfig() {
            if (!this.modelViewer) return;
            const cfg = this.config;

            console.log('[3D Viewer] applyConfig called with src:', cfg.src);

            // First try synchronous resolution
            let viewerSrc = resolveRuntimeSrc(cfg.src, this.ideviceId);

            // If src is an asset:// URL and sync resolution returned empty, try async
            if (!viewerSrc && cfg.src && cfg.src.startsWith('asset://')) {
                console.log('[3D Viewer] Attempting async resolution for:', cfg.src);
                viewerSrc = await resolveAssetUrlAsync(cfg.src);
            }

            // Verify blob content before setting src (debug)
            if (viewerSrc && viewerSrc.startsWith('blob:')) {
                try {
                    const resp = await fetch(viewerSrc);
                    const buf = await resp.arrayBuffer();
                    const view = new DataView(buf);
                    const magic = view.getUint32(0, true);
                    const isGLB = magic === 0x46546C67; // 'glTF'
                    const firstChars = new TextDecoder().decode(buf.slice(0, 20));
                    console.log('[3D Viewer] Blob content check - isGLB:', isGLB, 'magic:', magic.toString(16), 'first chars:', firstChars, 'size:', buf.byteLength);
                    if (!isGLB) {
                        console.error('[3D Viewer] WARNING: Blob does not contain valid GLB data!');
                    }
                } catch (e) {
                    console.error('[3D Viewer] Failed to verify blob content:', e);
                }
            }

            console.log('[3D Viewer] Setting model-viewer src to:', viewerSrc);
            if (viewerSrc) {
                this.modelViewer.src = viewerSrc;
            }

            const alt = cfg.alt || '';
            this.modelViewer.alt = alt;
            if (alt) {
                this.modelViewer.setAttribute('aria-label', alt);
            } else {
                this.modelViewer.removeAttribute('aria-label');
            }

            // Only apply background if it's explicitly set in config
            // Otherwise, preserve whatever was set in the HTML
            if (cfg.backgroundColor) {
                this.modelViewer.style.backgroundColor = cfg.backgroundColor;
            }

            this.modelViewer.setAttribute('shadow-intensity', '1');
            this.modelViewer.setAttribute('tone-mapping', 'pbr-neutral');

            if (cfg.cameraControls) {
                this.modelViewer.setAttribute('camera-controls', '');
            } else {
                this.modelViewer.removeAttribute('camera-controls');
            }

            if (cfg.autoRotate) {
                this.modelViewer.setAttribute('auto-rotate', '');
                this.modelViewer.setAttribute('rotation-per-second', `${cfg.autoRotateSpeed || 30}deg`);
            } else {
                this.modelViewer.removeAttribute('auto-rotate');
                this.modelViewer.removeAttribute('rotation-per-second');
            }

            this.applyAnimation();
            this.toggleEmpty();
        }

        /**
         * Cache available animations from the loaded model, if any.
         */
        updateAnimationOptions() {
            if (!this.modelViewer) return;
            this.availableAnimations = Array.from(this.modelViewer.availableAnimations || []);
            if (!this.availableAnimations.length) {
                this.config.animation.name = '';
                this.config.animation.enabled = false;
            } else if (!this.availableAnimations.includes(this.config.animation.name)) {
                this.config.animation.name = this.availableAnimations[0];
            }
        }

        /**
         * Apply animation state (play/pause/speed/name).
         */
        applyAnimation() {
            if (!this.modelViewer) return;
            const animation = this.config.animation || {};
            if (!animation.enabled) {
                this.modelViewer.pause?.();
                this.announce(translate('viewer.animation_paused'));
                return;
            }
            const available = this.availableAnimations.length
                ? this.availableAnimations
                : Array.from(this.modelViewer.availableAnimations || []);
            const name = animation.name && available.includes(animation.name)
                ? animation.name
                : available[0];

            if (!name) {
                this.modelViewer.pause?.();
                return;
            }

            this.modelViewer.animationName = name;
            this.modelViewer.animationSpeed = animation.speed || 1;
            this.modelViewer.play?.({ repetitions: Infinity });
            this.announce(`${translate('viewer.animation_enabled')}: ${name}`);
        }

        /**
         * Show/hide empty-state banner.
         */
        toggleEmpty() {
            if (!this.emptyState) return;
            // Check for any valid src (including blob: URLs from asset resolution)
            const src = this.modelViewer?.getAttribute('src') || this.modelViewer?.src || '';
            // Show model if we have a valid src (blob: or http:) or if config has asset:// that will be resolved
            const hasValidSrc = src && (src.startsWith('blob:') || src.startsWith('http'));
            const hasConfigSrc = this.config.src && this.config.src.startsWith('asset://');
            const hasModel = hasValidSrc || hasConfigSrc;
            this.emptyState.style.display = hasModel ? 'none' : 'grid';
        }

        /**
         * Announce a short message to screen readers.
         * @param {string} message
         */
        announce(message) {
            if (!this.ariaLive) return;
            this.ariaLive.textContent = message;
        }
    }

    // ---------------------------------------------------------------------
    // Export helper class (used by the eXe engine to serialize/deserialize)
    // ---------------------------------------------------------------------
    if (!globalScope.ThreeDViewerExportObject) {
        globalScope.ThreeDViewerExportObject = class {
            init(node, resources) {
                this.node = node;
                this.resources = resources || null;
                return true;
            }
            toJSON() {
                if (this.node && typeof this.node.get3DViewerJSON === 'function') {
                    return this.node.get3DViewerJSON();
                }
                return {};
            }
            fromJSON(data) {
                if (this.node && typeof this.node.set3DViewerJSON === 'function') {
                    this.node.set3DViewerJSON(data || {});
                }
            }
        };
    }

    // ---------------------------------------------------------------------
    // Public API expected by eXe iDevice engine in export runtime
    // ---------------------------------------------------------------------
    globalScope.$threedviewer = globalScope.$threedviewer || {};

    Object.assign(globalScope.$threedviewer, {
        /**
         * Build the static HTML of the view.
         * Injects a modulepreload hint for the model-viewer library.
         */
        renderView: function (data, accessibility, template) {
            data = data || {};

            // Debug: log incoming data
            console.log('[3D Viewer] renderView data:', data);

            const viewerId = data.ideviceId || `three-d-viewer-${Date.now()}`;
            const anim = data.animation || {};
            const cfg = {
                src: normalizePath(data.src),
                alt: data.alt || '',
                backgroundColor: data.backgroundColor || DEFAULT_BACKGROUND,
                cameraControls: data.cameraControls !== false,
                autoRotate: data.autoRotate !== false,
                autoRotateSpeed: Number.isFinite(parseFloat(data.autoRotateSpeed))
                    ? parseFloat(data.autoRotateSpeed)
                    : 30,
                animation: {
                    enabled: !!anim.enabled,
                    name: anim.name || '',
                    speed: Number.isFinite(parseFloat(anim.speed)) ? parseFloat(anim.speed) : 1
                }
            };

            // Debug: log config
            console.log('[3D Viewer] renderView cfg:', cfg);

            // Preload the ES module for faster first paint
            appendModulePreloadOnce(getModelViewerLibUrl());

            // Store current iDevice ID for asset:// resolution
            globalScope.$threedviewer._currentIdeviceId = viewerId;

            // Use base64 encoding to avoid HTML attribute parsing issues
            const configEncoded = serializeConfig(cfg);
            const content = `
                <div class="three-d-viewer-wrapper" data-three-d id="${viewerId}" data-config="${configEncoded}">
                    ${buildModelMarkup(cfg, viewerId)}
                    <span class="sr-only" data-live aria-live="polite"></span>
                    <div class="viewer-empty" data-empty>${translate('viewer.empty_state')}</div>
                </div>
            `;
            return template.replace('{content}', content);
        },

        /**
         * Attach behaviors. Robust to missing data argument.
         * Ensures the model-viewer module is loaded before booting wrappers.
         */
        renderBehaviour: function (data, accessibility, ideviceId) {
            const id =
                (data && data.ideviceId) ||
                ideviceId ||
                '';

            // Try multiple selector patterns for the iDevice container
            let scope = document;
            if (id) {
                scope = document.querySelector(`.idevice_node.three-d-viewer[id="${id}"]`) ||
                        document.querySelector(`[idevice-id="${id}"]`) ||
                        document.querySelector(`#${id}`) ||
                        document;
            }

            // Find all wrappers, either in scope or in entire document
            let wrappers = Array.from(scope.querySelectorAll('.three-d-viewer-wrapper[data-three-d]'));

            // If no wrappers found in scope, search entire document
            if (!wrappers.length && scope !== document) {
                wrappers = Array.from(document.querySelectorAll('.three-d-viewer-wrapper[data-three-d]'));
            }

            if (!wrappers.length) return true;

            const boot = () => {
                wrappers.forEach((w) => {
                    if (w.dataset._threedBooted === '1') return;
                    w.dataset._threedBooted = '1';
                    const configAttr = w.getAttribute('data-config') || '';
                    const cfg = deserializeConfig(configAttr);
                    new ThreeDViewerRuntime(w, cfg);
                });
            };

            ensureModelViewerModule(id).then(boot);
            return true;
        },

        /** Not used here but kept for parity with other iDevices */
        init: function () {}
    });

    // Instance used by the engine to serialize/deserialize node data
    globalScope.$threedviewer.exportHelper = new globalScope.ThreeDViewerExportObject();

    // Optional helpers exposed for debugging
    globalScope.$threedviewer.getModelViewerLibUrl = getModelViewerLibUrl;
    globalScope.$threedviewer.resolveAssetUrl = resolveAssetUrl;
})();
