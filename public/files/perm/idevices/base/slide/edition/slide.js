/**
 * Slide iDevice — edition bridge for the Fabric.js editor.
 *
 * Loads the pre-built Fabric editor bundle (slide-editor.bundle.js) and
 * implements the $exeDevice.init/save contract expected by eXeLearning.
 *
 * Vanilla DOM. No jQuery. No React. No tldraw.
 *
 * Released under Attribution-ShareAlike 4.0 International License.
 * Author: eXeLearning - https://exelearning.net
 * License: https://creativecommons.org/licenses/by-sa/4.0/
 */

/* global _ */
/* eslint-disable no-undef */

(() => {
    var BUNDLE_GLOBAL = '__slideEditorInit';
    var BUNDLE_FILE = 'slide-editor.bundle.js';
    var DEFAULT_WIDTH = 1280;
    var DEFAULT_HEIGHT = 720;
    var MIN_W = 400,
        MAX_W = 1920;
    var MIN_H = 200,
        MAX_H = 1200;

    /**
     * Load the editor bundle once and reuse the in-flight Promise.
     *
     * @param {string} idevicePath  URL path to the iDevice edition folder
     * @returns {Promise<void>}
     */
    function loadBundle(idevicePath) {
        if (window[BUNDLE_GLOBAL]) {
            return Promise.resolve();
        }
        if (window.__slideBundlePromise) {
            return window.__slideBundlePromise;
        }

        window.__slideBundlePromise = new Promise((resolve, reject) => {
            var script = document.createElement('script');
            script.type = 'text/javascript';
            script.src = idevicePath + BUNDLE_FILE;
            script.onload = resolve;
            script.onerror = err => {
                delete window.__slideBundlePromise;
                reject(err);
            };
            document.head.appendChild(script);
        });

        return window.__slideBundlePromise;
    }

    function clamp(v, min, max, fallback) {
        var n = parseInt(v, 10);
        if (!isFinite(n)) {
            return fallback;
        }
        return Math.min(Math.max(n, min), max);
    }

    window.$exeDevice = {
        _editorApi: null,
        _ideviceId: null,
        _widthInput: null,
        _heightInput: null,
        _previousData: null,

        /**
         * Called by eXeLearning when the iDevice is opened for editing.
         *
         * @param {HTMLElement} element       Container element
         * @param {*}           previousData  Previously saved JSON (or null)
         * @param {string}      path          URL path to the iDevice edition folder
         */
        init: function (element, previousData, path) {
            this._editorApi = null;
            this._widthInput = null;
            this._heightInput = null;
            this._previousData = previousData;
            this._ideviceId = element.getAttribute('idevice-id');

            // Parse saved dimensions
            var prev = previousData;
            if (typeof prev === 'string') {
                try {
                    prev = JSON.parse(prev);
                } catch (e) {
                    prev = {};
                }
            }
            if (!prev || typeof prev !== 'object') {
                prev = {};
            }
            var cfgWidth = clamp(prev.width, MIN_W, MAX_W, DEFAULT_WIDTH);
            var cfgHeight = clamp(prev.height, MIN_H, MAX_H, DEFAULT_HEIGHT);

            element.innerHTML = '';

            // ── Config panel ──
            var configPanel = document.createElement('div');
            configPanel.className = 'slide-config-panel';
            configPanel.innerHTML =
                '<label>' +
                _('Width') +
                ': <input type="number" class="slide-cfg-width" min="' +
                MIN_W +
                '" max="' +
                MAX_W +
                '" step="10" value="' +
                cfgWidth +
                '"> px</label>' +
                '<label>' +
                _('Height') +
                ': <input type="number" class="slide-cfg-height" min="' +
                MIN_H +
                '" max="' +
                MAX_H +
                '" step="10" value="' +
                cfgHeight +
                '"> px</label>';
            element.appendChild(configPanel);

            this._widthInput = configPanel.querySelector('.slide-cfg-width');
            this._heightInput = configPanel.querySelector('.slide-cfg-height');

            // ── Editor host ──
            var host = document.createElement('div');
            host.className = 'slide-editor-fabric-host';
            element.appendChild(host);

            var loadingEl = document.createElement('div');
            loadingEl.className = 'slide-loading';
            loadingEl.textContent = _('Loading editor…');
            host.appendChild(loadingEl);

            loadBundle(path)
                .then(() => {
                    host.innerHTML = '';
                    var wrapper = document.createElement('div');
                    wrapper.className = 'slide-editor-mount';
                    host.appendChild(wrapper);

                    this._editorApi = window[BUNDLE_GLOBAL].mount(wrapper, {
                        previousData: previousData,
                    });
                })
                .catch(() => {
                    host.innerHTML = '';
                    var errEl = document.createElement('p');
                    errEl.className = 'slide-error';
                    errEl.textContent = _('Could not load the slide editor. Please reload the page.');
                    host.appendChild(errEl);
                });
        },

        /**
         * Called by eXeLearning when saving the iDevice. Returns version-3
         * payload: editable Fabric scene + sanitized SVG snapshot.
         *
         * @returns {{ ideviceId: string, version: 3, engine: 'fabric',
         *            width: number, height: number,
         *            fabric: object, svg: string } | null}
         */
        save: function () {
            if (!this._editorApi) {
                return null;
            }

            var width = clamp(this._widthInput && this._widthInput.value, MIN_W, MAX_W, DEFAULT_WIDTH);
            var height = clamp(this._heightInput && this._heightInput.value, MIN_H, MAX_H, DEFAULT_HEIGHT);

            return {
                ideviceId: this._ideviceId,
                version: 3,
                engine: 'fabric',
                width: width,
                height: height,
                fabric: this._editorApi.getFabricJSON(),
                svg: this._editorApi.getSvgString(),
            };
        },
    };
})();
