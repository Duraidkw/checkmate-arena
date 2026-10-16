import type { Move, PieceSymbol, Square } from 'chess.js';
import { acceptsDraw, chooseMove, type Level } from '../chess/ai';
import type { AiRequest, AiResponse } from '../chess/ai.worker';
import { formatClock, other, type Color, type TimeControl } from '../chess/clock';
import { GameSession, describeResult, type Promotion } from '../chess/game';
import { BoardView, pieceUrl } from './board';
import { isMuted, play, setMuted } from './sound';
import { dbService } from '../services/db';

type Mode = 'ai' | 'local';
type ColorChoice = 'w' | 'b' | 'random';

interface Settings {
  mode: Mode;
  level: Level;
  color: ColorChoice;
  time: string;
}

export const TIME_CONTROLS: Record<string, { label: string; tc: TimeControl }> = {
  '3+2': { label: '3 + 2', tc: { initialMs: 180_000, incrementMs: 2_000 } },
  '5+0': { label: '5 min', tc: { initialMs: 300_000, incrementMs: 0 } },
  '10+0': { label: '10 min', tc: { initialMs: 600_000, incrementMs: 0 } },
  '15+10': { label: '15 + 10', tc: { initialMs: 900_000, incrementMs: 10_000 } },
  none: { label: 'No clock', tc: { initialMs: 0, incrementMs: 0 } },
};

const SETTINGS_KEY = 'ca-settings';
const DEFAULT_SETTINGS: Settings = { mode: 'ai', level: 'medium', color: 'w', time: '10+0' };
const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', html = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

export class App {
  private settings = loadSettings();
  private session: GameSession | null = null;
  private board: BoardView | null = null;
  private humanColor: Color = 'w';
  private worker: Worker | null = null;
  private aiRequestId = 0;
  private timer = 0;
  private resultShown = false;

  constructor(private readonly root: HTMLElement) {}

  start(): void {
    this.showHome();
  }

  // ---------- Home ----------

  private showHome(): void {
    this.stopGame();
    const s = this.settings;
    const profile = dbService.getProfile();
    const daily = dbService.canClaimDailyBonus();

    const seg = (name: string, options: [string, string][], value: string) =>
      `<div class="segmented" role="radiogroup" data-name="${name}">${options
        .map(([v, label]) => `<button type="button" role="radio" data-value="${v}" data-testid="${name}-${v}" aria-checked="${v === value}">${label}</button>`)
        .join('')}</div>`;

    const home = el('main', 'home');
    home.innerHTML = `
      <div class="user-topbar" data-testid="user-topbar">
        <div class="user-pill" data-action="open-profile" title="View Profile & Database Stats">
          <div class="user-avatar-sm"><img src="${pieceUrl(profile.avatar[0] as Color, profile.avatar[1])}" alt="" /></div>
          <div class="user-meta">
            <span class="user-display-name">${profile.displayName}</span>
            <span class="user-rating">⚡ ${profile.rating} ELO</span>
          </div>
        </div>
        <div class="user-actions">
          <button type="button" class="coin-badge" data-action="claim-daily" data-testid="coin-badge" title="Virtual Coin Wallet · Click to Claim Daily Bonus">
            🪙 ${profile.coins.toLocaleString()}
            <span class="daily-pill" data-testid="daily-pill">${daily.canClaim ? '🎁 +100' : 'Daily'}</span>
          </button>
          <button type="button" class="btn sm" data-action="open-profile" data-testid="profile-btn">⚙️ Profile &amp; DB</button>
        </div>
      </div>

      <header class="hero">
        <div class="logo" aria-hidden="true"><img src="${pieceUrl('w', 'n')}" alt="" /></div>
        <h1>Checkmate Arena</h1>
        <p class="tagline">Play chess. Stake coins. Climb the ranks.</p>
      </header>

      <section class="card">
        <h2>Mode</h2>
        ${seg('mode', [['ai', '🤖 vs Computer'], ['local', '👥 Pass &amp; Play']], s.mode)}
        <div class="ai-only" ${s.mode === 'ai' ? '' : 'hidden'}>
          <h3>Difficulty</h3>
          ${seg('level', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], s.level)}
          <h3>Play as</h3>
          ${seg('color', [['w', '♔ White'], ['random', '🎲 Random'], ['b', '♚ Black']], s.color)}
        </div>
        <h3>Time control</h3>
        ${seg('time', Object.entries(TIME_CONTROLS).map(([k, v]) => [k, v.label]), s.time)}
        <button type="button" class="btn primary block" data-testid="start-game">Start game</button>
      </section>

      <section class="card online">
        <div>
          <h2>🌐 Play Online &amp; Database <span class="badge">Active</span></h2>
          <p>Logged in as <strong>${profile.displayName}</strong> with <strong>${profile.coins.toLocaleString()} coins</strong> stored in Free Cloud Database.</p>
        </div>
        <button type="button" class="btn primary" data-action="open-profile" data-testid="online-profile">Database &amp; Profile</button>
      </section>

      <footer class="credits">
        Chess pieces by Colin M.L. Burnett (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC BY-SA 3.0</a>)
      </footer>
    `;

    home.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!btn) return;
        group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
        const name = group.dataset.name as keyof Settings;
        (this.settings as unknown as Record<string, string>)[name] = btn.dataset.value!;
        saveSettings(this.settings);
        if (name === 'mode') home.querySelector<HTMLElement>('.ai-only')!.hidden = this.settings.mode !== 'ai';
      });
    });

    home.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'open-profile') {
        this.showProfileModal();
      } else if (action === 'claim-daily') {
        const res = dbService.claimDailyBonus();
        this.toast(res.message);
        this.showHome();
      }
    });

    home.querySelector('[data-testid="start-game"]')!.addEventListener('click', () => this.newGame());

    this.root.replaceChildren(home);
  }


  // ---------- Game ----------

  private newGame(): void {
    this.stopGame();
    const s = this.settings;
    this.humanColor = s.mode === 'ai' ? (s.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : s.color) : 'w';
    this.session = new GameSession({ timeControl: TIME_CONTROLS[s.time]?.tc ?? TIME_CONTROLS['10+0'].tc });
    this.resultShown = false;
    this.renderGameScreen();
    this.session.onChange(() => this.update());
    this.timer = window.setInterval(() => this.tick(), 100);
    this.update();
    this.maybeAiMove();
  }

  private stopGame(): void {
    window.clearInterval(this.timer);
    this.worker?.terminate();
    this.worker = null;
    this.aiRequestId++;
    this.session = null;
    this.board = null;
  }

  private get isAi(): boolean {
    return this.settings.mode === 'ai';
  }

  private get aiColor(): Color {
    return other(this.humanColor);
  }

  private renderGameScreen(): void {
    const session = this.session!;
    const screen = el('main', 'game');
    const playerBar = (pos: 'top' | 'bottom') => `
      <div class="player-bar" data-testid="player-${pos}">
        <div class="avatar"></div>
        <div class="player-info">
          <span class="player-name"></span>
          <span class="captured"></span>
        </div>
        <div class="clock" data-testid="clock-${pos}"></div>
      </div>`;

    screen.innerHTML = `
      <header class="game-header">
        <button type="button" class="icon-btn" data-action="home" aria-label="Back to menu" data-testid="home">←</button>
        <span class="status" data-testid="status" aria-live="polite"></span>
        <button type="button" class="icon-btn" data-action="mute" aria-label="Toggle sound" data-testid="mute">${isMuted() ? '🔇' : '🔊'}</button>
      </header>
      <div class="game-layout">
        <div class="board-column">
          ${playerBar('top')}
          <div class="board-slot"></div>
          ${playerBar('bottom')}
        </div>
        <aside class="side-panel">
          <div class="controls">
            <button type="button" class="btn" data-action="undo" data-testid="undo" title="Take back move">↺ Undo</button>
            <button type="button" class="btn" data-action="flip" data-testid="flip">⇅ Flip</button>
            <button type="button" class="btn" data-action="draw" data-testid="offer-draw">½ Draw</button>
            <button type="button" class="btn danger" data-action="resign" data-testid="resign">⚑ Resign</button>
          </div>
          <ol class="moves" data-testid="moves" aria-label="Move list"></ol>
        </aside>
      </div>`;

    this.board = new BoardView(session, {
      canMove: (color) => !session.isOver && (!this.isAi || color === this.humanColor),
      onMove: (from, to, promotion) => this.playMove(from, to, promotion),
    });
    this.board.setOrientation(this.humanColor);
    screen.querySelector('.board-slot')!.appendChild(this.board.el);

    screen.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      if (action === 'home') this.confirmLeave();
      else if (action === 'undo') this.handleUndo();
      else if (action === 'flip') { this.board?.flip(); this.update(); }
      else if (action === 'draw') this.offerDraw();
      else if (action === 'resign') this.confirmResign();
      else if (action === 'mute') {
        setMuted(!isMuted());
        (e.target as HTMLElement).textContent = isMuted() ? '🔇' : '🔊';
      }
    });


    this.root.replaceChildren(screen);
  }

  private playMove(from: Square, to: Square, promotion?: Promotion): Move | null {
    const move = this.session?.move(from, to, promotion) ?? null;
    if (move) {
      play(this.session!.result ? 'end' : this.session!.chess.inCheck() ? 'check' : move.captured ? 'capture' : 'move');
      this.maybeAiMove();
    }
    return move;
  }

  private maybeAiMove(): void {
    const session = this.session;
    if (!this.isAi || !session || session.isOver || session.turn !== this.aiColor) return;
    const id = ++this.aiRequestId;
    const fen = session.chess.fen();
    const apply = (from: string, to: string, promotion?: string) => {
      if (id !== this.aiRequestId || this.session !== session) return; // stale answer
      this.playMove(from as Square, to as Square, promotion as Promotion | undefined);
    };
    // Fallback: think on the main thread if the background worker is unavailable.
    const fallback = () => {
      this.worker = null;
      window.setTimeout(() => {
        const m = chooseMove(fen, this.settings.level);
        if (m) apply(m.from, m.to, m.promotion);
      }, 50);
    };

    try {
      this.worker ??= new Worker(new URL('../chess/ai.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      fallback();
      this.update();
      return;
    }
    this.worker.onmessage = (e: MessageEvent<AiResponse>) => {
      if (e.data.id === id) apply(e.data.from, e.data.to, e.data.promotion);
    };
    this.worker.onerror = () => {
      this.worker?.terminate();
      if (id === this.aiRequestId) fallback();
    };
    const request: AiRequest = { id, fen, level: this.settings.level };
    this.worker.postMessage(request);
    this.update();
  }

  private tick(): void {
    if (!this.session) return;
    const before = this.session.result;
    this.session.tick();
    if (!before && this.session.result) play('end');
    this.updateClocks();
  }

  private update(): void {
    const session = this.session;
    if (!session || !this.board) return;
    this.board.render();

    const bottom: Color = this.board.flipped ? 'b' : 'w';
    const names: Record<Color, string> = this.isAi
      ? { [this.humanColor]: 'You', [this.aiColor]: `Computer · ${this.settings.level}` } as Record<Color, string>
      : { w: 'White', b: 'Black' };
    const captured = capturedPieces(session.history());
    const material = (c: Color) => captured[c].reduce((sum, p) => sum + VALUE[p], 0);

    for (const [pos, color] of [['bottom', bottom], ['top', other(bottom)]] as const) {
      const bar = this.root.querySelector<HTMLElement>(`[data-testid="player-${pos}"]`)!;
      bar.dataset.color = color;
      bar.querySelector('.avatar')!.innerHTML = `<img src="${pieceUrl(color, 'k')}" alt="" />`;
      const thinking = this.isAi && color === this.aiColor && session.turn === color && !session.isOver;
      bar.querySelector('.player-name')!.innerHTML = `${names[color]}${thinking ? ' <span class="thinking" data-testid="thinking">thinking…</span>' : ''}`;
      const diff = material(color) - material(other(color));
      bar.querySelector('.captured')!.innerHTML =
        captured[color].map((p) => `<img src="${pieceUrl(other(color), p)}" alt="${p}" />`).join('') +
        (diff > 0 ? `<span class="material">+${diff}</span>` : '');
    }

    this.renderMoves(session.history());
    this.updateClocks();
    this.updateStatus();

    if (session.result && !this.resultShown) {
      this.resultShown = true;
      window.setTimeout(() => this.showResult(), 350);
    }
  }

  private updateClocks(): void {
    const session = this.session;
    if (!session || !this.board) return;
    const bottom: Color = this.board.flipped ? 'b' : 'w';
    for (const [pos, color] of [['bottom', bottom], ['top', other(bottom)]] as const) {
      const clock = this.root.querySelector<HTMLElement>(`[data-testid="clock-${pos}"]`);
      if (!clock) continue;
      const ms = session.timeLeft(color);
      clock.textContent = formatClock(ms);
      clock.hidden = !Number.isFinite(ms);
      clock.classList.toggle('active', !session.isOver && session.turn === color);
      clock.classList.toggle('low', ms < 20_000);
    }
  }

  private updateStatus(): void {
    const session = this.session!;
    const status = this.root.querySelector<HTMLElement>('[data-testid="status"]')!;
    if (session.result) {
      const { title } = describeResult(session.result);
      status.textContent = title;
      return;
    }
    const side = session.turn === 'w' ? 'White' : 'Black';
    const who = this.isAi ? (session.turn === this.humanColor ? 'Your move' : 'Computer to move') : `${side} to move`;
    status.textContent = session.chess.inCheck() ? `${who} · Check!` : who;
  }

  private renderMoves(history: Move[]): void {
    const list = this.root.querySelector<HTMLOListElement>('[data-testid="moves"]')!;
    const rows: string[] = [];
    for (let i = 0; i < history.length; i += 2) {
      rows.push(`<li><span class="san">${history[i].san}</span><span class="san">${history[i + 1]?.san ?? ''}</span></li>`);
    }
    list.innerHTML = rows.join('');
    list.scrollTop = list.scrollHeight;
  }

  private handleUndo(): void {
    const session = this.session;
    if (!session || session.isOver || session.history().length === 0) return;
    if (this.isAi) {
      this.worker?.terminate();
      this.worker = null;
      this.aiRequestId++;
      const movesToUndo = session.turn === this.humanColor && session.history().length >= 2 ? 2 : 1;
      const undone = session.undo(movesToUndo);
      if (undone.length) {
        this.toast(`Undid ${undone.length} move(s)`);
      }
    } else {
      const undone = session.undo(1);
      if (undone.length) {
        this.toast('Undid move');
      }
    }
    this.update();
  }

  // ---------- Dialogs ----------

  private dialog(title: string, body: string, buttons: { label: string; testid: string; kind?: string; action: () => void }[], extraHtml = ''): void {
    this.root.querySelector('.modal')?.remove();
    const modal = el('div', 'modal');
    modal.dataset.testid = 'modal';
    modal.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title" data-testid="modal-title">${title}</h2>
      <p data-testid="modal-body">${body}</p>
      ${extraHtml}
      <div class="modal-actions"></div>
    </div>`;
    const actions = modal.querySelector('.modal-actions')!;
    for (const b of buttons) {
      const btn = el('button', `btn ${b.kind ?? ''}`, b.label);
      btn.type = 'button';
      btn.dataset.testid = b.testid;
      btn.addEventListener('click', () => {
        modal.remove();
        b.action();
      });
      actions.appendChild(btn);
    }
    this.root.appendChild(modal);
    actions.querySelector<HTMLButtonElement>('button:last-child')?.focus();
  }

  private toast(message: string): void {
    const t = el('div', 'toast', message);
    t.dataset.testid = 'toast';
    t.setAttribute('role', 'status');
    this.root.appendChild(t);
    window.setTimeout(() => t.remove(), 2600);
  }

  private showResult(): void {
    const session = this.session;
    const result = session?.result;
    if (!result || !session) return;
    const { title, detail } = describeResult(result);
    let heading = title;
    let outcome: 'win' | 'loss' | 'draw' = 'draw';
    if (this.isAi) {
      if (result.winner === null) {
        heading = 'Draw';
        outcome = 'draw';
      } else if (result.winner === this.humanColor) {
        heading = 'You won! 🎉';
        outcome = 'win';
      } else {
        heading = 'You lost';
        outcome = 'loss';
      }
    } else {
      outcome = result.winner ? 'win' : 'draw';
    }

    const { match, profile } = dbService.recordMatch({
      mode: this.settings.mode,
      opponent: this.isAi ? `Computer (${this.settings.level})` : 'Local Friend',
      result: outcome,
      reason: result.reason,
      movesCount: session.history().length,
      timeControl: this.settings.time,
    });

    const rewardNotice = outcome === 'win'
      ? `+${match.coinChange} Coins · +${match.ratingChange} Rating`
      : outcome === 'loss'
      ? `${match.ratingChange} Rating`
      : `+${match.coinChange} Coins`;

    const extraHtml = `
      <div style="margin: 0 0 16px; padding: 10px; background: var(--bg-2); border-radius: 10px; border: 1px solid var(--border);" data-testid="match-reward">
        <div class="reward-pill" style="margin-bottom: 6px;">🪙 ${rewardNotice}</div>
        <div style="font-size: 0.75rem; color: var(--muted);">Balance: <strong>${profile.coins.toLocaleString()} coins</strong> · Rating: <strong>${profile.rating} ELO</strong></div>
        <div style="font-size: 0.7rem; color: var(--good); margin-top: 4px;">✓ Saved to Free Database</div>
      </div>
    `;

    this.dialog(
      heading,
      detail,
      [
        { label: 'Menu', testid: 'result-menu', action: () => this.showHome() },
        { label: 'Review board', testid: 'result-review', action: () => undefined },
        { label: 'Play again', testid: 'rematch', kind: 'primary', action: () => this.newGame() },
      ],
      extraHtml,
    );
  }

  private showProfileModal(): void {
    const profile = dbService.getProfile();
    const stats = profile.stats;
    const winRate = stats.gamesPlayed > 0 ? Math.round((stats.wins / stats.gamesPlayed) * 100) : 0;
    const daily = dbService.canClaimDailyBonus();

    const avatars = ['wk', 'wq', 'wn', 'wb', 'wr', 'bk', 'bq', 'bn', 'bb', 'br'];

    this.root.querySelector('.modal')?.remove();
    const modal = el('div', 'modal');
    modal.dataset.testid = 'profile-modal';
    modal.innerHTML = `
      <div class="modal-card wide" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h2 id="profile-title" style="margin:0; font-size:1.3rem;">User Profile &amp; Free Database</h2>
          <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">✕</button>
        </div>

        <div class="profile-section">
          <div style="display:flex; align-items:center; gap:16px;">
            <div class="user-avatar-sm" style="width:52px; height:52px; border-radius:14px;">
              <img id="current-avatar-img" src="${pieceUrl(profile.avatar[0] as Color, profile.avatar[1])}" alt="" style="width:38px;" />
            </div>
            <div style="flex:1;">
              <label style="font-size:0.75rem; color:var(--muted); text-transform:uppercase; font-weight:700;">Display Name</label>
              <input type="text" id="profile-name-input" class="input-field" value="${profile.displayName}" maxlength="30" />
            </div>
          </div>
          <div style="margin-top:12px;">
            <label style="font-size:0.75rem; color:var(--muted); text-transform:uppercase; font-weight:700;">Select Avatar</label>
            <div class="avatar-grid">
              ${avatars
                .map(
                  (a) =>
                    `<button type="button" class="avatar-btn ${a === profile.avatar ? 'selected' : ''}" data-avatar="${a}" title="${a}">
                      <img src="${pieceUrl(a[0] as Color, a[1])}" alt="${a}" />
                    </button>`,
                )
                .join('')}
            </div>
          </div>
        </div>

        <div class="profile-section">
          <h3>Player Career &amp; Wallet</h3>
          <div class="stat-grid">
            <div class="stat-box"><div class="stat-val">🪙 ${profile.coins.toLocaleString()}</div><div class="stat-lbl">Coins</div></div>
            <div class="stat-box"><div class="stat-val">⚡ ${profile.rating}</div><div class="stat-lbl">Rating (ELO)</div></div>
            <div class="stat-box"><div class="stat-val">${stats.gamesPlayed}</div><div class="stat-lbl">Played</div></div>
            <div class="stat-box"><div class="stat-val" style="color:var(--good);">${stats.wins}</div><div class="stat-lbl">Wins</div></div>
            <div class="stat-box"><div class="stat-val" style="color:var(--danger);">${stats.losses}</div><div class="stat-lbl">Losses</div></div>
            <div class="stat-box"><div class="stat-val">${winRate}%</div><div class="stat-lbl">Win Rate</div></div>
            <div class="stat-box"><div class="stat-val">🔥 ${stats.winStreak}</div><div class="stat-lbl">Streak</div></div>
            <div class="stat-box"><div class="stat-val">⭐ ${stats.bestWinStreak}</div><div class="stat-lbl">Best</div></div>
          </div>

          <div style="margin-top:12px; display:flex; justify-content:space-between; align-items:center; background:var(--bg-2); padding:10px 14px; border-radius:10px; border:1px solid var(--border);">
            <div>
              <strong style="color:#fbbf24;">Daily 100 Free Coins</strong>
              <div style="font-size:0.78rem; color:var(--muted);">Claim free bonus every 24 hours</div>
            </div>
            <button type="button" class="btn primary sm" id="claim-bonus-btn" ${daily.canClaim ? '' : 'disabled'}>
              ${daily.canClaim ? '🎁 Claim +100' : 'Claimed'}
            </button>
          </div>
        </div>

        <div class="profile-section">
          <h3>Free Cloud Database (Firebase / Supabase REST)</h3>
          <div class="db-status-bar">
            <div class="db-indicator">
              <span>🟢</span>
              <span id="db-status-text">Cloud Sync: Active (Free Tier Ready)</span>
            </div>
            <button type="button" class="btn sm" id="sync-now-btn">🔄 Sync Now</button>
          </div>
          <div>
            <label style="font-size:0.75rem; color:var(--muted); text-transform:uppercase; font-weight:700;">Database Endpoint URL</label>
            <input type="text" id="db-endpoint-input" class="input-field" value="${profile.cloudConfig.endpointUrl}" placeholder="https://your-free-db.firebaseio.com" />
            <small style="color:var(--muted); font-size:0.72rem;">Zero-config Free Firebase Realtime DB or Supabase endpoint. Offline changes automatically sync when online.</small>
          </div>
          <div style="display:flex; gap:8px; margin-top:10px;">
            <button type="button" class="btn sm ghost" id="export-json-btn">📥 Export Backup</button>
            <button type="button" class="btn sm ghost" id="import-json-btn">📤 Import Backup</button>
          </div>
        </div>

        <div class="profile-section">
          <h3>Recent Match History (${profile.history.length})</h3>
          <div class="history-list">
            ${
              profile.history.length === 0
                ? '<div style="padding:10px; text-align:center; color:var(--muted);">No matches recorded yet.</div>'
                : profile.history
                    .slice(0, 10)
                    .map(
                      (h) => `
              <div class="history-item">
                <div>
                  <span class="history-${h.result}">${h.result.toUpperCase()}</span> vs ${h.opponent} (${h.movesCount} moves)
                  <div style="font-size:0.72rem; color:var(--muted);">${new Date(h.timestamp).toLocaleDateString()} ${new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
                <div style="text-align:right;">
                  <span style="font-weight:700; color:#fbbf24;">${h.coinChange >= 0 ? '+' : ''}${h.coinChange} coins</span>
                  <div style="font-size:0.72rem; color:var(--muted);">${h.ratingChange >= 0 ? '+' : ''}${h.ratingChange} ELO</div>
                </div>
              </div>`,
                    )
                    .join('')
            }
          </div>
        </div>

        <div class="modal-actions" style="margin-top:14px;">
          <button type="button" class="btn primary" id="save-profile-btn">Save Profile &amp; Settings</button>
        </div>
      </div>
    `;

    let selectedAvatar = profile.avatar;
    modal.querySelectorAll('.avatar-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.avatar-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedAvatar = (btn as HTMLElement).dataset.avatar!;
        (modal.querySelector('#current-avatar-img') as HTMLImageElement).src = pieceUrl(selectedAvatar[0] as Color, selectedAvatar[1]);
      });
    });

    modal.querySelector('#claim-bonus-btn')?.addEventListener('click', () => {
      const res = dbService.claimDailyBonus();
      this.toast(res.message);
      modal.remove();
      this.showProfileModal();
      this.showHome();
    });

    modal.querySelector('#sync-now-btn')?.addEventListener('click', async () => {
      const syncBtn = modal.querySelector('#sync-now-btn') as HTMLButtonElement;
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing...';
      const res = await dbService.syncToCloud();
      this.toast(res.message);
      syncBtn.disabled = false;
      syncBtn.textContent = '🔄 Sync Now';
    });

    modal.querySelector('#export-json-btn')?.addEventListener('click', () => {
      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(dbService.exportJson());
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', dataStr);
      downloadAnchor.setAttribute('download', `checkmate_arena_user_${profile.username}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      this.toast('Exported profile & database backup JSON');
    });

    modal.querySelector('#import-json-btn')?.addEventListener('click', () => {
      const raw = prompt('Paste your Checkmate Arena profile JSON:');
      if (raw && dbService.importJson(raw)) {
        this.toast('Profile & database imported successfully!');
        modal.remove();
        this.showHome();
      } else if (raw) {
        this.toast('Invalid JSON backup');
      }
    });

    modal.querySelector('[data-action="close-modal"]')?.addEventListener('click', () => modal.remove());

    modal.querySelector('#save-profile-btn')?.addEventListener('click', () => {
      const nameInput = modal.querySelector('#profile-name-input') as HTMLInputElement;
      const endpointInput = modal.querySelector('#db-endpoint-input') as HTMLInputElement;
      const newName = nameInput.value.trim() || profile.displayName;
      const newEndpoint = endpointInput.value.trim() || profile.cloudConfig.endpointUrl;

      dbService.updateProfile({
        displayName: newName,
        avatar: selectedAvatar,
      });
      dbService.updateCloudConfig({
        endpointUrl: newEndpoint,
      });

      this.toast('Profile and database settings saved!');
      modal.remove();
      this.showHome();
    });

    this.root.appendChild(modal);
  }


  private confirmResign(): void {
    const session = this.session;
    if (!session || session.isOver) return;
    const loser = this.isAi ? this.humanColor : session.turn;
    const side = loser === 'w' ? 'White' : 'Black';
    this.dialog('Resign?', this.isAi ? 'The computer will win this game.' : `${side} resigns and loses the game.`, [
      { label: 'Cancel', testid: 'cancel', action: () => undefined },
      { label: 'Resign', testid: 'confirm-resign', kind: 'danger', action: () => this.session?.resign(loser) },
    ]);
  }

  private offerDraw(): void {
    const session = this.session;
    if (!session || session.isOver) return;
    if (this.isAi) {
      if (acceptsDraw(session.chess.fen(), this.aiColor)) {
        this.toast('The computer accepts your draw offer.');
        session.agreeDraw();
      } else {
        this.toast('The computer declines. Play on!');
      }
      return;
    }
    const side = other(session.turn) === 'w' ? 'White' : 'Black';
    const offerer = session.turn === 'w' ? 'White' : 'Black';
    this.dialog('Draw offered', `${offerer} offers a draw. ${side}, do you accept?`, [
      { label: 'Decline', testid: 'decline-draw', action: () => this.toast('Draw declined.') },
      { label: 'Accept', testid: 'accept-draw', kind: 'primary', action: () => this.session?.agreeDraw() },
    ]);
  }

  private confirmLeave(): void {
    const session = this.session;
    if (!session || session.isOver || session.history().length === 0) {
      this.showHome();
      return;
    }
    this.dialog('Leave game?', 'This game is still in progress.', [
      { label: 'Stay', testid: 'cancel', action: () => undefined },
      { label: 'Leave', testid: 'confirm-leave', kind: 'danger', action: () => this.showHome() },
    ]);
  }
}

/** Pieces captured BY each colour. */
export function capturedPieces(history: Move[]): Record<Color, PieceSymbol[]> {
  const result: Record<Color, PieceSymbol[]> = { w: [], b: [] };
  for (const m of history) if (m.captured) result[m.color].push(m.captured);
  for (const c of ['w', 'b'] as const) result[c].sort((a, b) => VALUE[b] - VALUE[a]);
  return result;
}
