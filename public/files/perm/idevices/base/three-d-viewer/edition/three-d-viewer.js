/* global eXeLearning, eXe */

var $exeDevice = (function () {
    const DEFAULT_STATE = Object.freeze({
        src: '',
        alt: '',
        backgroundColor: '#f5f5f5',
        cameraControls: true,
        autoRotate: true,
        autoRotateSpeed: 30,
        animation: { enabled: false, name: '', speed: 1 },
    });

    const MODEL_EXTENSIONS = ['.glb', '.stl'];

    const cloneState = () => JSON.parse(JSON.stringify(DEFAULT_STATE));

    return {
        name: _('3D Viewer'),
        i18n: {
            name: _('3D Viewer'),
        },

        /**
         * Check if running in static mode (PWA/offline build).
         * In static mode, paths should be relative to avoid basePath duplication.
         * @returns {boolean}
         */
        isStaticMode: function () {
            const config = window.eXeLearning?.config;
            const parsedConfig = typeof config === 'string'
                ? (function () { try { return JSON.parse(config); } catch (e) { return null; } })()
                : config;
            return !!(parsedConfig?.isStaticMode || parsedConfig?.isOfflineInstallation);
        },
        ideviceBody: null,
        modelViewer: null,
        previewContainer: null,
        ariaLive: null,
        formElements: {},
        animationRow: null,
        modelFiles: [],
        isLoadingModels: false,
        modelViewerLibPromise: null,
        lastPreviewSrc: '',
        previewRetryCount: 0,
        state: cloneState(),

        init: async function (element, previousData) {
            this.ideviceBody = element;
            this.renderEditor();
            this.collectFormElements();
            this.set3DViewerJSON(previousData || {});
            this.applyStateToForm();
            await this.createModelViewer();

            // Pre-resolve asset:// URL if present (load blob into cache)
            if (this.state.src && this.state.src.startsWith('asset://')) {
                await this.preResolveAssetUrl(this.state.src);
            }

            this.updatePreview();
            this.registerBehaviours();
        },

        /**
         * Pre-resolve asset:// URL to ensure blob is in cache before displaying
         */
        preResolveAssetUrl: async function (assetUrl) {
            const assetManager = this.getAssetManager();
            if (!assetManager) return;

            try {
                // First check if already in cache
                const cached = assetManager.resolveAssetURLSync(assetUrl);
                if (cached) {
                    console.log('[3D Viewer] Asset already cached:', assetUrl);
                    this.state._previewBlobUrl = cached;
                    return;
                }

                // Load from IndexedDB
                console.log('[3D Viewer] Pre-loading asset into cache:', assetUrl);
                const blobUrl = await assetManager.resolveAssetURL(assetUrl);
                if (blobUrl) {
                    this.state._previewBlobUrl = blobUrl;
                    // Also update the form element data attribute for consistency
                    if (this.formElements.src) {
                        this.formElements.src.dataset.blobUrl = blobUrl;
                    }
                    console.log('[3D Viewer] Asset pre-loaded:', assetUrl, '->', blobUrl.substring(0, 50));
                }
            } catch (err) {
                console.error('[3D Viewer] Failed to pre-load asset:', assetUrl, err);
            }
        },

        /**
         * Check if a file path/URL is an STL file
         */
        isSTLFile: function (path) {
            if (!path) return false;
            const filename = path.split('/').pop() || '';
            return filename.toLowerCase().endsWith('.stl');
        },

        /**
         * Auto-convert STL to GLB when loading an existing iDevice with STL source
         */
        autoConvertSTLOnLoad: async function () {
            const assetUrl = this.state.src;
            console.log('[3D Viewer] Auto-converting STL on load:', assetUrl);

            // Get blob URL from AssetManager
            const assetManager = this.getAssetManager();
            if (!assetManager) {
                console.warn('[3D Viewer] No AssetManager available for STL conversion');
                this.updatePreview();
                return;
            }

            let blobUrl = assetManager.resolveAssetURLSync(assetUrl);
            if (!blobUrl) {
                // Asset might not be loaded yet - wait for it
                console.log('[3D Viewer] Waiting for STL asset to load...');
                try {
                    blobUrl = await assetManager.resolveAssetURL(assetUrl);
                } catch (err) {
                    console.warn('[3D Viewer] Failed to load STL asset:', err);
                    this.updatePreview();
                    return;
                }
            }

            if (!blobUrl) {
                console.warn('[3D Viewer] No blob URL for STL asset');
                this.updatePreview();
                return;
            }

            this.showConversionProgress();
            try {
                // Convert STL to GLB
                const glbBlob = await this.convertSTLToGLB(blobUrl);

                // Register converted GLB as a new asset
                const filename = assetUrl.split('/').pop() || 'model.stl';
                const glbFilename = filename.replace(/\.stl$/i, '.glb');
                const glbFile = new File([glbBlob], glbFilename, { type: 'model/gltf-binary' });

                const glbAssetUrl = await assetManager.insertImage(glbFile);
                console.log('[3D Viewer] Converted STL to GLB asset:', glbAssetUrl);

                // Update state and form with the new GLB URL
                this.state.src = glbAssetUrl;
                this.state._previewBlobUrl = assetManager.resolveAssetURLSync(glbAssetUrl);

                if (this.formElements.src) {
                    this.formElements.src.value = glbAssetUrl;
                    this.formElements.src.dataset.blobUrl = this.state._previewBlobUrl;
                }

                this.updatePreview();
            } catch (error) {
                console.error('[3D Viewer] Auto-conversion of STL failed:', error);
                this.updatePreview();
            } finally {
                this.hideConversionProgress();
            }
        },

        renderEditor: function () {
            const html = `
                <div class="three-d-viewer-editor" id="threeDViewerEditor">
                    <div class="container">
                        <!-- Preview area -->
                        <div class="ratio ratio-16x9 mb-4 viewer-preview-container">
                            <div class="viewer-preview" id="threeDViewerPreview">
                                <div class="viewer-empty" data-empty-state>
                                    <div class="viewer-empty-content">
                                        <svg class="viewer-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                                            <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                                            <line x1="12" y1="22.08" x2="12" y2="12"></line>
                                        </svg>
                                        <span>${_('Select a 3D model to preview')}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Model file selector -->
                        <div class="d-flex align-items-center mb-3">
                            <label for="threeD3DModelFile" class="form-label me-2 mb-0 text-nowrap">${_('3D Model')}:</label>
                            <input type="text" class="exe-file-picker form-control" id="threeD3DModelFile" readonly placeholder="${_('Select a GLB or STL file')}" />
                        </div>
                        <p class="form-text text-muted mb-4">${_('Supported formats')}: GLB, GLTF, STL</p>

                        <!-- Alt text -->
                        <div class="mb-4">
                            <label for="threeDAlt" class="form-label">${_('Alternative text')}:</label>
                            <input type="text" class="form-control" id="threeDAlt" maxlength="180" placeholder="${_('Describe the 3D model for accessibility')}" />
                            <p class="form-text text-muted">${_('Describe the 3D model for screen readers and accessibility')}</p>
                        </div>

                        <!-- Display options -->
                        <fieldset class="mb-4">
                            <legend class="h6 mb-3">${_('Display Options')}</legend>

                            <div class="row align-items-center mb-3">
                                <label for="threeDBackground" class="col-auto col-form-label">${_('Background color')}:</label>
                                <div class="col-auto">
                                    <input type="color" class="form-control form-control-color" id="threeDBackground" title="${_('Choose background color')}" />
                                </div>
                            </div>

                            <div class="d-flex align-items-center gap-2 flex-nowrap mb-3">
                                <div class="toggle-item">
                                    <span class="toggle-control">
                                        <input type="checkbox" id="threeDCameraControls" class="toggle-input" />
                                        <span class="toggle-visual"></span>
                                    </span>
                                    <label for="threeDCameraControls" class="toggle-label">${_('Enable camera controls')}</label>
                                </div>
                            </div>

                            <div class="d-flex align-items-center gap-2 flex-nowrap mb-3">
                                <div class="toggle-item">
                                    <span class="toggle-control">
                                        <input type="checkbox" id="threeDAutoRotate" class="toggle-input" />
                                        <span class="toggle-visual"></span>
                                    </span>
                                    <label for="threeDAutoRotate" class="toggle-label">${_('Auto-rotate model')}</label>
                                </div>
                                <div class="d-flex align-items-center gap-2" id="threeDAutoRotateSpeedRow">
                                    <label for="threeDAutoRotateSpeed" class="form-label mb-0 text-nowrap">${_('Speed')}:</label>
                                    <div class="input-group" style="width: 7em;">
                                        <input type="number" class="form-control" id="threeDAutoRotateSpeed" min="1" max="90" step="1" value="30" />
                                        <span class="input-group-text">°/s</span>
                                    </div>
                                </div>
                            </div>
                        </fieldset>

                        <!-- Animation options (shown when model has animations) -->
                        <fieldset class="mb-3" data-animation-row hidden>
                            <legend class="h6 mb-3">${_('Animation')}</legend>

                            <div class="d-flex align-items-center gap-2 flex-nowrap mb-3">
                                <div class="toggle-item">
                                    <span class="toggle-control">
                                        <input type="checkbox" id="threeDAnimationToggle" class="toggle-input" />
                                        <span class="toggle-visual"></span>
                                    </span>
                                    <label for="threeDAnimationToggle" class="toggle-label">${_('Play animation')}</label>
                                </div>
                            </div>

                            <div class="row g-3">
                                <div class="col-sm-6">
                                    <label for="threeDAnimationName" class="form-label">${_('Animation')}:</label>
                                    <select class="form-select" id="threeDAnimationName"></select>
                                </div>
                                <div class="col-sm-6">
                                    <label for="threeDAnimationSpeed" class="form-label">${_('Speed')}:</label>
                                    <div class="input-group">
                                        <input type="number" class="form-control" id="threeDAnimationSpeed" min="0.1" max="3" step="0.1" value="1" />
                                        <span class="input-group-text">x</span>
                                    </div>
                                </div>
                            </div>
                        </fieldset>
                    </div>
                    <div class="sr-only" id="threeDAnimationLive" aria-live="polite"></div>
                </div>
            `;
            this.ideviceBody.innerHTML = html;
        },

        collectFormElements: function () {
            this.previewContainer = this.ideviceBody.querySelector('#threeDViewerPreview');
            this.ariaLive = this.ideviceBody.querySelector('#threeDAnimationLive');
            this.animationRow = this.ideviceBody.querySelector('[data-animation-row]');
            this.formElements = {
                src: this.ideviceBody.querySelector('#threeD3DModelFile'),
                alt: this.ideviceBody.querySelector('#threeDAlt'),
                backgroundColor: this.ideviceBody.querySelector('#threeDBackground'),
                cameraControls: this.ideviceBody.querySelector('#threeDCameraControls'),
                autoRotate: this.ideviceBody.querySelector('#threeDAutoRotate'),
                autoRotateSpeed: this.ideviceBody.querySelector('#threeDAutoRotateSpeed'),
                animationToggle: this.ideviceBody.querySelector('#threeDAnimationToggle'),
                animationName: this.ideviceBody.querySelector('#threeDAnimationName'),
                animationSpeed: this.ideviceBody.querySelector('#threeDAnimationSpeed'),
            };
        },

        set3DViewerJSON: function (data) {
            const merged = cloneState();
            if (data && typeof data === 'object') {
                merged.src = data.src || merged.src;
                merged.alt = data.alt || merged.alt;
                merged.backgroundColor = data.backgroundColor || merged.backgroundColor;
                merged.cameraControls = typeof data.cameraControls === 'boolean' ? data.cameraControls : merged.cameraControls;
                merged.autoRotate = typeof data.autoRotate === 'boolean' ? data.autoRotate : merged.autoRotate;
                const autoRotateSpeed = parseFloat(data.autoRotateSpeed);
                if (!Number.isNaN(autoRotateSpeed)) {
                    merged.autoRotateSpeed = autoRotateSpeed;
                }
                if (data.animation && typeof data.animation === 'object') {
                    merged.animation.enabled = !!data.animation.enabled;
                    merged.animation.name = data.animation.name || '';
                    const speed = parseFloat(data.animation.speed);
                    if (!Number.isNaN(speed)) {
                        merged.animation.speed = Math.min(Math.max(speed, 0.1), 3);
                    }
                }
            }
            merged.backgroundColor = merged.backgroundColor || '#f5f5f5';
            merged.src = this.resolveModelPath(merged.src);
            this.state = merged;
        },

        get3DViewerJSON: function () {
            return JSON.parse(JSON.stringify(this.state));
        },

        applyStateToForm: function () {
            const s = this.state;
            this.formElements.src.value = s.src || '';
            this.formElements.alt.value = s.alt || '';
            this.formElements.backgroundColor.value = s.backgroundColor || '#f5f5f5';
            this.formElements.cameraControls.checked = !!s.cameraControls;
            this.formElements.autoRotate.checked = !!s.autoRotate;
            this.formElements.autoRotateSpeed.value = s.autoRotateSpeed || 30;
            this.formElements.animationToggle.checked = !!s.animation.enabled;
            this.formElements.animationSpeed.value = s.animation.speed || 1;
            this.formElements.animationName.value = s.animation.name || '';
            this.updateAutoRotateSpeedState();
            if (this.animationRow) {
                this.toggleAnimationRow(false);
            }
            this.formElements.animationToggle.disabled = true;
            this.formElements.animationName.disabled = true;
            this.formElements.animationSpeed.disabled = true;
        },

        readFormState: function () {
            const backgroundColor = this.formElements.backgroundColor.value || '#f5f5f5';
            // Preserve _previewBlobUrl across state updates
            const previewBlobUrl = this.state._previewBlobUrl;
            this.state = {
                src: this.resolveModelPath(this.formElements.src.value.trim()),
                alt: this.formElements.alt.value.trim(),
                backgroundColor,
                cameraControls: !!this.formElements.cameraControls.checked,
                autoRotate: !!this.formElements.autoRotate.checked,
                autoRotateSpeed: parseFloat(this.formElements.autoRotateSpeed.value) || 30,
                animation: {
                    enabled: !!this.formElements.animationToggle.checked,
                    name: this.formElements.animationName.value || '',
                    speed: Math.min(Math.max(parseFloat(this.formElements.animationSpeed.value) || 1, 0.1), 3),
                },
            };
            // Restore preview blob URL if it existed
            if (previewBlobUrl) {
                this.state._previewBlobUrl = previewBlobUrl;
            }
            this.updateAutoRotateSpeedState();
        },

        registerBehaviours: function () {
            const onChange = () => {
                this.readFormState();
                this.updatePreview();
            };

            Object.entries(this.formElements).forEach(([key, element]) => {
                if (!element || key === 'src') {
                    // Skip src - we handle it separately for STL conversion
                    return;
                }
                const events = new Set(['change']);
                if (element.tagName === 'INPUT' && element.type === 'text') {
                    events.add('input');
                }
                events.forEach((eventName) => element.addEventListener(eventName, onChange));
            });

            // Handle file picker change (set by legacyExeIdevicesFilePicker)
            if (this.formElements.src) {
                this.formElements.src.addEventListener('change', () => this.handleModelSelection());
            }

            this.formElements.autoRotate.addEventListener('change', () => this.updateAutoRotateSpeedState());
        },

        updateAutoRotateSpeedState: function () {
            const enabled = this.formElements.autoRotate.checked;
            this.formElements.autoRotateSpeed.disabled = !enabled;
            // Show/hide the speed row
            const speedRow = this.ideviceBody.querySelector('#threeDAutoRotateSpeedRow');
            if (speedRow) {
                speedRow.style.display = enabled ? '' : 'none';
            }
        },

        createModelViewer: async function () {
            await this.ensureModelViewerLoaded();
            this.modelViewer = document.createElement('model-viewer');
            this.modelViewer.setAttribute('shadow-intensity', '1');
            this.modelViewer.setAttribute('tone-mapping', 'pbr-neutral');
            this.modelViewer.setAttribute('reveal', 'auto');
            this.modelViewer.style.width = '100%';
            this.modelViewer.style.height = '100%';
            this.modelViewer.addEventListener('load', () => {
                this.updateAnimationOptions();
                this.applyAnimationState();
                this.toggleEmptyState();
                this.previewRetryCount = 0;
            });
            this.modelViewer.addEventListener('error', () => {
                if (!this.state?.src) {
                    return;
                }
                if (this.previewRetryCount >= 3) {
                    return;
                }
                this.previewRetryCount += 1;
                window.setTimeout(() => this.updatePreview(true), 150 * this.previewRetryCount);
            });
            this.previewContainer.prepend(this.modelViewer);
        },

        updatePreview: async function (force = false) {
            const state = this.state;
            const background = state.backgroundColor || '#f5f5f5';
            this.previewContainer?.style?.setProperty('--viewer-preview-bg', background);

            // Check if file is STL - render with Three.js directly
            if (state.src && this.isSTLFile(state.src)) {
                await this.renderSTLWithThreeJS(force);
                return;
            }

            // For GLB/GLTF files, use model-viewer
            if (!this.modelViewer) return;

            // Ensure model-viewer is visible (might have been hidden for STL)
            this.modelViewer.style.display = '';
            this.hideThreeJSCanvas();

            const viewerSrc = this.getModelViewerUrl(state.src);
            if (viewerSrc && (force || viewerSrc !== this.lastPreviewSrc || !this.modelViewer.src)) {
                this.lastPreviewSrc = viewerSrc;
                this.modelViewer.src = viewerSrc;
            }
            this.modelViewer.alt = state.alt || '';
            if (state.alt) {
                this.modelViewer.setAttribute('aria-label', state.alt);
            } else {
                this.modelViewer.removeAttribute('aria-label');
            }
            this.modelViewer.style.backgroundColor = background;
            if (state.cameraControls) {
                this.modelViewer.setAttribute('camera-controls', '');
            } else {
                this.modelViewer.removeAttribute('camera-controls');
            }
            if (state.autoRotate) {
                this.modelViewer.setAttribute('auto-rotate', '');
                this.modelViewer.setAttribute('rotation-per-second', `${state.autoRotateSpeed || 30}deg`);
            } else {
                this.modelViewer.removeAttribute('auto-rotate');
                this.modelViewer.removeAttribute('rotation-per-second');
            }
            this.applyAnimationState();
            this.toggleEmptyState();
        },

        /**
         * Render STL file directly with Three.js
         */
        renderSTLWithThreeJS: async function (force = false) {
            const state = this.state;
            let blobUrl = this.getModelViewerUrl(state.src);

            // If no blob URL, try async resolution for asset:// URLs
            if (!blobUrl && state.src && state.src.startsWith('asset://')) {
                console.log('[3D Viewer] STL: No blob URL yet, trying async resolution...');

                // Wait for AssetManager to be available (may take a moment after page re-edit)
                const assetManager = await this.waitForAssetManager(5000);
                if (assetManager) {
                    try {
                        blobUrl = await assetManager.resolveAssetURL(state.src);
                        if (blobUrl) {
                            this.state._previewBlobUrl = blobUrl;
                            if (this.formElements.src) {
                                this.formElements.src.dataset.blobUrl = blobUrl;
                            }
                            console.log('[3D Viewer] STL: Async resolution succeeded:', blobUrl.substring(0, 50));
                        }
                    } catch (err) {
                        console.error('[3D Viewer] STL: Async resolution failed:', err);
                    }
                } else {
                    console.warn('[3D Viewer] STL: AssetManager not available after waiting');
                }
            }

            if (!blobUrl) {
                console.warn('[3D Viewer] STL: No blob URL available for:', state.src);
                this.toggleEmptyState();
                return;
            }

            // Skip if same src and not forcing
            if (!force && blobUrl === this.lastPreviewSrc && this.threeJSRenderer) {
                return;
            }
            this.lastPreviewSrc = blobUrl;

            // Hide model-viewer, show Three.js canvas
            if (this.modelViewer) {
                this.modelViewer.style.display = 'none';
            }

            await this.ensureThreeJSLoaded();

            // Create or get canvas
            let canvas = this.previewContainer.querySelector('.three-js-canvas');
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.className = 'three-js-canvas';
                canvas.style.cssText = 'width: 100%; height: 100%; display: block;';
                this.previewContainer.appendChild(canvas);
            }
            canvas.style.display = 'block';

            // Initialize Three.js scene
            const THREE = window.THREE;
            const width = this.previewContainer.clientWidth || 400;
            const height = this.previewContainer.clientHeight || 300;

            // Clean up previous renderer
            if (this.threeJSRenderer) {
                this.threeJSRenderer.dispose();
                if (this.threeJSAnimationId) {
                    cancelAnimationFrame(this.threeJSAnimationId);
                }
            }

            // Create scene
            const scene = new THREE.Scene();
            scene.background = new THREE.Color(state.backgroundColor || '#f5f5f5');

            // Create camera
            const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);

            // Create renderer
            const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
            renderer.setSize(width, height);
            renderer.setPixelRatio(window.devicePixelRatio);
            this.threeJSRenderer = renderer;

            // Add lights
            const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
            scene.add(ambientLight);
            const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
            directionalLight.position.set(1, 1, 1);
            scene.add(directionalLight);
            const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
            directionalLight2.position.set(-1, -1, -1);
            scene.add(directionalLight2);

            try {
                // Load STL
                const response = await fetch(blobUrl);
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
                const scale = 2 / maxDim; // Normalize to fit in view
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
                if (state.cameraControls && THREE.OrbitControls) {
                    controls = new THREE.OrbitControls(camera, canvas);
                    controls.enableDamping = true;
                    controls.dampingFactor = 0.05;
                }

                // Animation loop
                const autoRotate = state.autoRotate;
                const rotationSpeed = (state.autoRotateSpeed || 30) * Math.PI / 180 / 60; // deg/s to rad/frame

                const animate = () => {
                    this.threeJSAnimationId = requestAnimationFrame(animate);

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
                this.threeJSScene = scene;
                this.threeJSCamera = camera;
                this.threeJSControls = controls;
                this.threeJSMesh = mesh;

                this.toggleEmptyState();
                console.log('[3D Viewer] STL rendered with Three.js');

            } catch (err) {
                console.error('[3D Viewer] Failed to render STL:', err);
                this.toggleEmptyState();
            }
        },

        /**
         * Hide Three.js canvas
         */
        hideThreeJSCanvas: function () {
            const canvas = this.previewContainer?.querySelector('.three-js-canvas');
            if (canvas) {
                canvas.style.display = 'none';
            }
            if (this.threeJSAnimationId) {
                cancelAnimationFrame(this.threeJSAnimationId);
                this.threeJSAnimationId = null;
            }
        },

        applyAnimationState: function () {
            if (!this.modelViewer) return;
            const animation = this.state.animation;
            if (!animation.enabled) {
                this.modelViewer.pause?.();
                this.announce(_('Animation paused'));
                return;
            }
            const available = Array.from(this.modelViewer.availableAnimations || []);
            const targetName = animation.name && available.includes(animation.name) ? animation.name : available[0];
            if (!targetName) {
                this.modelViewer.pause?.();
                return;
            }
            this.modelViewer.animationName = targetName;
            this.modelViewer.animationSpeed = animation.speed || 1;
            this.modelViewer.play?.({ repetitions: Infinity });
            this.announce(`${_('Playing animation')}: ${targetName}`);
        },

        updateAnimationOptions: function () {
            if (!this.modelViewer) return;
            const select = this.formElements.animationName;
            if (!select) return;
            const available = Array.from(this.modelViewer.availableAnimations || []);
            select.innerHTML = '';
            available.forEach((name) => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                select.appendChild(option);
            });
            if (available.length) {
                const selected = available.includes(this.state.animation.name)
                    ? this.state.animation.name
                    : available[0];
                select.value = selected;
                this.state.animation.name = selected;
                this.toggleAnimationRow(true);
                this.formElements.animationToggle.disabled = false;
            } else {
                this.formElements.animationToggle.checked = false;
                this.formElements.animationToggle.disabled = true;
                this.state.animation.enabled = false;
                this.state.animation.name = '';
                this.toggleAnimationRow(false);
            }
        },

        toggleAnimationRow: function (visible) {
            if (!this.animationRow) return;
            this.animationRow.hidden = !visible;
            if (!visible) {
                this.formElements.animationToggle.checked = false;
                this.formElements.animationName.disabled = true;
                this.formElements.animationSpeed.disabled = true;
            } else {
                this.formElements.animationName.disabled = false;
                this.formElements.animationSpeed.disabled = false;
            }
            this.formElements.animationToggle.disabled = !visible;
        },

        save: function () {
            this.readFormState();
            const src = this.state.src;
            if (!src) {
                eXe?.app?.alert?.(_('Please select a 3D model file'));
                return false;
            }
            if (!this.isSupportedModelFile(src)) {
                eXe?.app?.alert?.(_('Please select a valid 3D model file (GLB, GLTF, or STL)'));
                return false;
            }
            return this.get3DViewerJSON();
        },

        get3DViewerJSON: function () {
            return JSON.parse(JSON.stringify(this.state));
        },

        /**
         * Handle model selection from file picker
         * Supports both GLB (direct) and STL (conversion to GLB)
         */
        handleModelSelection: async function () {
            const assetUrl = this.formElements.src.value;
            let blobUrl = this.formElements.src.dataset.blobUrl;

            if (!assetUrl) return;

            // If no blob URL in data attribute, try AssetManager
            if (!blobUrl && assetUrl.startsWith('asset://')) {
                const assetManager = this.getAssetManager();
                if (assetManager) {
                    // Try sync first
                    blobUrl = assetManager.resolveAssetURLSync(assetUrl);
                    // If not in cache, load async
                    if (!blobUrl) {
                        console.log('[3D Viewer] Loading asset async in handleModelSelection:', assetUrl);
                        try {
                            blobUrl = await assetManager.resolveAssetURL(assetUrl);
                        } catch (err) {
                            console.error('[3D Viewer] Failed to load asset:', err);
                        }
                    }
                }
            }

            const filename = assetUrl.split('/').pop() || '';
            const ext = filename.split('.').pop()?.toLowerCase();

            if (ext === 'stl') {
                // STL files need conversion to GLB for model-viewer
                if (!blobUrl) {
                    console.warn('[3D Viewer] No blob URL for STL conversion');
                    return;
                }

                this.showConversionProgress();
                try {
                    // Convert STL to GLB
                    const glbBlob = await this.convertSTLToGLB(blobUrl);

                    // Register converted GLB as a new asset
                    const assetManager = this.getAssetManager();
                    if (assetManager) {
                        // Create a File object from the blob
                        const glbFilename = filename.replace(/\.stl$/i, '.glb');
                        const glbFile = new File([glbBlob], glbFilename, { type: 'model/gltf-binary' });

                        // Verify the GLB file content before storing
                        const glbArrayBuffer = await glbFile.arrayBuffer();
                        const glbView = new DataView(glbArrayBuffer);
                        const magic = glbView.getUint32(0, true);
                        if (magic !== 0x46546C67) {
                            console.error('[3D Viewer] GLB file has wrong magic bytes before storage:', magic.toString(16));
                        } else {
                            console.log('[3D Viewer] GLB file verified before storage, size:', glbArrayBuffer.byteLength);
                        }

                        // Register as asset - this returns asset://uuid.glb
                        const glbAssetUrl = await assetManager.insertImage(glbFile);
                        console.log('[3D Viewer] Converted STL registered as GLB asset:', glbAssetUrl);

                        // Use the converted GLB URL as the source
                        this.state.src = glbAssetUrl;
                        this.state._previewBlobUrl = assetManager.resolveAssetURLSync(glbAssetUrl);

                        // Verify the stored blob is correct
                        if (this.state._previewBlobUrl) {
                            fetch(this.state._previewBlobUrl).then(resp => resp.arrayBuffer()).then(buf => {
                                const view = new DataView(buf);
                                const storedMagic = view.getUint32(0, true);
                                if (storedMagic !== 0x46546C67) {
                                    console.error('[3D Viewer] STORED blob has wrong magic bytes:', storedMagic.toString(16), 'First bytes:', new Uint8Array(buf.slice(0, 20)));
                                } else {
                                    console.log('[3D Viewer] STORED blob verified, size:', buf.byteLength);
                                }
                            }).catch(err => console.error('[3D Viewer] Failed to verify stored blob:', err));
                        }

                        // Update the file picker input to show the GLB
                        if (this.formElements.src) {
                            this.formElements.src.value = glbAssetUrl;
                            this.formElements.src.dataset.blobUrl = this.state._previewBlobUrl;
                        }
                    } else {
                        // Fallback: just use blob URL for preview (won't work in export)
                        const glbBlobUrl = URL.createObjectURL(glbBlob);
                        this.state.src = assetUrl;
                        this.state._previewBlobUrl = glbBlobUrl;
                    }

                    this.readFormState();
                    this.updatePreview();
                } catch (error) {
                    console.error('[3D Viewer] STL conversion failed:', error);
                } finally {
                    this.hideConversionProgress();
                }
            } else {
                // GLB/GLTF - use directly
                this.state.src = assetUrl;
                this.state._previewBlobUrl = blobUrl;
                this.readFormState();
                this.updatePreview();
            }
        },

        /**
         * Convert STL file to GLB format using Three.js
         * @param {string} blobUrl - The blob URL of the STL file
         * @returns {Promise<Blob>} - The converted GLB as a Blob
         */
        convertSTLToGLB: async function (blobUrl) {
            await this.ensureThreeJSLoaded();

            const response = await fetch(blobUrl);
            const arrayBuffer = await response.arrayBuffer();

            const loader = new window.THREE.STLLoader();
            const geometry = loader.parse(arrayBuffer);
            geometry.center();
            if (!geometry.hasAttribute('normal')) {
                geometry.computeVertexNormals();
            }

            const material = new window.THREE.MeshStandardMaterial({
                color: 0x808080,
                metalness: 0.2,
                roughness: 0.6,
            });

            const mesh = new window.THREE.Mesh(geometry, material);
            const scene = new window.THREE.Scene();
            scene.add(mesh);

            const exporter = new window.THREE.GLTFExporter();
            return new Promise((resolve, reject) => {
                exporter.parse(
                    scene,
                    (glb) => {
                        // Validate that we got binary GLB data
                        if (!(glb instanceof ArrayBuffer)) {
                            console.error('[3D Viewer] GLTFExporter did not return ArrayBuffer:', typeof glb);
                            reject(new Error('GLTFExporter returned invalid data type'));
                            return;
                        }
                        // Check GLB magic bytes (glTF = 0x46546C67)
                        const view = new DataView(glb);
                        const magic = view.getUint32(0, true);
                        if (magic !== 0x46546C67) {
                            console.error('[3D Viewer] Invalid GLB magic bytes:', magic.toString(16));
                            reject(new Error('Invalid GLB format'));
                            return;
                        }
                        console.log('[3D Viewer] GLB conversion successful, size:', glb.byteLength);
                        const blob = new Blob([glb], { type: 'model/gltf-binary' });
                        resolve(blob);
                    },
                    (error) => {
                        console.error('[3D Viewer] GLTFExporter error:', error);
                        reject(error);
                    },
                    { binary: true },
                );
            });
        },

        /**
         * Load Three.js modules for STL conversion
         */
        ensureThreeJSLoaded: async function () {
            if (window.THREE?.STLLoader && window.THREE?.GLTFExporter && window.THREE?.OrbitControls) {
                return;
            }
            if (this._threeLoadPromise) {
                return this._threeLoadPromise;
            }

            // Use absolute URL with protocol to avoid path duplication in dynamic imports
            const basePath = this.getThreeJSBaseUrl();

            this._threeLoadPromise = (async () => {
                const THREE = await import(basePath + 'three.module.min.js');
                const { STLLoader } = await import(basePath + 'STLLoader.js');
                const { GLTFExporter } = await import(basePath + 'GLTFExporter.js');
                const { OrbitControls } = await import(basePath + 'OrbitControls.js');

                window.THREE = window.THREE || {};
                Object.assign(window.THREE, THREE);
                window.THREE.STLLoader = STLLoader;
                window.THREE.GLTFExporter = GLTFExporter;
                window.THREE.OrbitControls = OrbitControls;
            })();

            return this._threeLoadPromise;
        },

        showConversionProgress: function () {
            const empty = this.previewContainer?.querySelector('[data-empty-state]');
            if (empty) {
                const content = empty.querySelector('.viewer-empty-content');
                if (content) {
                    content.querySelector('span').textContent = _('Converting STL file...');
                } else {
                    empty.textContent = _('Converting STL file...');
                }
                empty.style.display = 'grid';
            }
        },

        hideConversionProgress: function () {
            this.toggleEmptyState();
        },

        toggleEmptyState: function () {
            const empty = this.previewContainer.querySelector('[data-empty-state]');
            if (!empty) return;
            const hasModel = !!(this.state.src || this.modelViewer?.currentSrc || this.modelViewer?.src);
            empty.style.display = hasModel ? 'none' : 'grid';
        },

        announce: function (message) {
            if (!this.ariaLive) return;
            this.ariaLive.textContent = message;
        },

        /**
         * Check if a file path/URL refers to a supported 3D model format.
         * Handles asset:// URLs, blob: URLs, and regular file paths.
         * @param {string} path - File path or URL
         * @returns {boolean}
         */
        isSupportedModelFile: function (path) {
            if (!path) return false;
            let filename = String(path).toLowerCase();

            // Extract extension from asset:// URL (format: asset://uuid.ext)
            if (filename.startsWith('asset://')) {
                // New format: asset://uuid.ext - just need the extension
                filename = filename.substring('asset://'.length);
            }
            // For blob: URLs, we can't check extension - assume valid if we have blob URL
            // (the file was already validated when uploaded)
            else if (filename.startsWith('blob:')) {
                return true;
            }
            // Extract filename from regular paths
            else {
                const parts = filename.split('/');
                filename = parts[parts.length - 1] || '';
            }

            // Remove query string if present
            filename = filename.split('?')[0].split('#')[0];

            if (!filename) return false;
            return MODEL_EXTENSIONS.some((ext) => filename.endsWith(ext));
        },

        buildFilemanagerUrl: function (endpoint, params = {}) {
            const symfony = window.eXeLearning?.symfony || {};
            const baseURL = (symfony.baseURL || '').replace(/\/+$/g, '');
            const basePath = symfony.basePath ? `/${symfony.basePath.replace(/^\/+|\/+$/g, '')}` : '';
            const base = `${baseURL}${basePath}`.replace(/\/+$/g, '');
            const endpointPath = `filemanager/${String(endpoint || '').replace(/^\/+/, '')}`;
            const urlBase = base ? `${base}/${endpointPath}` : `/${endpointPath}`;
            const search = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') {
                    search.append(key, value);
                }
            });
            const sessionId = window.eXeLearning?.app?.project?.odeSession;
            if (sessionId) {
                search.set('odeSessionId', sessionId);
            }
            const query = search.toString();
            return query ? `${urlBase}?${query}` : urlBase;
        },

        resolveModelPath: function (relativePath) {
            if (/^(https?:)?\/\//i.test(relativePath || '')) {
                return String(relativePath || '').trim();
            }
            const cleanPath = String(relativePath || '').replace(/^\/+/, '').replace(/\\+/g, '/');
            if (!cleanPath) {
                return '';
            }
            // Handle asset:// URLs - return unchanged
            if (cleanPath.startsWith('asset://')) {
                return cleanPath;
            }
            // Handle blob: URLs - return unchanged
            if (cleanPath.startsWith('blob:')) {
                return cleanPath;
            }
            if (cleanPath.startsWith('files/')) {
                return cleanPath;
            }
            if (cleanPath.startsWith('custom/')) {
                return cleanPath;
            }
            if (cleanPath.startsWith('file_manager/')) {
                return cleanPath;
            }
            return `file_manager/${cleanPath}`;
        },
        getModelViewerUrl: function (relativePath) {
            // If we have a converted preview blob URL (from STL conversion), use it
            if (this.state._previewBlobUrl) {
                return this.state._previewBlobUrl;
            }

            // Handle asset:// URLs - resolve via AssetManager
            if (relativePath && relativePath.startsWith('asset://')) {
                const assetManager = this.getAssetManager();
                if (assetManager) {
                    // Try sync resolution first (instant if cached)
                    const blobUrl = assetManager.resolveAssetURLSync(relativePath);
                    if (blobUrl) return blobUrl;

                    // If not in cache, trigger async load and return empty for now
                    // The model will be loaded when resolveAssetAndUpdate is called
                    console.log('[3D Viewer] Asset not in cache, triggering async load:', relativePath);
                    this.resolveAssetAndUpdate(relativePath);
                    return ''; // Return empty - model-viewer will show empty state until loaded
                }
                // Fallback: try to get blob from input data attribute
                if (this.formElements.src?.dataset?.blobUrl) {
                    return this.formElements.src.dataset.blobUrl;
                }
                // Don't fall through - asset:// URLs can't be loaded directly
                console.warn('[3D Viewer] Cannot resolve asset:// URL without AssetManager:', relativePath);
                return '';
            }

            // Handle blob: URLs directly
            if (relativePath && relativePath.startsWith('blob:')) {
                return relativePath;
            }

            const normalized = this.resolveModelPath(relativePath);
            if (!normalized) {
                return '';
            }
            if (/^(https?:)?\/\//i.test(normalized)) {
                return normalized;
            }
            if (normalized.startsWith('files/tmp/')) {
                return this.resolveAssetUrl(normalized);
            }
            const sessionId = this.getOdeSessionId();
            if (sessionId && sessionId.length >= 8) {
                const year = sessionId.substring(0, 4);
                const month = sessionId.substring(4, 6);
                const day = sessionId.substring(6, 8);
                const sessionPrefix = `files/tmp/${year}/${month}/${day}/${sessionId}/`;
                if (normalized.startsWith('file_manager/')) {
                    return this.resolveAssetUrl(`${sessionPrefix}${normalized}`);
                }
            }
            return this.resolveAssetUrl(normalized);
        },

        /**
         * Resolve asset:// URL asynchronously and update preview when ready
         */
        resolveAssetAndUpdate: async function (assetUrl) {
            const assetManager = this.getAssetManager();
            if (!assetManager) return;

            try {
                const blobUrl = await assetManager.resolveAssetURL(assetUrl);
                if (blobUrl) {
                    console.log('[3D Viewer] Asset resolved:', assetUrl, '->', blobUrl.substring(0, 50));
                    this.state._previewBlobUrl = blobUrl;
                    this.updatePreview(true); // Force update with new blob URL
                }
            } catch (err) {
                console.error('[3D Viewer] Failed to resolve asset:', assetUrl, err);
            }
        },

        /**
         * Wait for AssetManager to become available.
         * Useful when iDevice is re-edited and AssetManager might not be immediately ready.
         * @param {number} timeout - Max wait time in ms
         * @returns {Promise<object|null>}
         */
        /**
         * Get the AssetManager from the current context.
         * Checks both project.assetManager and project._yjsBridge.assetManager.
         * @returns {object|null}
         */
        getAssetManager: function () {
            return window.eXeLearning?.app?.project?.assetManager ||
                   window.eXeLearning?.app?.project?._yjsBridge?.assetManager ||
                   null;
        },

        waitForAssetManager: async function (timeout = 5000) {
            const startTime = Date.now();
            const pollInterval = 100;

            while (Date.now() - startTime < timeout) {
                const assetManager = this.getAssetManager();
                if (assetManager) {
                    return assetManager;
                }
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }

            return null;
        },

        resolveModelUrl: function (path) {
            const symfony = window.eXeLearning?.symfony || {};
            const baseURL = (symfony.baseURL || '').replace(/\/+$/g, '');
            const basePath = symfony.basePath ? `/${symfony.basePath.replace(/^\/+|\/+$/g, '')}` : '';
            const prefix = `${baseURL}${basePath}`.replace(/\/+$/g, '');
            const normalized = String(path || '').replace(/^\/+/, '');
            return prefix ? `${prefix}/${normalized}` : `/${normalized}`;
        },

        formatModelLabel: function (path) {
            const normalized = this.resolveModelPath(path);
            if (!normalized) {
                return '';
            }
            if (normalized.startsWith('files/tmp/')) {
                const index = normalized.indexOf('file_manager/');
                if (index !== -1) {
                    return normalized.substring(index + 'file_manager/'.length);
                }
                const parts = normalized.split('/');
                return parts[parts.length - 1] || normalized;
            }
            return normalized.replace(/^file_manager\//, '');
        },

        resolveAssetUrl: function (path) {
            const symfony = window.eXeLearning?.symfony || {};
            const baseURL = (symfony.baseURL || '').replace(/\/+$/g, '');
            const basePath = symfony.basePath ? `/${symfony.basePath.replace(/^\/+|\/+$/g, '')}` : '';
            const base = `${baseURL}${basePath}`.replace(/\/+$/g, '');
            const normalized = String(path || '').replace(/^\/+/, '');
            return base ? `${base}/${normalized}` : `/${normalized}`;
        },

        /**
         * Get the base URL for Three.js modules with absolute URL including protocol.
         *
         * WHY absolute URLs: Dynamic import() resolves paths relative to the current
         * module's location. If we return a relative path like `/files/perm/...`,
         * and the module is loaded from `/files/perm/.../three-d-viewer.js`, the
         * browser will resolve it as `/files/perm/.../files/perm/...`, causing
         * path duplication. Using absolute URLs (http://...) prevents this.
         *
         * WHY check for protocol: symfony.baseURL might be a relative path (e.g., '/app')
         * or empty. We must ensure the final URL has a protocol for dynamic imports
         * to work correctly regardless of how the main script was loaded.
         *
         * @returns {string} Absolute URL ending with trailing slash (e.g., 'https://example.com/files/perm/.../edition/')
         */
        getThreeJSBaseUrl: function () {
            const relativePath = 'files/perm/idevices/base/three-d-viewer/edition/';

            // In static mode, use origin + path without basePath to avoid duplication
            // Static deployments serve files from the deploy root, and basePath is already
            // in the URL - adding it again causes path duplication like /pr-preview/pr-888/pr-preview/pr-888/...
            if (this.isStaticMode()) {
                return window.location.origin + '/' + relativePath;
            }

            const symfony = window.eXeLearning?.symfony || {};
            const baseURL = String(symfony.baseURL || '').replace(/\/+$/g, '');
            const basePath = symfony.basePath ? `/${symfony.basePath.replace(/^\/+|\/+$/g, '')}` : '';
            let url = `${baseURL}${basePath}/${relativePath}`;

            // Ensure absolute URL with protocol for dynamic imports
            if (!/^https?:\/\//i.test(url)) {
                url = window.location.origin + (url.startsWith('/') ? '' : '/') + url;
            }
            return url;
        },

        ensureModelViewerLoaded: function () {
            // Early exit if already registered
            if (window.customElements?.get?.('model-viewer')) {
                return Promise.resolve();
            }

            // Use global namespace to coordinate loading across edition/export
            window.$exeLibs = window.$exeLibs || {};

            // If already loading (from export or previous call), wait for it
            if (window.$exeLibs.modelViewerPromise) {
                return window.$exeLibs.modelViewerPromise;
            }

            // Check for existing script tag
            const existing = document.querySelector('script[data-threedviewer-lib]');
            if (existing) {
                if (window.customElements?.whenDefined) {
                    window.$exeLibs.modelViewerPromise = window.customElements
                        .whenDefined('model-viewer')
                        .catch(() => {});
                    return window.$exeLibs.modelViewerPromise;
                }
                return Promise.resolve();
            }

            const url = this.getModelViewerLibUrl();
            window.$exeLibs.modelViewerPromise = new Promise((resolve) => {
                // Re-check in case of race condition
                if (window.customElements?.get?.('model-viewer')) {
                    resolve();
                    return;
                }

                const script = document.createElement('script');
                script.src = url;
                script.dataset.threedviewerLib = 'edition';
                script.addEventListener('load', () => {
                    if (window.customElements?.whenDefined) {
                        window.customElements.whenDefined('model-viewer').then(resolve).catch(resolve);
                    } else {
                        resolve();
                    }
                });
                script.addEventListener('error', (event) => {
                    console.error('[3D Viewer] Unable to load model-viewer library', event);
                    resolve();
                });
                document.head.appendChild(script);
            });
            return window.$exeLibs.modelViewerPromise;
        },

        getModelViewerLibUrl: function () {
            const libPath = 'files/perm/idevices/base/three-d-viewer/export/model-viewer.min.js';
            // In static mode, use relative path to avoid basePath duplication
            // The browser resolves './files/...' relative to the current document, which is correct
            if (this.isStaticMode()) {
                return './' + libPath;
            }
            return this.resolveAssetUrl(libPath);
        },

        getOdeSessionId: function () {
            const raw = window.eXeLearning?.app?.project?.odeSession;
            return typeof raw === 'string' ? raw.trim() : '';
        },
    };
})();
