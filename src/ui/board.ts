import type { Move, Square } from 'chess.js';
import type { Color } from '../chess/clock';
import type { GameSession, Promotion } from '../chess/game';

const FILES = 'abcdefgh';
const PIECE_NAMES: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export const pieceUrl = (color: Color, type: string) => `${import.meta.env.BASE_URL}pieces/${color}${type.toUpperCase()}.svg`;

export interface BoardCallbacks {
  /** May the local user move pieces of this colour right now? */
  canMove(color: Color): boolean;
  onMove(from: Square, to: Square, promotion?: Promotion): void;
}

interface DragState {
  from: Square;
  ghost: HTMLImageElement;
  origin: HTMLElement;
  pointerId: number;
  moved: boolean;
  startX: number;
  startY: number;
}

/** Interactive chess board: click-to-move and drag-and-drop, with legal-move hints. */
export class BoardView {
  readonly el: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly squares = new Map<Square, HTMLElement>();
  private orientation: Color = 'w';
  private selected: Square | null = null;
  private targets: Move[] = [];
  private drag: DragState | null = null;
  private promoting = false;

  constructor(private session: GameSession, private readonly cb: BoardCallbacks) {
    this.el = document.createElement('div');
    this.el.className = 'board-wrap';
    this.grid = document.createElement('div');
    this.grid.className = 'board';
    this.grid.setAttribute('role', 'grid');
    this.grid.setAttribute('aria-label', 'Chess board');
    this.grid.dataset.testid = 'board';
    this.el.appendChild(this.grid);

    for (let r = 8; r >= 1; r--) {
      for (const f of FILES) {
        const sq = `${f}${r}` as Square;
        const cell = document.createElement('div');
        cell.className = `square ${(FILES.indexOf(f) + r) % 2 ? 'light' : 'dark'}`;
        cell.dataset.square = sq;
        cell.dataset.testid = `sq-${sq}`;
        cell.setAttribute('role', 'gridcell');
        this.squares.set(sq, cell);
      }
    }
    this.layout();

    this.grid.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.grid.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.grid.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.grid.addEventListener('pointercancel', () => this.cancelDrag());
    this.grid.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setSession(session: GameSession): void {
    this.session = session;
    this.deselect();
    this.render();
  }

  setOrientation(color: Color): void {
    this.orientation = color;
    this.layout();
    this.render();
  }

  flip(): void {
    this.setOrientation(this.orientation === 'w' ? 'b' : 'w');
  }

  get flipped(): boolean {
    return this.orientation === 'b';
  }

  private layout(): void {
    const order = [...this.squares.values()];
    if (this.orientation === 'b') order.reverse();
    this.grid.replaceChildren(...order);
    // Coordinates on the bottom rank and the left file from the viewer's side.
    order.forEach((cell, i) => {
      const sq = cell.dataset.square!;
      cell.querySelectorAll('.coord').forEach((c) => c.remove());
      if (i % 8 === 0) cell.insertAdjacentHTML('beforeend', `<span class="coord rank">${sq[1]}</span>`);
      if (i >= 56) cell.insertAdjacentHTML('beforeend', `<span class="coord file">${sq[0]}</span>`);
    });
  }

  render(): void {
    const chess = this.session.chess;
    const last = this.session.lastMove();
    const check = this.session.checkedKing();
    const targetSquares = new Map(this.targets.map((m) => [m.to, m]));

    for (const [sq, cell] of this.squares) {
      const piece = chess.get(sq);
      cell.classList.toggle('selected', sq === this.selected);
      cell.classList.toggle('last', !!last && (last.from === sq || last.to === sq));
      cell.classList.toggle('check', sq === check);
      const target = targetSquares.get(sq);
      cell.classList.toggle('target', !!target && !target.captured);
      cell.classList.toggle('capture', !!target && !!target.captured);

      const existing = cell.querySelector<HTMLImageElement>('img.piece');
      const key = piece ? piece.color + piece.type : '';
      if (existing?.dataset.piece === key) continue;
      existing?.remove();
      if (piece) {
        const img = document.createElement('img');
        img.className = 'piece';
        img.src = pieceUrl(piece.color, piece.type);
        img.alt = '';
        img.draggable = false;
        img.dataset.piece = key;
        cell.prepend(img);
      }
      cell.setAttribute('aria-label', piece ? `${sq} ${piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece.type]}` : sq);
    }
  }

  // ---------- Interaction ----------

  private squareFromEvent(e: PointerEvent): Square | null {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.square');
    return (el?.dataset.square as Square) ?? null;
  }

  private select(sq: Square): void {
    this.selected = sq;
    this.targets = this.session.legalMovesFrom(sq);
    this.render();
  }

  private deselect(): void {
    this.selected = null;
    this.targets = [];
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.promoting || this.session.isOver) return;
    const sq = (e.target as HTMLElement).closest<HTMLElement>('.square')?.dataset.square as Square | undefined;
    if (!sq) return;

    if (this.selected && this.targets.some((m) => m.to === sq)) {
      void this.attempt(this.selected, sq);
      return;
    }

    const piece = this.session.chess.get(sq);
    if (!piece || piece.color !== this.session.turn || !this.cb.canMove(piece.color)) {
      this.deselect();
      this.render();
      return;
    }

    this.select(sq);
    const origin = this.squares.get(sq)!.querySelector<HTMLImageElement>('img.piece');
    if (!origin) return;
    const rect = origin.getBoundingClientRect();
    const ghost = origin.cloneNode() as HTMLImageElement;
    ghost.className = 'piece ghost';
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);
    this.drag = { from: sq, ghost, origin, pointerId: e.pointerId, moved: false, startX: e.clientX, startY: e.clientY };
    this.positionGhost(e);
    ghost.hidden = true;
    this.grid.setPointerCapture(e.pointerId);
  }

  private positionGhost(e: PointerEvent): void {
    if (!this.drag) return;
    const { ghost } = this.drag;
    const size = parseFloat(ghost.style.width) || 0;
    ghost.style.left = `${e.clientX - size / 2}px`;
    ghost.style.top = `${e.clientY - size / 2}px`;
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    if (!this.drag.moved && Math.hypot(e.clientX - this.drag.startX, e.clientY - this.drag.startY) > 4) {
      this.drag.moved = true;
      this.drag.ghost.hidden = false;
      this.drag.origin.classList.add('dragging');
    }
    if (this.drag.moved) this.positionGhost(e);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const { from, moved } = this.drag;
    this.drag.ghost.hidden = true; // so elementFromPoint sees the square below
    const to = this.squareFromEvent(e);
    this.cancelDrag();
    if (moved && to && to !== from && this.targets.some((m) => m.to === to)) {
      void this.attempt(from, to);
    } else if (moved) {
      this.render();
    }
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag.ghost.remove();
    this.drag.origin.classList.remove('dragging');
    this.drag = null;
  }

  private async attempt(from: Square, to: Square): Promise<void> {
    let promotion: Promotion | undefined;
    if (this.session.isPromotion(from, to)) {
      const choice = await this.pickPromotion(this.session.turn);
      if (!choice) {
        this.deselect();
        this.render();
        return;
      }
      promotion = choice;
    }
    this.deselect();
    this.cb.onMove(from, to, promotion);
  }

  private pickPromotion(color: Color): Promise<Promotion | null> {
    this.promoting = true;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'promotion';
      overlay.dataset.testid = 'promotion';
      overlay.innerHTML = `<div class="promotion-panel" role="dialog" aria-label="Choose promotion piece">
        ${(['q', 'r', 'b', 'n'] as const)
          .map((p) => `<button type="button" data-piece="${p}" data-testid="promo-${p}" aria-label="${PIECE_NAMES[p]}"><img src="${pieceUrl(color, p)}" alt="" /></button>`)
          .join('')}
      </div>`;
      const done = (p: Promotion | null) => {
        overlay.remove();
        this.promoting = false;
        resolve(p);
      };
      overlay.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
        done(btn ? (btn.dataset.piece as Promotion) : null);
      });
      this.el.appendChild(overlay);
    });
  }
}
