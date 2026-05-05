/**
 * Slide iDevice — Fabric.js editor bundle entry.
 *
 * Vanilla TypeScript. No React, no JSX, no tldraw.
 * Built by Bun as an IIFE; exposes window.__slideEditorInit.mount(container, opts).
 *
 * The mounted editor returns an API used by edition/slide.js:
 *   - getFabricJSON(): returns the editable Fabric scene JSON
 *   - getSvgString(): returns a sanitized SVG snapshot for static export/preview
 *   - getDimensions(): returns the configured canvas size
 *   - destroy(): tears down listeners and Fabric resources
 *
 * Released under Attribution-ShareAlike 4.0 International License.
 * Author: eXeLearning - https://exelearning.net
 *
 * Third-party libraries bundled into this file:
 *   - fabric.js   (MIT)                       https://github.com/fabricjs/fabric.js
 *   - DOMPurify   (MPL 2.0 OR Apache 2.0)     https://github.com/cure53/DOMPurify
 *
 * Why DOMPurify is added as a bundle dep even though the project already
 * vendors a copy under public/app/common/edicuatex/js/DOMPurify/: that copy
 * is a global-script drop-in for a different iDevice. This bundle is a
 * self-contained IIFE built by Bun, so we rely on a real npm dependency
 * Bun can inline. No new runtime is shipped to the page — DOMPurify is
 * minified into slide-editor.bundle.js together with fabric.
 */

import * as fabric from 'fabric';
import DOMPurify from 'dompurify';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_BG = '#ffffff';
const DATA_VERSION = 3;
const ENGINE_NAME = 'fabric';

const MIN_W = 400;
const MAX_W = 1920;
const MIN_H = 200;
const MAX_H = 1200;

// ── Types ────────────────────────────────────────────────────────────────────

type AnyObj = Record<string, unknown>;

interface MountOptions {
    previousData?: unknown;
}

interface EditorAPI {
    getFabricJSON(): AnyObj;
    getSvgString(): string;
    getDimensions(): { width: number; height: number };
    destroy(): void;
}

interface Parsed {
    width: number;
    height: number;
    background: string;
    fabric: AnyObj | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(v, min), max);
}

function isHexColor(v: unknown): v is string {
    return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
}

/**
 * Parse the previous saved payload into an editor-ready shape.
 * Accepts JSON strings, plain objects, null, or unknown shapes.
 * Falls back to a clean blank slide for anything we cannot recognise as v3.
 */
export function parsePrevious(raw: unknown): Parsed {
    let parsed: AnyObj | null = null;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw) as AnyObj;
        } catch {
            parsed = null;
        }
    } else if (raw && typeof raw === 'object') {
        parsed = raw as AnyObj;
    }
    const blank: Parsed = {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        background: DEFAULT_BG,
        fabric: null,
    };
    if (!parsed) return blank;

    const width = clamp(Number(parsed.width) || DEFAULT_WIDTH, MIN_W, MAX_W);
    const height = clamp(Number(parsed.height) || DEFAULT_HEIGHT, MIN_H, MAX_H);
    const background = isHexColor(parsed.background) ? parsed.background : DEFAULT_BG;

    let fabricJSON: AnyObj | null = null;
    if (
        parsed.version === DATA_VERSION &&
        parsed.engine === ENGINE_NAME &&
        parsed.fabric &&
        typeof parsed.fabric === 'object'
    ) {
        fabricJSON = parsed.fabric as AnyObj;
    }
    return { width, height, background, fabric: fabricJSON };
}

/**
 * Sanitize an SVG string using DOMPurify's SVG profile.
 * Strips <script>, event handlers, javascript: URLs.
 * Returns '' on empty input rather than throwing.
 */
export function sanitizeSvg(svg: string): string {
    if (!svg || typeof svg !== 'string') return '';
    const cleaned = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
    }) as unknown as string;
    return cleaned || '';
}

function readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// ── Editor ───────────────────────────────────────────────────────────────────

class SlideFabricEditor {
    private root: HTMLElement;
    private wrapper!: HTMLElement;
    private toolbarEl!: HTMLElement;
    private canvasEl!: HTMLCanvasElement;
    private fileInput!: HTMLInputElement;
    private canvas!: fabric.Canvas;
    private parsed: Parsed;
    private cleanupFns: Array<() => void> = [];
    private resizeObserver: ResizeObserver | null = null;

    constructor(container: HTMLElement, options: MountOptions = {}) {
        this.root = container;
        this.root.classList.add('slide-fabric-root');
        this.parsed = parsePrevious(options.previousData);
        this.buildDom();
        this.initFabric();
    }

    // ── DOM scaffolding ──

    private buildDom(): void {
        this.toolbarEl = this.buildToolbar();

        this.wrapper = document.createElement('div');
        this.wrapper.className = 'slide-fabric-canvas-wrapper';

        this.canvasEl = document.createElement('canvas');
        this.canvasEl.className = 'slide-fabric-canvas';
        this.canvasEl.width = this.parsed.width;
        this.canvasEl.height = this.parsed.height;
        this.wrapper.appendChild(this.canvasEl);

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = 'image/*';
        this.fileInput.style.display = 'none';

        this.root.appendChild(this.toolbarEl);
        this.root.appendChild(this.wrapper);
        this.root.appendChild(this.fileInput);

        const onPick = async () => {
            const f = this.fileInput.files?.[0];
            this.fileInput.value = '';
            if (f) await this.addImageFile(f);
        };
        this.fileInput.addEventListener('change', onPick);
        this.cleanupFns.push(() => this.fileInput.removeEventListener('change', onPick));
    }

    private buildToolbar(): HTMLElement {
        const t = document.createElement('div');
        t.className = 'slide-fabric-toolbar';

        const buttons: Array<{ key: string; label: string; title: string; act: () => void }> = [
            { key: 'text', label: 'T', title: 'Add text', act: () => this.addText() },
            { key: 'rect', label: '▭', title: 'Add rectangle', act: () => this.addRectangle() },
            { key: 'circ', label: '◯', title: 'Add circle', act: () => this.addCircle() },
            { key: 'line', label: '╱', title: 'Add line', act: () => this.addLine() },
            { key: 'img', label: '🖼', title: 'Add image', act: () => this.fileInput.click() },
            { key: 'del', label: '🗑', title: 'Delete', act: () => this.deleteSelected() },
        ];
        buttons.forEach(b => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'slide-fabric-tool slide-fabric-tool--' + b.key;
            btn.textContent = b.label;
            btn.title = b.title;
            btn.setAttribute('aria-label', b.title);
            const onClick = () => b.act();
            btn.addEventListener('click', onClick);
            this.cleanupFns.push(() => btn.removeEventListener('click', onClick));
            t.appendChild(btn);
        });

        t.appendChild(this.buildColorInput('fill', '#3b82f6', 'Fill color', c => this.applyFill(c)));
        t.appendChild(this.buildColorInput('stroke', '#1f2937', 'Stroke color', c => this.applyStroke(c)));
        return t;
    }

    private buildColorInput(
        kind: string,
        defaultValue: string,
        title: string,
        onChange: (v: string) => void,
    ): HTMLLabelElement {
        const label = document.createElement('label');
        label.className = 'slide-fabric-color-label';
        label.title = title;
        const input = document.createElement('input');
        input.type = 'color';
        input.value = defaultValue;
        input.className = 'slide-fabric-color slide-fabric-color--' + kind;
        input.setAttribute('aria-label', title);
        const handler = () => onChange(input.value);
        input.addEventListener('input', handler);
        this.cleanupFns.push(() => input.removeEventListener('input', handler));
        label.appendChild(input);
        return label;
    }

    // ── Fabric init ──

    private initFabric(): void {
        this.canvas = new fabric.Canvas(this.canvasEl, {
            backgroundColor: this.parsed.background,
            preserveObjectStacking: true,
            selection: true,
        });

        if (this.parsed.fabric) {
            this.canvas
                .loadFromJSON(this.parsed.fabric)
                .then(() => this.canvas.requestRenderAll())
                .catch(() => {
                    /* corrupt JSON: keep blank canvas */
                });
        }

        this.fitCanvasToWrapper();
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.fitCanvasToWrapper());
            this.resizeObserver.observe(this.wrapper);
        }

        const onKey = (e: KeyboardEvent) => {
            if (!this.root.contains(document.activeElement) && document.activeElement !== document.body) return;
            const tag = (document.activeElement as HTMLElement | null)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            const active = this.canvas.getActiveObject() as AnyObj | null;
            if (active && active.isEditing) return;
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                this.deleteSelected();
            }
        };
        document.addEventListener('keydown', onKey);
        this.cleanupFns.push(() => document.removeEventListener('keydown', onKey));
    }

    private fitCanvasToWrapper(): void {
        const designW = this.parsed.width;
        const designH = this.parsed.height;
        const wrapW = this.wrapper.clientWidth || designW;
        const scale = Math.min(1, wrapW / designW);
        this.canvas.setDimensions({ width: designW * scale, height: designH * scale });
        this.canvas.setZoom(scale);
        this.canvas.requestRenderAll();
    }

    // ── Tools ──

    private async addImageFile(file: File): Promise<void> {
        const dataUrl = await readFileAsDataURL(file);
        const img = await fabric.FabricImage.fromURL(dataUrl);
        const designW = this.parsed.width;
        const maxW = designW * 0.5;
        const w = Number(img.width) || 0;
        const scale = w > maxW ? maxW / w : 1;
        img.set({ left: 40, top: 40, scaleX: scale, scaleY: scale });
        this.canvas.add(img);
        this.canvas.setActiveObject(img);
        this.canvas.requestRenderAll();
    }

    addText(text = 'Text'): void {
        const t = new fabric.IText(text, {
            left: 40,
            top: 40,
            fontFamily: 'Inter, Arial, sans-serif',
            fontSize: 32,
            fill: '#111827',
        });
        this.canvas.add(t);
        this.canvas.setActiveObject(t);
        this.canvas.requestRenderAll();
    }

    addRectangle(): void {
        const r = new fabric.Rect({
            left: 40,
            top: 40,
            width: 240,
            height: 140,
            fill: '#3b82f6',
            stroke: '#1f2937',
            strokeWidth: 0,
        });
        this.canvas.add(r);
        this.canvas.setActiveObject(r);
        this.canvas.requestRenderAll();
    }

    addCircle(): void {
        const c = new fabric.Circle({
            left: 40,
            top: 40,
            radius: 80,
            fill: '#10b981',
            stroke: '#1f2937',
            strokeWidth: 0,
        });
        this.canvas.add(c);
        this.canvas.setActiveObject(c);
        this.canvas.requestRenderAll();
    }

    addLine(): void {
        const l = new fabric.Line([40, 40, 240, 40], {
            stroke: '#1f2937',
            strokeWidth: 4,
        });
        this.canvas.add(l);
        this.canvas.setActiveObject(l);
        this.canvas.requestRenderAll();
    }

    deleteSelected(): void {
        const objs = this.canvas.getActiveObjects();
        if (!objs.length) return;
        objs.forEach(o => this.canvas.remove(o));
        this.canvas.discardActiveObject();
        this.canvas.requestRenderAll();
    }

    applyFill(color: string): void {
        if (!isHexColor(color)) return;
        const objs = this.canvas.getActiveObjects();
        objs.forEach(o => {
            // Lines have no fill
            if ((o as AnyObj).type === 'line') return;
            o.set({ fill: color });
        });
        this.canvas.requestRenderAll();
    }

    applyStroke(color: string): void {
        if (!isHexColor(color)) return;
        const objs = this.canvas.getActiveObjects();
        objs.forEach(o => {
            const sw = Number((o as AnyObj).strokeWidth) || 0;
            if (sw === 0 && (o as AnyObj).type !== 'line') {
                o.set({ stroke: color, strokeWidth: 2 });
            } else {
                o.set({ stroke: color });
            }
        });
        this.canvas.requestRenderAll();
    }

    // ── Public API ──

    getFabricJSON(): AnyObj {
        return this.canvas.toJSON() as unknown as AnyObj;
    }

    getSvgString(): string {
        const w = this.parsed.width;
        const h = this.parsed.height;
        const svg = this.canvas.toSVG({
            viewBox: { x: 0, y: 0, width: w, height: h },
            width: String(w),
            height: String(h),
        } as Parameters<fabric.Canvas['toSVG']>[0]);
        return sanitizeSvg(svg);
    }

    getDimensions(): { width: number; height: number } {
        return { width: this.parsed.width, height: this.parsed.height };
    }

    destroy(): void {
        try {
            this.canvas.dispose();
        } catch {
            /* ignore */
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        this.cleanupFns.forEach(fn => {
            try {
                fn();
            } catch {
                /* ignore */
            }
        });
        this.cleanupFns = [];
        while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
        this.root.classList.remove('slide-fabric-root');
    }
}

// ── Bundle entry point ───────────────────────────────────────────────────────

export function mount(container: HTMLElement, options: MountOptions = {}): EditorAPI {
    const editor = new SlideFabricEditor(container, options);
    return {
        getFabricJSON: () => editor.getFabricJSON(),
        getSvgString: () => editor.getSvgString(),
        getDimensions: () => editor.getDimensions(),
        destroy: () => editor.destroy(),
    };
}

export { SlideFabricEditor };
