import { Chess, type Move, type PieceSymbol, type Square } from 'chess.js';
import { ChessClock, other, type Color, type TimeControl } from './clock';

export type ResultReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient'
  | 'threefold'
  | 'fifty-move'
  | 'timeout'
  | 'resign'
  | 'agreement';

export interface GameResult {
  winner: Color | null;
  reason: ResultReason;
}

export type Promotion = Exclude<PieceSymbol, 'p' | 'k'>;

export interface SessionOptions {
  timeControl: TimeControl;
  fen?: string;
  now?: () => number;
}

/**
 * One game of chess: rules (via chess.js), clocks and the final result.
 * The UI and the network layer talk to this class only.
 */
export class GameSession {
  readonly chess: Chess;
  readonly clock: ChessClock;
  result: GameResult | null = null;

  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(opts: SessionOptions) {
    this.chess = new Chess(opts.fen);
    this.clock = new ChessClock(opts.timeControl);
    this.now = opts.now ?? (() => performance.now());
  }

  get turn(): Color {
    return this.chess.turn();
  }

  get isOver(): boolean {
    return this.result !== null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  legalMovesFrom(square: Square): Move[] {
    if (this.result) return [];
    return this.chess.moves({ square, verbose: true });
  }

  isPromotion(from: Square, to: Square): boolean {
    return this.legalMovesFrom(from).some((m) => m.to === to && m.promotion);
  }

  /** Plays a move. Returns the move, or null if it is illegal or the game is over. */
  move(from: Square, to: Square, promotion?: Promotion): Move | null {
    if (this.tick()) return null;
    const legal = this.legalMovesFrom(from).find(
      (m) => m.to === to && (!m.promotion || m.promotion === (promotion ?? 'q')),
    );
    if (!legal) return null;

    const played = this.chess.move({ from, to, promotion: legal.promotion });
    const now = this.now();
    // Clocks start once White has moved, as on most chess servers.
    if (this.chess.history().length === 1) this.clock.start(this.turn, now);
    else this.clock.switchTurn(now);

    this.detectEnd();
    this.emit();
    return played;
  }

  moveSan(san: string): Move | null {
    const legal = this.chess.moves({ verbose: true }).find((m) => m.san === san || m.lan === san);
    return legal ? this.move(legal.from, legal.to, legal.promotion as Promotion | undefined) : null;
  }

  /** Checks the clock. Returns the result if the game just ended or was already over. */
  tick(): GameResult | null {
    if (this.result) return this.result;
    const flagged = this.clock.flagged(this.now());
    if (flagged) {
      const winner = other(flagged);
      // A player who runs out of time only loses if the opponent could still deliver mate.
      this.finish(hasMatingMaterial(this.chess, winner) ? { winner, reason: 'timeout' } : { winner: null, reason: 'insufficient' });
    }
    return this.result;
  }

  resign(color: Color): void {
    if (!this.result) this.finish({ winner: other(color), reason: 'resign' });
  }

  agreeDraw(): void {
    if (!this.result) this.finish({ winner: null, reason: 'agreement' });
  }

  history(): Move[] {
    return this.chess.history({ verbose: true });
  }

  lastMove(): Move | null {
    const h = this.history();
    return h.length ? h[h.length - 1] : null;
  }

  /** The square of the king that is in check, if any. */
  checkedKing(): Square | null {
    if (!this.chess.inCheck()) return null;
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (cell && cell.type === 'k' && cell.color === this.turn) return cell.square;
      }
    }
    return null;
  }

  timeLeft(color: Color): number {
    return this.clock.timeLeft(color, this.now());
  }

  private detectEnd(): void {
    const c = this.chess;
    if (c.isCheckmate()) this.finish({ winner: other(this.turn), reason: 'checkmate' });
    else if (c.isStalemate()) this.finish({ winner: null, reason: 'stalemate' });
    else if (c.isInsufficientMaterial()) this.finish({ winner: null, reason: 'insufficient' });
    else if (c.isThreefoldRepetition()) this.finish({ winner: null, reason: 'threefold' });
    else if (c.isDrawByFiftyMoves()) this.finish({ winner: null, reason: 'fifty-move' });
  }

  private finish(result: GameResult): void {
    this.result = result;
    this.clock.stop(this.now());
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

/** Whether `color` has enough material to ever checkmate (used for timeout rulings). */
export function hasMatingMaterial(chess: Chess, color: Color): boolean {
  let minors = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== color || cell.type === 'k') continue;
      if (cell.type === 'p' || cell.type === 'r' || cell.type === 'q') return true;
      minors++;
    }
  }
  return minors >= 2;
}

export function describeResult(result: GameResult): { title: string; detail: string } {
  const side = (c: Color) => (c === 'w' ? 'White' : 'Black');
  const reasons: Record<ResultReason, string> = {
    checkmate: 'by checkmate',
    resign: 'by resignation',
    timeout: 'on time',
    stalemate: 'Stalemate',
    insufficient: 'Insufficient material',
    threefold: 'Threefold repetition',
    'fifty-move': 'Fifty-move rule',
    agreement: 'Draw by agreement',
  };
  return result.winner
    ? { title: `${side(result.winner)} wins`, detail: reasons[result.reason] }
    : { title: 'Draw', detail: reasons[result.reason] };
}
