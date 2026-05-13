/**
 * CanvasMotionLayer — ENGINE-10X §8.3 + §8.4.
 *
 * One absolute-positioned `<canvas>` overlaid on the React Flow wrapper plus
 * a CSS-variable driven "breathing" oscillator. Both effects:
 *   • run on a single `requestAnimationFrame` loop (no React renders)
 *   • read SVG edge geometry directly via `getPointAtLength` + `getScreenCTM`
 *   • are no-ops when `prefers-reduced-motion: reduce`
 *
 * Photons are spawned by `spawnPhotonsForCompletedNode(nodeId)`. The layer
 * walks every `[data-id^="<nodeId>"]` edge and any edge whose `target ===
 * nodeId`, then animates a 6px dot along the path for ~700ms.
 *
 * Breathing: when `setRunBreathing(true)` is called, the canvas root gets a
 * `--canvas-breath` CSS variable updated each frame between 0.96 and 1.04
 * (period 4s). Used by the ReactFlow background filter for a subtle pulse.
 */

const PHOTON_DURATION_MS = 700;
const PHOTON_RADIUS = 3.5;
const PHOTON_COLOR = 'rgba(125, 211, 252, 0.95)'; // cyan-300
const MAX_PHOTONS = 200;
const BREATH_PERIOD_MS = 4000;

interface Photon {
  pathEl: SVGPathElement;
  pathLength: number;
  startedAt: number;
  /** Cached so we never query during the rAF hot loop. */
  reverse: boolean;
}

export class CanvasMotionLayer {
  private host: HTMLElement | null = null;
  private canvasEl: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private photons: Photon[] = [];
  private raf = 0;
  private breathing = false;
  private prefersReducedMotion = false;
  private resizeObserver: ResizeObserver | null = null;

  attach(host: HTMLElement): void {
    if (typeof window === 'undefined') return;
    this.host = host;
    this.prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '5';
    host.appendChild(canvas);
    this.canvasEl = canvas;
    this.ctx2d = canvas.getContext('2d');

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);

    this.raf = requestAnimationFrame(this.loop);
  }

  detach(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvasEl?.remove();
    this.canvasEl = null;
    this.ctx2d = null;
    this.photons = [];
    this.host = null;
    if (this.host) (this.host as HTMLElement).style.removeProperty('--canvas-breath');
  }

  /** Toggle the global breathing oscillator. */
  setRunBreathing(on: boolean): void {
    this.breathing = on && !this.prefersReducedMotion;
    if (!on && this.host) this.host.style.setProperty('--canvas-breath', '1');
  }

  /**
   * Fire one photon per inbound edge (edges whose `target === nodeId`).
   * Called from realtime listeners on NODE_STARTED / NODE_COMPLETED. Cheap:
   * a DOM query + path-length read once per spawn.
   */
  spawnPhotonsForCompletedNode(nodeId: string): void {
    if (this.prefersReducedMotion || !this.host || !this.canvasEl) return;
    if (this.photons.length > MAX_PHOTONS) return;
    const edges = this.host.querySelectorAll<SVGGElement>('.react-flow__edge');
    const now = performance.now();
    edges.forEach((edge) => {
      const edgeTarget =
        edge.getAttribute('data-target') ?? edge.dataset.target ?? null;
      const edgeId = edge.getAttribute('data-id') ?? '';
      // React Flow edge ids are typically `${source}->${target}` or carry the
      // target via data-target. Fall back to id-suffix match.
      const matches =
        edgeTarget === nodeId ||
        edgeId.endsWith(`-${nodeId}`) ||
        edgeId.endsWith(`->${nodeId}`);
      if (!matches) return;
      const pathEl = edge.querySelector<SVGPathElement>('path.react-flow__edge-path');
      if (!pathEl) return;
      let length = 0;
      try {
        length = pathEl.getTotalLength();
      } catch {
        return;
      }
      if (!Number.isFinite(length) || length <= 0) return;
      this.photons.push({
        pathEl,
        pathLength: length,
        startedAt: now,
        reverse: false,
      });
    });
  }

  private resize(): void {
    if (!this.canvasEl || !this.host) return;
    const rect = this.host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvasEl.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvasEl.height = Math.max(1, Math.floor(rect.height * dpr));
    this.canvasEl.style.width = `${rect.width}px`;
    this.canvasEl.style.height = `${rect.height}px`;
    this.ctx2d?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);

    // Breathing: cheap CSS variable write on the host. Skipped when reduced
    // motion is requested. ReactFlow background uses var(--canvas-breath).
    if (this.breathing && this.host) {
      const phase = (now % BREATH_PERIOD_MS) / BREATH_PERIOD_MS; // 0..1
      const breath = 1 + Math.sin(phase * Math.PI * 2) * 0.04; // 0.96 .. 1.04
      this.host.style.setProperty('--canvas-breath', breath.toFixed(3));
    }

    if (!this.ctx2d || !this.canvasEl || !this.host) return;
    const ctx = this.ctx2d;
    ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
    if (this.photons.length === 0) return;

    const hostRect = this.host.getBoundingClientRect();
    const remaining: Photon[] = [];
    for (const p of this.photons) {
      const t = (now - p.startedAt) / PHOTON_DURATION_MS;
      if (t >= 1) continue;
      remaining.push(p);
      const len = (p.reverse ? 1 - t : t) * p.pathLength;
      let pt: DOMPoint;
      try {
        const raw = p.pathEl.getPointAtLength(len);
        const ctm = p.pathEl.getScreenCTM();
        if (!ctm) continue;
        const svgPt = new DOMPoint(raw.x, raw.y).matrixTransform(ctm);
        pt = new DOMPoint(svgPt.x - hostRect.left, svgPt.y - hostRect.top);
      } catch {
        continue;
      }
      // Trail: alpha falls off so the dot looks like a moving spark.
      const alpha = 1 - t * 0.4;
      ctx.beginPath();
      ctx.fillStyle = PHOTON_COLOR.replace('0.95', alpha.toFixed(2));
      ctx.shadowColor = PHOTON_COLOR;
      ctx.shadowBlur = 10;
      ctx.arc(pt.x, pt.y, PHOTON_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    this.photons = remaining;
  };
}
