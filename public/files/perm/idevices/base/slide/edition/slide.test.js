/**
 * Tests for the Slide iDevice edition bridge (slide.js).
 *
 * The bridge is an IIFE that assigns window.$exeDevice and dynamically
 * loads slide-editor.bundle.js (the Fabric.js editor). Tests mock the
 * bundle global so no real fabric/dompurify is needed.
 */

/* eslint-disable no-undef */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildContainerMock() {
    const attrs = { 'idevice-id': 'test-idevice-id' };
    const children = [];
    const obj = {
        classList: { add: vi.fn() },
        getAttribute: attr => attrs[attr] || null,
        _children: children,
        appendChild: vi.fn(function (child) {
            children.push(child);
        }),
        removeChild: vi.fn(function (child) {
            const i = children.indexOf(child);
            if (i !== -1) children.splice(i, 1);
        }),
        contains: vi.fn(function (child) {
            return children.includes(child);
        }),
    };
    Object.defineProperty(obj, 'innerHTML', {
        set(v) {
            if (v === '') children.splice(0, children.length);
        },
        get() {
            return '';
        },
    });
    return obj;
}

function buildMockEditorApi() {
    return {
        getFabricJSON: vi.fn(() => ({
            version: '6.0.0',
            objects: [{ type: 'rect', left: 10, top: 10, width: 100, height: 50 }],
        })),
        getSvgString: vi.fn(() => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>'),
        getDimensions: vi.fn(() => ({ width: 1280, height: 720 })),
        destroy: vi.fn(),
    };
}

// ── Module setup ─────────────────────────────────────────────────────────────

let container;
let $exeDevice;

beforeEach(async () => {
    delete global.window.__slideBundlePromise;
    delete global.window.$exeDevice;
    delete global.window.__slideEditorInit;

    global.window._ = k => k;

    const code = await import('./slide.js?raw').then(m => m.default);
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', code)(global.window, global.document);

    $exeDevice = global.window.$exeDevice;
    container = buildContainerMock();
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('$exeDevice public API', () => {
    it('exposes init and save methods', () => {
        expect(typeof $exeDevice.init).toBe('function');
        expect(typeof $exeDevice.save).toBe('function');
    });

    it('init returns undefined (async, no return value)', () => {
        global.window.__slideEditorInit = { mount: vi.fn(() => buildMockEditorApi()) };
        const result = $exeDevice.init(container, null, '/path/');
        expect(result).toBeUndefined();
    });

    it('save returns null when editor not yet ready', () => {
        expect($exeDevice.save()).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('loadBundle', () => {
    it('uses existing __slideEditorInit when already on window', async () => {
        const mockApi = buildMockEditorApi();
        global.window.__slideEditorInit = { mount: vi.fn(() => mockApi) };

        $exeDevice.init(container, null, '/path/');
        await new Promise(r => setTimeout(r, 0));

        expect(global.window.__slideEditorInit.mount).toHaveBeenCalled();
    });

    it('shows error message when bundle fails to load', async () => {
        delete global.window.__slideEditorInit;

        const createElement = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation(tag => {
            if (tag === 'script') {
                const script = { onload: null, onerror: null, type: '', src: '' };
                setTimeout(() => script.onerror && script.onerror(new Error('404')), 0);
                return script;
            }
            return createElement(tag);
        });
        vi.spyOn(document.head, 'appendChild').mockImplementation(() => {});

        $exeDevice.init(container, null, '/bad/path/');
        await new Promise(r => setTimeout(r, 50));

        const host = container._children.find(c => c.className === 'slide-editor-fabric-host');
        expect(host).toBeDefined();
        const errEl = host.querySelector('.slide-error');
        expect(errEl).toBeDefined();
        expect(errEl.textContent).toContain('Could not load');
    });

    it('reuses existing __slideBundlePromise for concurrent inits', async () => {
        delete global.window.__slideEditorInit;
        let resolveScript;

        const createElement = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation(tag => {
            if (tag === 'script') {
                const script = { onload: null, onerror: null, type: '', src: '' };
                resolveScript = () => {
                    global.window.__slideEditorInit = { mount: vi.fn(() => buildMockEditorApi()) };
                    script.onload && script.onload();
                };
                return script;
            }
            return createElement(tag);
        });
        const appendSpy = vi.spyOn(document.head, 'appendChild').mockImplementation(() => {});

        const c2 = buildContainerMock();
        $exeDevice.init(container, null, '/path/');
        $exeDevice.init(c2, null, '/path/');

        resolveScript();
        await new Promise(r => setTimeout(r, 0));

        expect(appendSpy).toHaveBeenCalledTimes(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('after init (with __slideEditorInit already loaded)', () => {
    let mockApi;

    async function initEditor(previousData) {
        mockApi = buildMockEditorApi();
        global.window.__slideEditorInit = { mount: vi.fn(() => mockApi) };
        $exeDevice.init(container, previousData, '/path/');
        await new Promise(r => setTimeout(r, 0));
    }

    it('save returns object with version 3, engine fabric, svg and fabric scene', async () => {
        await initEditor(null);
        const data = $exeDevice.save();
        expect(data).not.toBeNull();
        expect(data.version).toBe(3);
        expect(data.engine).toBe('fabric');
        expect(data.fabric).toBeDefined();
        expect(data.svg).toBeDefined();
    });

    it('save includes width and height with defaults when previousData is null', async () => {
        await initEditor(null);
        const data = $exeDevice.save();
        expect(data.width).toBe(1280);
        expect(data.height).toBe(720);
    });

    it('save restores width and height from previousData', async () => {
        await initEditor({ version: 3, engine: 'fabric', fabric: {}, svg: '', width: 800, height: 450 });
        const data = $exeDevice.save();
        expect(data.width).toBe(800);
        expect(data.height).toBe(450);
    });

    it('save includes ideviceId from container attribute', async () => {
        await initEditor(null);
        expect($exeDevice.save().ideviceId).toBe('test-idevice-id');
    });

    it('save returns svg string from editor API', async () => {
        await initEditor(null);
        expect($exeDevice.save().svg).toContain('<svg');
    });

    it('passes previousData to mount', async () => {
        const previousData = { version: 3, engine: 'fabric', fabric: {}, svg: '<svg/>' };
        await initEditor(previousData);
        expect(global.window.__slideEditorInit.mount).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ previousData }),
        );
    });

    it('removes loading indicator before mounting editor', async () => {
        await initEditor(null);
        const host = container._children.find(c => c.className === 'slide-editor-fabric-host');
        expect(host).toBeDefined();
        expect(host.querySelector('.slide-loading')).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('init with various previousData inputs', () => {
    async function initWithData(data) {
        const mockApi = buildMockEditorApi();
        global.window.__slideEditorInit = { mount: vi.fn(() => mockApi) };
        $exeDevice.init(container, data, '/path/');
        await new Promise(r => setTimeout(r, 0));
    }

    it('handles null previousData without errors', async () => {
        await expect(initWithData(null)).resolves.toBeUndefined();
    });

    it('handles undefined previousData without errors', async () => {
        await expect(initWithData(undefined)).resolves.toBeUndefined();
    });

    it('handles version 3 previousData (Fabric)', async () => {
        await expect(
            initWithData({ version: 3, engine: 'fabric', fabric: {}, svg: '<svg/>' }),
        ).resolves.toBeUndefined();
    });

    it('handles invalid JSON string without errors', async () => {
        await expect(initWithData('not-valid-json')).resolves.toBeUndefined();
    });
});
