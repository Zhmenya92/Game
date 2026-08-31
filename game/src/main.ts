import Phaser from 'phaser';
import { BALANCE } from './config/balance.ts';
import { GameScene } from './scenes/GameScene.ts';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  backgroundColor: '#0b100f',
  scale: {
    // Вписування за шириною: на вужчих екранах видно більше по вертикалі,
    // і ніщо ігрове не ховається (бриф, розділ 2.1).
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: BALANCE.viewWidth,
    height: BALANCE.bandHeight,
  },
  scene: [GameScene],
});
