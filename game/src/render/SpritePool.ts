import Phaser from 'phaser';
import type { FrameName } from './frames.ts';
import type { Painter } from './Painter.ts';

/**
 * Пул спрайтів одного атласа.
 *
 * Навіщо. До тижня 5 усе малювалося через `Graphics` у режимі негайного
 * малювання: кожна зміна кольору чи товщини лінії — це скид пакета у
 * WebGL, тобто окремий виклик малювання. Технічний гейт плану (розділ 9) —
 * 1–2 виклики на сцену, і з `Graphics` він недосяжний у принципі.
 *
 * Спрайти з ОДНОГО атласа пакуються в один буфер, доки не змінюється
 * текстура. Тому все ігрове поле — фон, земля, стіна, анкери, троси, слід,
 * герой, частинки — малюється кадрами `atlas`, а не геометрією.
 *
 * Пул перевикористовує обʼєкти: створення й знищення сотні `Image` щокадру
 * дало б сміттєзбирач у мідл-андроїді, а не 60 кадрів.
 */
export class SpritePool implements Painter {
  readonly container: Phaser.GameObjects.Container;
  private readonly scene: Phaser.Scene;
  private readonly items: Phaser.GameObjects.Image[] = [];
  private used = 0;

  constructor(scene: Phaser.Scene, depth: number) {
    this.scene = scene;
    this.container = scene.add.container(0, 0).setDepth(depth);
  }

  /** Почати кадр. Лічильник назад, самі обʼєкти лишаються живими. */
  begin(): void {
    this.used = 0;
  }

  /** Сховати хвіст, що не знадобився цього кадру. */
  end(): void {
    for (let i = this.used; i < this.items.length; i++) {
      if (!this.items[i].visible) break;   // далі теж сховані
      this.items[i].setVisible(false);
    }
  }

  /**
   * Взяти спрайт. Усі властивості, що їх міг лишити попередній кадр
   * (кут, масштаб, тінт, прозорість, точка обертання), задаються тут явно —
   * інакше через перевикористання спрайт приїхав би з чужими значеннями.
   */
  private take(frame: FrameName): Phaser.GameObjects.Image {
    let img = this.items[this.used];
    if (!img) {
      img = this.scene.add.image(0, 0, 'atlas', frame);
      this.container.add(img);
      this.items.push(img);
    } else {
      img.setFrame(frame);
    }
    this.used++;
    img.setVisible(true);
    return img;
  }

  /**
   * Довільний кадр із явною точкою обертання. Базова операція: решта
   * методів — це вона з іншими аргументами.
   */
  quad(frame: FrameName, x: number, y: number, w: number, h: number,
       ox: number, oy: number, color = 0xffffff, alpha = 1, rotation = 0): void {
    const i = this.take(frame);
    i.setOrigin(ox, oy).setPosition(x, y).setRotation(rotation);
    i.setDisplaySize(w, h).setTint(color).setAlpha(alpha);
  }

  /** Прямокутник кадром `px`. Ним малюються всі заливки. */
  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
    this.quad('px', x, y, w, h, 0, 0, color, alpha);
  }

  /**
   * Лінія як розтягнутий спрайт. Кадр `rope` має мʼякий профіль упоперек,
   * тому лінія має згладжені краї — чого `Graphics.lineBetween` не дає.
   */
  line(x1: number, y1: number, x2: number, y2: number,
       width: number, color: number, alpha = 1): void {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) return;
    const i = this.take('rope');
    i.setOrigin(0, 0.5).setPosition(x1, y1).setRotation(Math.atan2(dy, dx));
    i.setDisplaySize(len, width).setTint(color).setAlpha(alpha);
  }

  /** Кадр із центром у точці. Кут і масштаб — для squash & stretch. */
  at(frame: FrameName, x: number, y: number, w: number, h: number,
     color = 0xffffff, alpha = 1, rotation = 0): void {
    const i = this.take(frame);
    i.setOrigin(0.5, 0.5).setPosition(x, y).setRotation(rotation);
    i.setDisplaySize(w, h).setTint(color).setAlpha(alpha);
  }

  /** Скільки спрайтів пішло цього кадру — для лічильника в HUD. */
  get count(): number {
    return this.used;
  }
}
