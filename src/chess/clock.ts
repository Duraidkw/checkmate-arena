export type Color = 'w' | 'b';

export interface TimeControl {
  /** Starting time per side in ms. 0 means untimed. */
  initialMs: number;
  /** Time added after each move in ms. */
  incrementMs: number;
}

export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');

/**
 * Two-sided chess clock. Time is injected (`now`) so the logic is deterministic and testable.
 */
export class ChessClock {
  private remaining: Record<Color, number>;
  private running: Color | null = null;
  private turnStartedAt = 0;

  constructor(readonly timeControl: TimeControl) {
    this.remaining = { w: timeControl.initialMs, b: timeControl.initialMs };
  }

  get untimed(): boolean {
    return this.timeControl.initialMs <= 0;
  }

  get active(): Color | null {
    return this.running;
  }

  start(color: Color, now: number): void {
    if (this.untimed) return;
    this.running = color;
    this.turnStartedAt = now;
  }

  /** Ends the running side's turn: deducts elapsed time, adds the increment and starts the opponent. */
  switchTurn(now: number): void {
    if (this.untimed || !this.running) return;
    const mover = this.running;
    this.remaining[mover] = Math.max(0, this.remaining[mover] - (now - this.turnStartedAt));
    if (this.remaining[mover] > 0) this.remaining[mover] += this.timeControl.incrementMs;
    this.running = other(mover);
    this.turnStartedAt = now;
  }

  stop(now: number): void {
    if (!this.running) return;
    this.remaining[this.running] = this.timeLeft(this.running, now);
    this.running = null;
  }

  timeLeft(color: Color, now: number): number {
    if (this.untimed) return Infinity;
    let t = this.remaining[color];
    if (this.running === color) t -= now - this.turnStartedAt;
    return Math.max(0, t);
  }

  /** The side whose time has run out, if any. */
  flagged(now: number): Color | null {
    if (this.untimed || !this.running) return null;
    return this.timeLeft(this.running, now) <= 0 ? this.running : null;
  }
}

export function formatClock(ms: number): string {
  if (!Number.isFinite(ms)) return '∞';
  if (ms < 10_000) {
    // Under 10 seconds: show tenths.
    const tenths = Math.floor(ms / 100);
    return `0:${String(Math.floor(tenths / 10)).padStart(2, '0')}.${tenths % 10}`;
  }
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
