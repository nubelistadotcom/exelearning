/**
 * Unit tests for three-d-viewer iDevice (export)
 *
 * Tests the path resolution functions used in export/preview contexts:
 * - detectMode: Detects current execution environment (static, server, export, preview)
 * - getModelViewerLibUrl: Returns URL for model-viewer library based on mode
 * - getThreeJSBaseUrl: Returns base URL for Three.js modules with absolute URLs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load the export iDevice file and return the $threedviewer object.
 * The export script uses an IIFE that attaches to globalScope.$threedviewer.
 */
function loadExportIdevice(code) {
    // Execute the IIFE in global context
    // eslint-disable-next-line no-eval
    (0, eval)(code);
    return global.$threedviewer;
}

describe('three-d-viewer iDevice (export)', () => {
    let $threedviewer;
    let originalGlobals;

    beforeEach(() => {
        // Save original global state
        originalGlobals = {
            eXeLearning: global.eXeLearning,
            location: global.location,
            document: global.document,
            $threedviewer: global.$threedviewer,
            $exeLibs: global.$exeLibs,
        };

        // Reset globals
        global.$threedviewer = undefined;
        global.$exeLibs = undefined;

        // Mock window.location
        global.location = {
            origin: 'http://localhost:8080',
            protocol: 'http:',
            host: 'localhost:8080',
            href: 'http://localhost:8080/viewer/index.html',
        };

        // Mock minimal eXeLearning structure
        global.eXeLearning = {
            config: null,
            symfony: {},
            app: {
                project: {},
            },
        };

        // Mock minimal document
        global.document = {
            documentElement: { id: '' },
            createElement: (tag) => ({
                tagName: tag.toUpperCase(),
                setAttribute: () => {},
                getAttribute: () => null,
                removeAttribute: () => {},
                style: {},
                addEventListener: () => {},
            }),
            head: { appendChild: () => {} },
            querySelector: () => null,
        };

        // Mock customElements
        global.customElements = {
            get: () => undefined,
            whenDefined: () => Promise.resolve(),
        };

        // Mock _ function for translations
        global._ = (s) => s;

        // Read and execute the iDevice file
        const filePath = join(__dirname, 'three-d-viewer.js');
        const code = readFileSync(filePath, 'utf-8');

        // Load iDevice and get reference
        $threedviewer = loadExportIdevice(code);
    });

    afterEach(() => {
        // Restore original global state
        global.eXeLearning = originalGlobals.eXeLearning;
        global.location = originalGlobals.location;
        global.document = originalGlobals.document;
        global.$threedviewer = originalGlobals.$threedviewer;
        global.$exeLibs = originalGlobals.$exeLibs;
    });

    describe('$threedviewer object', () => {
        it('is defined', () => {
            expect($threedviewer).toBeDefined();
        });

        it('has renderView function', () => {
            expect(typeof $threedviewer.renderView).toBe('function');
        });

        it('has renderBehaviour function', () => {
            expect(typeof $threedviewer.renderBehaviour).toBe('function');
        });

        it('has init function', () => {
            expect(typeof $threedviewer.init).toBe('function');
        });

        it('exposes getModelViewerLibUrl for debugging', () => {
            expect(typeof $threedviewer.getModelViewerLibUrl).toBe('function');
        });
    });

    describe('getModelViewerLibUrl', () => {
        const modelViewerFile = 'model-viewer.min.js';

        describe('static mode', () => {
            beforeEach(() => {
                global.eXeLearning.config = { isStaticMode: true };
            });

            it('returns relative path for static mode', () => {
                const url = $threedviewer.getModelViewerLibUrl();

                expect(url).toBe(`./files/perm/idevices/base/three-d-viewer/export/${modelViewerFile}`);
            });

            it('also triggers for isOfflineInstallation', () => {
                global.eXeLearning.config = { isOfflineInstallation: true };

                const url = $threedviewer.getModelViewerLibUrl();

                expect(url).toBe(`./files/perm/idevices/base/three-d-viewer/export/${modelViewerFile}`);
            });
        });

        describe('server mode', () => {
            it('returns resolved URL for server mode', () => {
                global.eXeLearning.config = { baseURL: 'https://example.com' };
                global.eXeLearning.symfony = { baseURL: 'https://example.com', basePath: '' };

                const url = $threedviewer.getModelViewerLibUrl();

                expect(url).toContain('files/perm/idevices/base/three-d-viewer/export/' + modelViewerFile);
            });

            it('includes basePath in resolved URL', () => {
                global.eXeLearning.config = { baseURL: 'https://example.com', basePath: 'myapp' };
                global.eXeLearning.symfony = { baseURL: 'https://example.com', basePath: 'myapp' };

                const url = $threedviewer.getModelViewerLibUrl();

                expect(url).toContain('myapp');
                expect(url).toContain(modelViewerFile);
            });
        });

        describe('export mode', () => {
            beforeEach(() => {
                // No config = not static or server mode
                global.eXeLearning.config = null;
            });

            it('returns ./idevices/ path on index page', () => {
                global.document.documentElement.id = 'exe-index';

                const url = $threedviewer.getModelViewerLibUrl();

                expect(url).toBe(`./idevices/three-d-viewer/${modelViewerFile}`);
            });

            it('returns ../idevices/ path on subpage', () => {
                global.document.documentElement.id = 'exe-page1';
                global.document.querySelector = (selector) => {
                    if (selector === 'html[id^="exe-"]') {
                        return { id: 'exe-page1' };
                    }
                    return null;
                };

                const url = $threedviewer.getModelViewerLibUrl();

                expect(url).toBe(`../idevices/three-d-viewer/${modelViewerFile}`);
            });
        });

        describe('fallback mode', () => {
            it('uses symfony config when no mode detected', () => {
                global.eXeLearning.config = null;
                global.document.documentElement.id = '';
                global.eXeLearning.symfony = { baseURL: 'https://fallback.com', basePath: '' };

                const url = $threedviewer.getModelViewerLibUrl();

                expect(url).toContain('https://fallback.com');
                expect(url).toContain(modelViewerFile);
            });
        });
    });

    describe('renderView', () => {
        it('returns HTML with model-viewer element', () => {
            const data = {
                src: 'model.glb',
                alt: 'Test model',
                backgroundColor: '#ffffff',
            };

            const html = $threedviewer.renderView(data, {}, '{content}');

            expect(html).toContain('model-viewer');
            expect(html).toContain('three-d-viewer-wrapper');
        });

        it('omits fullscreen + nav controls when showNavControls is false (default)', () => {
            const html = $threedviewer.renderView({ src: 'model.glb' }, {}, '{content}');

            expect(html).not.toContain('three-d-viewer-fullscreen-button');
            expect(html).not.toContain('data-nav="left"');
        });

        it('renders fullscreen + 4-direction nav pad when showNavControls is true', () => {
            const html = $threedviewer.renderView(
                { src: 'model.glb', showNavControls: true },
                {},
                '{content}',
            );

            expect(html).toContain('three-d-viewer-fullscreen-button');
            expect(html).toContain('data-fullscreen');
            expect(html).toContain('data-nav="left"');
            expect(html).toContain('data-nav="right"');
            expect(html).toContain('data-nav="up"');
            expect(html).toContain('data-nav="down"');
        });

        it('disables auto-rotate automatically when showNavControls is true', () => {
            const html = $threedviewer.renderView(
                { src: 'model.glb', showNavControls: true, autoRotate: true },
                {},
                '{content}',
            );

            expect(html).not.toContain('auto-rotate');
        });

        it('includes alt text in aria-label', () => {
            const data = {
                src: 'model.glb',
                alt: 'A 3D cube',
            };

            const html = $threedviewer.renderView(data, {}, '{content}');

            expect(html).toContain('aria-label="A 3D cube"');
        });

        it('includes camera-controls by default', () => {
            const data = { src: 'model.glb' };

            const html = $threedviewer.renderView(data, {}, '{content}');

            expect(html).toContain('camera-controls');
        });

        it('excludes camera-controls when disabled', () => {
            const data = {
                src: 'model.glb',
                cameraControls: false,
            };

            const html = $threedviewer.renderView(data, {}, '{content}');

            expect(html).not.toContain('camera-controls');
        });

        it('includes auto-rotate by default', () => {
            const data = { src: 'model.glb' };

            const html = $threedviewer.renderView(data, {}, '{content}');

            expect(html).toContain('auto-rotate');
        });

        it('includes rotation speed', () => {
            const data = {
                src: 'model.glb',
                autoRotate: true,
                autoRotateSpeed: 45,
            };

            const html = $threedviewer.renderView(data, {}, '{content}');

            expect(html).toContain('rotation-per-second="45deg"');
        });

        it('sets background color style', () => {
            const data = {
                src: 'model.glb',
                backgroundColor: '#ff0000',
            };

            const html = $threedviewer.renderView(data, {}, '{content}');

            expect(html).toContain('background-color: #ff0000');
        });

        it('encodes config as base64 in data-config attribute', () => {
            const data = {
                src: 'model.glb',
                ideviceId: 'test-id',
            };

            const html = $threedviewer.renderView(data, {}, '{content}');

            expect(html).toContain('data-config="');
            // Config is base64 encoded, should not contain raw JSON brackets
            expect(html).not.toMatch(/data-config="\{/);
        });

        it('handles empty data gracefully', () => {
            const html = $threedviewer.renderView({}, {}, '{content}');

            expect(html).toContain('model-viewer');
            expect(html).toContain('three-d-viewer-wrapper');
        });

        it('handles null data', () => {
            const html = $threedviewer.renderView(null, {}, '{content}');

            expect(html).toContain('model-viewer');
        });
    });

    describe('ThreeDViewerExportObject', () => {
        it('is defined globally', () => {
            expect(global.ThreeDViewerExportObject).toBeDefined();
        });

        it('has init method', () => {
            const helper = new global.ThreeDViewerExportObject();
            expect(typeof helper.init).toBe('function');
        });

        it('has toJSON method', () => {
            const helper = new global.ThreeDViewerExportObject();
            expect(typeof helper.toJSON).toBe('function');
        });

        it('has fromJSON method', () => {
            const helper = new global.ThreeDViewerExportObject();
            expect(typeof helper.fromJSON).toBe('function');
        });

        it('init returns true', () => {
            const helper = new global.ThreeDViewerExportObject();
            expect(helper.init({}, null)).toBe(true);
        });

        it('toJSON returns empty object when no node', () => {
            const helper = new global.ThreeDViewerExportObject();
            helper.init(null, null);
            expect(helper.toJSON()).toEqual({});
        });
    });

    describe('isSTLFile detection', () => {
        it('renderView processes STL files', () => {
            const data = {
                src: 'model.stl',
                alt: 'STL model',
            };

            // Should not throw, STL handling is done at runtime
            const html = $threedviewer.renderView(data, {}, '{content}');
            expect(html).toContain('model-viewer');
        });
    });

    describe('asset:// URL handling', () => {
        it('renderView accepts asset:// URLs', () => {
            const data = {
                src: 'asset://uuid-123/model.glb',
                alt: 'Asset model',
            };

            const html = $threedviewer.renderView(data, {}, '{content}');
            expect(html).toContain('model-viewer');
        });
    });
});

/**
 * Tests for internal helper functions (accessed via module internals)
 * These test the mode detection and URL resolution logic indirectly
 * through the public API.
 */
describe('three-d-viewer mode detection (integration)', () => {
    let originalGlobals;

    beforeEach(() => {
        originalGlobals = {
            eXeLearning: global.eXeLearning,
            location: global.location,
            document: global.document,
            $threedviewer: global.$threedviewer,
            $exeLibs: global.$exeLibs,
        };

        global.$threedviewer = undefined;
        global.$exeLibs = undefined;

        global.location = {
            origin: 'http://localhost:8080',
            protocol: 'http:',
            host: 'localhost:8080',
            href: 'http://localhost:8080/export/index.html',
        };

        global.eXeLearning = {
            config: null,
            symfony: {},
            app: { project: {} },
        };

        global.document = {
            documentElement: { id: '' },
            createElement: () => ({ setAttribute: () => {}, style: {}, addEventListener: () => {} }),
            head: { appendChild: () => {} },
            querySelector: () => null,
        };

        global.customElements = { get: () => undefined, whenDefined: () => Promise.resolve() };
        global._ = (s) => s;
    });

    afterEach(() => {
        global.eXeLearning = originalGlobals.eXeLearning;
        global.location = originalGlobals.location;
        global.document = originalGlobals.document;
        global.$threedviewer = originalGlobals.$threedviewer;
        global.$exeLibs = originalGlobals.$exeLibs;
    });

    function loadAndGetUrl() {
        const filePath = join(__dirname, 'three-d-viewer.js');
        const code = readFileSync(filePath, 'utf-8');
        // eslint-disable-next-line no-eval
        (0, eval)(code);
        return global.$threedviewer.getModelViewerLibUrl();
    }

    it('detects static mode via isStaticMode config', () => {
        global.eXeLearning.config = { isStaticMode: true };

        const url = loadAndGetUrl();

        expect(url).toMatch(/^\.\//);
    });

    it('detects static mode via isOfflineInstallation config', () => {
        global.eXeLearning.config = { isOfflineInstallation: true };

        const url = loadAndGetUrl();

        expect(url).toMatch(/^\.\//);
    });

    it('detects static mode from JSON string config', () => {
        global.eXeLearning.config = JSON.stringify({ isStaticMode: true });

        const url = loadAndGetUrl();

        expect(url).toMatch(/^\.\//);
    });

    it('detects server mode when baseURL is defined', () => {
        global.eXeLearning.config = { baseURL: 'https://server.com' };
        global.eXeLearning.symfony = { baseURL: 'https://server.com' };

        const url = loadAndGetUrl();

        expect(url).toContain('server.com');
    });

    it('detects export mode on index page via html id', () => {
        global.eXeLearning.config = null;
        global.document.documentElement.id = 'exe-index';

        const url = loadAndGetUrl();

        expect(url).toBe('./idevices/three-d-viewer/model-viewer.min.js');
    });

    it('detects export mode on subpage via html id', () => {
        global.eXeLearning.config = null;
        global.document.documentElement.id = 'exe-page-abc';
        global.document.querySelector = (sel) => {
            if (sel === 'html[id^="exe-"]') return { id: 'exe-page-abc' };
            return null;
        };

        const url = loadAndGetUrl();

        expect(url).toBe('../idevices/three-d-viewer/model-viewer.min.js');
    });
});
