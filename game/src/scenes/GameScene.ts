import Phaser from 'phaser';
import { BALANCE } from '../config/balance.ts';
import { Simulation } from '../sim/Simulation.ts';
import { InputTrace } from '../sim/InputTrace.ts';
import { selectVisible } from '../sim/Web.ts';
import type { Segment } from '../sim/types.ts';

/**
 * Grey-box рендер. Жодного арту — прямокутники й лінії, як вимагає гейт 1.
 *
 * Рендер відокремлений від симуляції повністю: сцена лише читає стан.
 * Симуляція не знає ні про Phaser, ні про розмір екрана — цього вимагає
 * детермінізм (бриф, розділ 2.1).
 */
export class GameScene extends Phaser.Scene {
  private sim!: Simulation;
  private trace!: InputTrace;
  private accumulator = 0;
  private pointerDown = false;
  private seed = 1;
  private day = 0;

  /** Павутина попереднього рану — у тижні 1 «чужа» павутина це твоя ж. */
  private foreignWeb: Segment[] = [];

  private gWeb!: Phaser.GameObjects.Graphics;
  private gDyn!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;

  constructor() {
    super('game');
  }

  create(): void {
    this.gWeb = this.add.graphics();
    this.gDyn = this.add.graphics();

    this.hud = this.add.text(16, 16, '', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '26px',
      color: '#e6edeb',
    }).setScrollFactor(0).setDepth(10);

    this.input.on('pointerdown', () => { this.pointerDown = true; });
    this.input.on('pointerup', () => { this.pointerDown = false; });
    this.input.keyboard?.on('keydown-SPACE', () => { this.pointerDown = true; });
    this.input.keyboard?.on('keyup-SPACE', () => { this.pointerDown = false; });
    this.input.keyboard?.on('keydown-R', () => this.restart(this.seed + 1));

    this.restart(this.seed);
  }

  private restart(seed: number): void {
    // Павутина минулого рану переїжджає в «чужу» — так у тижні 1 перевіряється
    // ідея К4 без бекенду: чужі лінії симулюються власним попереднім раном.
    if (this.sim) {
      this.foreignWeb = selectVisible(
        this.foreignWeb.concat(
          this.sim.ownWeb.map(s => ({ ...s, ownerId: 1, bornDay: this.day })),
        ),
        BALANCE.foreignLineLimit,
      );
      this.day++;
    }
    this.seed = seed;
    this.sim = new Simulation(seed, this.foreignWeb);
    this.trace = new InputTrace();
    this.accumulator = 0;
    this.bakeWeb();
  }

  /**
   * Запікання статичної павутини (бриф, розділ 8).
   * Чужі лінії не змінюються за ран, тому малюються один раз, а не щокадру:
   * лінія в Graphics під WebGL спричиняє скидання батча.
   */
  private bakeWeb(): void {
    this.gWeb.clear();
    this.gWeb.lineStyle(BALANCE.lineVisualWidth, 0x4fd1bc, 0.45);
    for (const s of this.foreignWeb) {
      this.gWeb.lineBetween(s.ax, s.ay, s.bx, s.by);
    }
  }

  update(_time: number, delta: number): void {
    const s = this.sim.state;

    // Акумулятор: рендер виробляє час, симуляція споживає фіксованими порціями.
    this.accumulator += delta / 1000;
    let steps = 0;
    while (this.accumulator >= BALANCE.dt && steps < BALANCE.maxStepsPerFrame) {
      const before = this.sim.ownWeb.length;
      const wasDown = this.trace.isDownAt(s.frame);
      if (wasDown !== this.pointerDown) {
        this.trace.record(s.frame, this.pointerDown ? 'down' : 'up');
      }
      this.sim.step(this.pointerDown);
      if (this.sim.ownWeb.length !== before) { /* нова лінія — перемалюємо нижче */ }
      this.accumulator -= BALANCE.dt;
      steps++;
      if (!s.alive) break;
    }
    if (this.accumulator > BALANCE.dt * BALANCE.maxStepsPerFrame) this.accumulator = 0;

    // Камера: гравець на 35 % ширини. Камера НЕ входить у симуляцію.
    this.cameras.main.scrollX = s.px - BALANCE.viewWidth * BALANCE.cameraPlayerX;
    this.cameras.main.scrollY = 0;

    this.draw();

    if (!s.alive) {
      this.time.delayedCall(350, () => this.restart(this.seed));
    }
  }

  private draw(): void {
    const s = this.sim.state;
    const g = this.gDyn;
    g.clear();

    // Смуга смерті ліворуч, що наздоганяє.
    g.fillStyle(0x9b2c2c, 0.35);
    g.fillRect(s.killX - 2000, 0, 2000, BALANCE.bandHeight);
    g.lineStyle(4, 0xe08585, 0.9);
    g.lineBetween(s.killX, 0, s.killX, BALANCE.bandHeight);

    // Підлога.
    g.lineStyle(2, 0x26302e, 1);
    g.lineBetween(s.px - 1200, BALANCE.bandHeight, s.px + 1200, BALANCE.bandHeight);

    // Анкери в полі зору.
    const from = s.px - BALANCE.viewWidth;
    const to = s.px + BALANCE.viewWidth * 1.5;
    this.sim.track.ensureUpTo(to);
    g.fillStyle(0xdcdcdc, 1);
    for (const a of this.sim.track.anchors) {
      if (a.x < from || a.x > to) continue;
      g.fillCircle(a.x, a.y, 9);
      g.fillStyle(0x0f5c52, 1);
      g.fillCircle(a.x, a.y, 4);
      g.fillStyle(0xdcdcdc, 1);
    }

    // Власні лінії цього рану.
    g.lineStyle(BALANCE.lineVisualWidth, 0xf0c674, 0.8);
    for (const w of this.sim.ownWeb) g.lineBetween(w.ax, w.ay, w.bx, w.by);

    // Активний трос.
    if (s.attached) {
      g.lineStyle(4, 0xffffff, 1);
      g.lineBetween(s.ax, s.ay, s.px, s.py);
    }

    // Гравець — прямокутник, як і має бути в grey-box.
    g.fillStyle(s.alive ? 0xffffff : 0xe08585, 1);
    g.fillRect(s.px - 11, s.py - 11, 22, 22);

    const secs = (s.frame * BALANCE.dt).toFixed(1);
    this.hud.setText(
      `сід ${this.seed}   рахунок ${s.score}   ${secs} с\n` +
      `ліній: свої ${this.sim.ownWeb.length}  чужі ${this.foreignWeb.length}\n` +
      `${s.attached ? 'на тросі' : 'у польоті'}   R — новий сід`,
    );
  }
}
