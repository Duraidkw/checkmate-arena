import { expect, test, type Page } from '@playwright/test';

async function startGame(page: Page, opts: { mode?: 'ai' | 'local'; time?: string; color?: string; level?: string } = {}) {
  const { mode = 'local', time = 'none', color, level } = opts;
  await page.getByTestId(`mode-${mode}`).click();
  if (level) await page.getByTestId(`level-${level}`).click();
  if (color) await page.getByTestId(`color-${color}`).click();
  await page.getByTestId(`time-${time}`).click();
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

/** Plays moves by clicking squares, e.g. 'e2e4'. */
async function play(page: Page, ...moves: string[]) {
  for (const m of moves) {
    await page.getByTestId(`sq-${m.slice(0, 2)}`).click();
    await page.getByTestId(`sq-${m.slice(2, 4)}`).click();
  }
}

const piece = (page: Page, sq: string) => page.getByTestId(`sq-${sq}`).locator('img.piece');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test.describe('Home', () => {
  test('shows the menu and remembers settings', async ({ page }) => {
    await expect(page).toHaveTitle('Checkmate Arena');
    await expect(page.getByRole('heading', { name: 'Checkmate Arena' })).toBeVisible();
    await page.getByTestId('mode-local').click();
    await page.getByTestId('time-3+2').click();
    await page.reload();
    await expect(page.getByTestId('mode-local')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('time-3+2')).toHaveAttribute('aria-checked', 'true');
  });

  test('is an installable PWA', async ({ page }) => {
    const manifest = await (await page.request.get('/manifest.webmanifest')).json();
    expect(manifest.name).toBe('Checkmate Arena');
    expect(manifest.display).toBe('standalone');
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()))).toBe(true);
  });
});

test.describe('Pass & Play', () => {
  test('sets up the initial position', async ({ page }) => {
    await startGame(page);
    await expect(page.locator('.square')).toHaveCount(64);
    await expect(page.locator('img.piece')).toHaveCount(32);
    await expect(piece(page, 'e1')).toHaveAttribute('data-piece', 'wk');
    await expect(piece(page, 'd8')).toHaveAttribute('data-piece', 'bq');
    await expect(page.getByTestId('status')).toHaveText('White to move');
  });

  test('click-to-move shows legal targets and plays the move', async ({ page }) => {
    await startGame(page);
    await page.getByTestId('sq-g1').click();
    await expect(page.locator('.square.target')).toHaveCount(2); // Nf3, Nh3
    await page.getByTestId('sq-f3').click();
    await expect(piece(page, 'f3')).toHaveAttribute('data-piece', 'wn');
    await expect(page.getByTestId('moves')).toContainText('Nf3');
    await expect(page.getByTestId('status')).toHaveText('Black to move');
  });

  test('rejects illegal moves and moving the wrong colour', async ({ page }) => {
    await startGame(page);
    await play(page, 'e2e5');
    await expect(piece(page, 'e2')).toHaveCount(1);
    await expect(piece(page, 'e5')).toHaveCount(0);
    await play(page, 'e7e5'); // black cannot move first
    await expect(piece(page, 'e7')).toHaveCount(1);
    await expect(page.getByTestId('moves').locator('li')).toHaveCount(0);
  });

  test('drag and drop moves a piece', async ({ page }) => {
    await startGame(page);
    const from = await page.getByTestId('sq-d2').boundingBox();
    const to = await page.getByTestId('sq-d4').boundingBox();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(piece(page, 'd4')).toHaveAttribute('data-piece', 'wp');
    await expect(page.getByTestId('moves')).toContainText('d4');
  });

  test("fool's mate ends the game with a result dialog", async ({ page }) => {
    await startGame(page);
    await play(page, 'f2f3', 'e7e5', 'g2g4', 'd8h4');
    await expect(page.locator('.square.check')).toHaveAttribute('data-square', 'e1');
    await expect(page.getByTestId('modal-title')).toHaveText('Black wins');
    await expect(page.getByTestId('modal-body')).toHaveText('by checkmate');

    await page.getByTestId('rematch').click();
    await expect(page.locator('img.piece')).toHaveCount(32);
    await expect(page.getByTestId('moves').locator('li')).toHaveCount(0);
  });

  test('pawn promotion lets the player choose a piece', async ({ page }) => {
    await startGame(page);
    await play(page, 'h2h4', 'g7g5', 'h4g5', 'h7h6', 'g5h6', 'f8g7', 'h6g7', 'g8f6', 'g7h8');
    await expect(page.getByTestId('promotion')).toBeVisible();
    await page.getByTestId('promo-n').click();
    await expect(piece(page, 'h8')).toHaveAttribute('data-piece', 'wn');
    await expect(page.getByTestId('moves')).toContainText('gxh8=N');
  });

  test('flip turns the board around', async ({ page }) => {
    await startGame(page);
    await expect(page.locator('.square').first()).toHaveAttribute('data-square', 'a8');
    await page.getByTestId('flip').click();
    await expect(page.locator('.square').first()).toHaveAttribute('data-square', 'h1');
  });

  test('draw by agreement and resignation', async ({ page }) => {
    await startGame(page);
    await page.getByTestId('offer-draw').click();
    await page.getByTestId('accept-draw').click();
    await expect(page.getByTestId('modal-title')).toHaveText('Draw');
    await expect(page.getByTestId('modal-body')).toHaveText('Draw by agreement');

    await page.getByTestId('rematch').click();
    await page.getByTestId('resign').click();
    await page.getByTestId('confirm-resign').click();
    await expect(page.getByTestId('modal-title')).toHaveText('Black wins');
    await expect(page.getByTestId('modal-body')).toHaveText('by resignation');
  });

  test('leaving a game in progress asks for confirmation', async ({ page }) => {
    await startGame(page);
    await play(page, 'e2e4');
    await page.getByTestId('home').click();
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await page.getByTestId('home').click();
    await page.getByTestId('confirm-leave').click();
    await expect(page.getByTestId('start-game')).toBeVisible();
  });
});

test.describe('Clock', () => {
  test('counts down for the side to move', async ({ page }) => {
    await startGame(page, { time: '5+0' });
    await expect(page.getByTestId('clock-bottom')).toHaveText('5:00');
    await play(page, 'e2e4');
    await expect(page.getByTestId('clock-top')).toHaveClass(/active/);
    await expect(page.getByTestId('clock-top')).not.toHaveText('5:00', { timeout: 4_000 });
    await expect(page.getByTestId('clock-bottom')).toHaveText('5:00');
  });
});

test.describe('vs Computer', () => {
  test('the computer replies to your move', async ({ page }) => {
    await startGame(page, { mode: 'ai', level: 'easy', color: 'w' });
    await expect(page.getByTestId('status')).toHaveText('Your move');
    await play(page, 'e2e4');
    await expect(page.getByTestId('moves').locator('.san').nth(1)).not.toHaveText('', { timeout: 15_000 });
    await expect(page.getByTestId('status')).toHaveText('Your move', { timeout: 15_000 });
  });

  test('the computer moves first when you play Black', async ({ page }) => {
    await startGame(page, { mode: 'ai', level: 'easy', color: 'b' });
    await expect(page.locator('.square').first()).toHaveAttribute('data-square', 'h1');
    await expect(page.getByTestId('moves').locator('li')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('status')).toHaveText('Your move');
  });

  test("you cannot move the computer's pieces", async ({ page }) => {
    await startGame(page, { mode: 'ai', level: 'easy', color: 'w' });
    await play(page, 'e7e5');
    await expect(piece(page, 'e7')).toHaveCount(1);
  });

  test('the computer declines an early draw; resigning loses', async ({ page }) => {
    await startGame(page, { mode: 'ai', level: 'easy', color: 'w' });
    await page.getByTestId('offer-draw').click();
    await expect(page.getByTestId('toast')).toContainText('declines');
    await page.getByTestId('resign').click();
    await page.getByTestId('confirm-resign').click();
    await expect(page.getByTestId('modal-title')).toHaveText('You lost');
  });
});
