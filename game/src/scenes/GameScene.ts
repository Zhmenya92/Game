import Phaser from 'phaser';
import { BALANCE } from '../config/balance.ts';
import { Simulation } from '../sim/Simulation.ts';
import { InputTrace } from '../sim/InputTrace.ts';
import { selectVisible } from '../sim/Web.ts';
import { selectTarget } from '../sim/Targeting.ts';
import type { Segment } from '../sim/types.ts';

/**
 * Рендер. Арту немає — усе малюється кодом, як вимагає grey-box.
 * Але «без арту» не означає «нечитабельно»: гравець мусить з першого погляду
 * розуміти, за що він може зачепитися, куди летить і що його вбиває.
 *
 * Симуляція нічого не знає ні про Phaser, ні про розмір екрана — цього вимагає
 * детермінізм. Сцена тільки читає стан.
 */

const COL = {
  skyTop: 0x0a1420,
  skyBottom: 0x16323a,
  ground: 0x0a1a18,
  anchor: 0x8fa8a4,
  anchorLive: 0x4fd1bc,
  rope: 0xffffff,
  player: 0xffe9a8,
  trail: 0xffd166,
  ownWeb: 0xf0a24a,
  foreignWeb: 0x4fd1bc,
  chase: 0xd6455b,
};

export class GameScene extends Phaser.Scene {
  private sim!: Simulation;
  private trace!: InputTrace;
  private accumulator = 0;
  private pointerDown = false;
  private seed = 1;
  private day = 0;
  private best = 0;
  private deadAt = -1;

  private foreignWeb: Segment[] = [];
  private trail: { x: number; y: number }[] = [];

  private gSky!: Phaser.GameObjects.Graphics;
  private gWeb!: Phaser.GameObjects.Graphics;
  private gWorld!: Phaser.GameObjects.Graphics;
  private txtScore!: Phaser.GameObjects.Text;
  private txtSub!: Phaser.GameObjects.Text;
  private txtHint!: Phaser.GameObjects.Text;

  constructor() { super('game'); }

  create(): void {
    const w = BALANCE.viewWidth;
    const h = BALANCE.bandHeight;

    // Небо — статичний фон, малюється один раз і не рухається з камерою.
    this.gSky = this.add.graphics().setScrollFactor(0).setDepth(-10);
    this.gSky.fillGradientStyle(COL.skyTop, COL.skyTop, COL.skyBottom, COL.skyBottom, 1);
    this.gSky.fillRect(-w, -h, w * 3, h * 3);

    this.gWeb = this.add.graphics().setDepth(0);
    this.gWorld = this.add.graphics().setDepth(1);

    this.txtScore = this.add.text(w / 2, 54, '0', {
      fontFamily: 'ui-monospace, "SF Mono", monospace',
      fontSize: '96px', color: '#ffffff',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(20);

    this.txtSub = this.add.text(w / 2, 158, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '30px', color: '#8fa8a4',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(20);

    this.txtHint = this.add.text(w / 2, h * 0.62, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '40px',
      color: '#ffffff', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(20);

    const down = () => { this.pointerDown = true; };
    const up = () => { this.pointerDown = false; };
    this.input.on('pointerdown', down);
    this.input.on('pointerup', up);
    this.input.on('pointerupoutside', up);
    this.input.keyboard?.on('keydown-SPACE', down);
    this.input.keyboard?.on('keyup-SPACE', up);
    this.input.keyboard?.on('keydown-R', () => this.restart(this.seed + 1));

    this.cameras.main.setZoom(0.78);
    this.restart(1);
  }

  private restart(seed: number): void {
    // Павутина минулого рану стає «чужою»: так у тижні 1 перевіряється ідея К4
    // без бекенду — чужі лінії симулюються власним попереднім раном.
    if (this.sim && this.sim.ownWeb.length) {
      this.foreignWeb = selectVisible(
        this.foreignWeb.concat(
          this.sim.ownWeb.map(s => ({ ...s, ownerId: 1, bornDay: this.day })),
        ),
        BALANCE.foreignLineLimit,
      );
      this.day++;
    }
    if (seed !== this.seed) { this.foreignWeb = []; this.day = 0; }
    this.seed = seed;
    this.sim = new Simulation(seed, this.foreignWeb);
    this.trace = new InputTrace();
    this.accumulator = 0;
    this.deadAt = -1;
    this.trail.length = 0;
    this.bakeWeb();
  }

  /** Чужа павутина статична за ран — малюється один раз, а не щокадру. */
  private bakeWeb(): void {
    this.gWeb.clear();
    for (const s of this.foreignWeb) {
      this.gWeb.lineStyle(BALANCE.lineVisualWidth + 2, COL.foreignWeb, 0.16);
      this.gWeb.lineBetween(s.ax, s.ay, s.bx, s.by);
      this.gWeb.lineStyle(BALANCE.lineVisualWidth, COL.foreignWeb, 0.5);
      this.gWeb.lineBetween(s.ax, s.ay, s.bx, s.by);
    }
  }

  update(_t: number, delta: number): void {
    const s = this.sim.state;

    if (s.alive) {
      this.accumulator += Math.min(delta, 100) / 1000;
      let steps = 0;
      while (this.accumulator >= BALANCE.dt && steps < BALANCE.maxStepsPerFrame) {
        if (this.trace.isDownAt(s.frame) !== this.pointerDown) {
          this.trace.record(s.frame, this.pointerDown ? 'down' : 'up');
        }
        this.sim.step(this.pointerDown);
        this.accumulator -= BALANCE.dt;
        steps++;
        this.trail.push({ x: s.px, y: s.py });
        if (this.trail.length > 26) this.trail.shift();
        if (!s.alive) { this.deadAt = this.time.now; this.cameras.main.shake(160, 0.012); break; }
      }
    } else if (this.deadAt > 0 && this.time.now - this.deadAt > 900) {
      this.restart(this.seed);
    }

    const cam = this.cameras.main;
    cam.scrollX = s.px - (BALANCE.viewWidth / cam.zoom) * BALANCE.cameraPlayerX;
    cam.scrollY = s.py - (BALANCE.bandHeight / cam.zoom) * 0.5;

    this.draw();
  }

  private draw(): void {
    const s = this.sim.state;
    const g = this.gWorld;
    const H = BALANCE.bandHeight;
    g.clear();

    // Земля.
    g.fillStyle(COL.ground, 1);
    g.fillRect(s.px - 4000, H, 8000, 900);
    g.lineStyle(5, 0x2b4a46, 1);
    g.lineBetween(s.px - 4000, H, s.px + 4000, H);

    // Стіна, що наздоганяє — головна причина не висіти на місці.
    g.fillStyle(COL.chase, 0.22);
    g.fillRect(s.killX - 3000, -2000, 3000, H + 4000);
    g.lineStyle(8, COL.chase, 0.95);
    g.lineBetween(s.killX, -2000, s.killX, H + 2000);
    for (let i = 0; i < 14; i++) {
      const y = -300 + i * 130 + ((s.frame * 2) % 130);
      g.lineStyle(3, COL.chase, 0.35);
      g.lineBetween(s.killX - 90, y, s.killX, y + 60);
    }

    // Яка ціль зараз була б захоплена — це головна навчальна підказка гри.
    const live = s.attached
      ? null
      : selectTarget(s.px, s.py, this.sim.track.candidates(s.px), this.foreignWeb.concat(this.sim.ownWeb));

    // Анкери.
    const from = s.px - 900;
    const to = s.px + 1400;
    for (const a of this.sim.track.anchors) {
      if (a.x < from) continue;
      if (a.x > to) break;
      const isLive = !!live && live.kind === 'anchor' && live.x === a.x && live.y === a.y;
      if (isLive) {
        const pulse = 16 + Math.sin(s.frame * 0.12) * 4;
        g.lineStyle(4, COL.anchorLive, 0.9);
        g.strokeCircle(a.x, a.y, pulse + 10);
      }
      g.lineStyle(4, isLive ? COL.anchorLive : COL.anchor, isLive ? 1 : 0.75);
      g.strokeCircle(a.x, a.y, 14);
      g.fillStyle(isLive ? COL.anchorLive : COL.anchor, 1);
      g.fillCircle(a.x, a.y, 6);
    }

    // Власні лінії цього рану.
    for (const w of this.sim.ownWeb) {
      g.lineStyle(BALANCE.lineVisualWidth + 3, COL.ownWeb, 0.14);
      g.lineBetween(w.ax, w.ay, w.bx, w.by);
      g.lineStyle(BALANCE.lineVisualWidth, COL.ownWeb, 0.8);
      g.lineBetween(w.ax, w.ay, w.bx, w.by);
    }

    // Слід гравця — читабельність напрямку й швидкості.
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1], b = this.trail[i];
      const k = i / this.trail.length;
      g.lineStyle(2 + k * 7, COL.trail, k * 0.5);
      g.lineBetween(a.x, a.y, b.x, b.y);
    }

    // Трос.
    if (s.attached) {
      g.lineStyle(9, COL.rope, 0.25);
      g.lineBetween(s.ax, s.ay, s.px, s.py);
      g.lineStyle(4, COL.rope, 1);
      g.lineBetween(s.ax, s.ay, s.px, s.py);
      g.fillStyle(COL.anchorLive, 1);
      g.fillCircle(s.ax, s.ay, 9);
    } else if (live) {
      // Пунктир до цілі: показує, що станеться, якщо натиснути ЗАРАЗ.
      const dx = live.x - s.px, dy = live.y - s.py;
      const n = 9;
      for (let i = 0; i < n; i++) {
        if (i % 2) continue;
        g.lineStyle(3, COL.anchorLive, 0.5);
        g.lineBetween(s.px + (dx * i) / n, s.py + (dy * i) / n,
                      s.px + (dx * (i + 1)) / n, s.py + (dy * (i + 1)) / n);
      }
    }

    // Гравець.
    g.fillStyle(0x000000, 0.25);
    g.fillCircle(s.px, s.py + 4, 17);
    g.fillStyle(s.alive ? COL.player : COL.chase, 1);
    g.fillCircle(s.px, s.py, 15);
    g.lineStyle(3, 0xffffff, 0.9);
    g.strokeCircle(s.px, s.py, 15);

    // HUD.
    if (s.score > this.best) this.best = s.score;
    this.txtScore.setText(String(s.score));
    this.txtSub.setText(`рекорд ${this.best}    сід ${this.seed}    ліній ${this.sim.ownWeb.length + this.foreignWeb.length}`);

    if (!s.alive) {
      this.txtHint.setText('ТИ ВПАВ\nще раз');
    } else if (s.frame < 150 && !s.attached) {
      this.txtHint.setText('ТРИМАЙ ПАЛЕЦЬ — чіпляєшся\nВІДПУСТИ — летиш');
    } else {
      this.txtHint.setText('');
    }
  }
}
