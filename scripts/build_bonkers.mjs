import { buildApk } from '../dist/tools/registry.js';
import path from 'path';

const mainActivity = `package com.nexus.bonkers;

import android.app.Activity;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.Window;
import android.view.WindowManager;
import java.util.ArrayList;
import java.util.Random;

public class MainActivity extends Activity {
    private GameView gameView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        gameView = new GameView(this);
        setContentView(gameView);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (gameView != null) gameView.resume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (gameView != null) gameView.pause();
    }

    static class Item {
        float x, y, speed, size;
        int type; // 0 = Good item, 1 = Hazard
        int color;
    }

    static class GameView extends SurfaceView implements Runnable {
        private Thread gameThread;
        private volatile boolean isPlaying;
        private SurfaceHolder holder;
        private Paint paint;
        private Random random;
        private ToneGenerator toneGen;

        // Game State
        private int currentSeason = 0; // 0: Spring, 1: Summer, 2: Autumn, 3: Winter
        private final String[] seasonNames = {"🌸 SPRING IN COTSWOLDS", "☀️ SUMMER AT BRIGHTON", "🍂 AUTUMN IN LONDON", "❄️ WINTER AT BIG BEN"};
        private int score = 0;
        private int targetScore = 15;
        private float playerX = 300, playerY = 900;
        private float playerWidth = 140, playerHeight = 70;
        private ArrayList<Item> items = new ArrayList<>();
        private long lastSpawnTime = 0;

        public GameView(Context context) {
            super(context);
            holder = getHolder();
            paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            random = new Random();
            try {
                toneGen = new ToneGenerator(AudioManager.STREAM_MUSIC, 90);
            } catch (Exception e) {}
        }

        @Override
        public void run() {
            long lastTime = System.nanoTime();
            final double nsPerFrame = 1000000000.0 / 60.0;

            while (isPlaying) {
                long now = System.nanoTime();
                if (now - lastTime >= nsPerFrame) {
                    lastTime = now;
                    updatePhysics();
                    drawFrame();
                }
            }
        }

        private void updatePhysics() {
            int w = getWidth();
            int h = getHeight();
            if (w == 0 || h == 0) return;

            playerY = h - 160;

            // Spawn items
            long timeNow = System.currentTimeMillis();
            if (timeNow - lastSpawnTime > 650) {
                lastSpawnTime = timeNow;
                Item item = new Item();
                item.x = 40 + random.nextInt(Math.max(w - 80, 100));
                item.y = -40;
                item.speed = 6.0f + currentSeason * 2.0f + random.nextFloat() * 4.0f;
                item.size = 28.0f + random.nextFloat() * 12.0f;
                item.type = (random.nextFloat() > 0.25f) ? 0 : 1; // 75% collectibles

                // Color themes per season
                if (currentSeason == 0) item.color = (item.type == 0) ? Color.rgb(255, 182, 193) : Color.rgb(255, 215, 0); // Blossoms & Bees
                else if (currentSeason == 1) item.color = (item.type == 0) ? Color.rgb(255, 99, 71) : Color.rgb(220, 220, 220); // Strawberries & Seagulls
                else if (currentSeason == 2) item.color = (item.type == 0) ? Color.rgb(255, 140, 0) : Color.rgb(65, 105, 225); // Golden leaves & Rain puddles
                else item.color = (item.type == 0) ? Color.rgb(240, 248, 255) : Color.rgb(176, 196, 222); // Crystal snow

                items.add(item);
            }

            // Move & check collisions
            for (int i = items.size() - 1; i >= 0; i--) {
                Item item = items.get(i);
                item.y += item.speed;

                // Check collision with Player's British Double Decker Bus
                if (item.y + item.size >= playerY && item.y - item.size <= playerY + playerHeight) {
                    if (item.x + item.size >= playerX - playerWidth / 2 && item.x - item.size <= playerX + playerWidth / 2) {
                        if (item.type == 0) {
                            score++;
                            if (toneGen != null) toneGen.startTone(ToneGenerator.TONE_CDMA_PIP, 60);
                            if (score >= targetScore) {
                                score = 0;
                                currentSeason = (currentSeason + 1) % 4;
                                if (toneGen != null) toneGen.startTone(ToneGenerator.TONE_CDMA_HIGH_L, 250);
                            }
                        } else {
                            score = Math.max(0, score - 2);
                            if (toneGen != null) toneGen.startTone(ToneGenerator.TONE_CDMA_SOFT_ERROR_LITE, 100);
                        }
                        items.remove(i);
                        continue;
                    }
                }

                if (item.y > h + 50) {
                    items.remove(i);
                }
            }
        }

        private void drawFrame() {
            if (!holder.getSurface().isValid()) return;
            Canvas canvas = holder.lockCanvas();
            if (canvas == null) return;

            int w = getWidth();
            int h = getHeight();

            // Background Season Sky Gradient
            if (currentSeason == 0) canvas.drawColor(Color.rgb(240, 253, 244)); // Spring fresh green/white
            else if (currentSeason == 1) canvas.drawColor(Color.rgb(224, 242, 254)); // Summer ocean blue
            else if (currentSeason == 2) canvas.drawColor(Color.rgb(254, 243, 199)); // Autumn warm amber
            else canvas.drawColor(Color.rgb(15, 23, 42)); // Winter dark night blue

            // Draw Falling Items
            for (Item item : items) {
                paint.setColor(item.color);
                if (item.type == 0) {
                    canvas.drawCircle(item.x, item.y, item.size, paint);
                } else {
                    paint.setStyle(Paint.Style.STROKE);
                    paint.setStrokeWidth(6.0f);
                    canvas.drawCircle(item.x, item.y, item.size, paint);
                    paint.setStyle(Paint.Style.FILL);
                }
            }

            // Draw British Red Double Decker Bus (Player)
            paint.setColor(Color.rgb(220, 38, 38)); // British Post Office Red
            RectF busBody = new RectF(playerX - playerWidth / 2, playerY, playerX + playerWidth / 2, playerY + playerHeight);
            canvas.drawRoundRect(busBody, 14, 14, paint);

            // Bus Windows
            paint.setColor(Color.rgb(241, 245, 249));
            float winW = 24, winH = 20;
            for (int wi = 0; wi < 3; wi++) {
                float wx = playerX - playerWidth / 2 + 14 + wi * 38;
                canvas.drawRect(wx, playerY + 8, wx + winW, playerY + 8 + winH, paint);
                canvas.drawRect(wx, playerY + 36, wx + winW, playerY + 36 + winH, paint);
            }

            // Bus Wheels
            paint.setColor(Color.rgb(15, 23, 42));
            canvas.drawCircle(playerX - playerWidth / 3, playerY + playerHeight + 4, 12, paint);
            canvas.drawCircle(playerX + playerWidth / 3, playerY + playerHeight + 4, 12, paint);

            // Draw HUD & Score Banner
            paint.setColor(Color.rgb(15, 23, 42));
            canvas.drawRect(0, 0, w, 110, paint);

            paint.setColor(Color.rgb(251, 191, 36));
            paint.setTextSize(36);
            paint.setFakeBoldText(true);
            canvas.drawText("🇬🇧 BONKERS: 60 FPS", 30, 52, paint);

            paint.setColor(Color.rgb(56, 189, 248));
            paint.setTextSize(26);
            paint.setFakeBoldText(false);
            canvas.drawText(seasonNames[currentSeason], 30, 92, paint);

            paint.setColor(Color.rgb(255, 255, 255));
            paint.setTextSize(32);
            paint.setFakeBoldText(true);
            canvas.drawText("SCORE: " + score + " / " + targetScore, w - 240, 68, paint);

            holder.unlockCanvasAndPost(canvas);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            if (event.getAction() == MotionEvent.ACTION_MOVE || event.getAction() == MotionEvent.ACTION_DOWN) {
                playerX = Math.max(playerWidth / 2, Math.min(getWidth() - playerWidth / 2, event.getX()));
            }
            return true;
        }

        public void resume() {
            isPlaying = true;
            gameThread = new Thread(this);
            gameThread.start();
        }

        public void pause() {
            isPlaying = false;
            try {
                if (gameThread != null) gameThread.join();
            } catch (InterruptedException e) {}
        }
    }
}
`;

try {
  const res = buildApk({
    projectDir: path.resolve('workspace/android/Bonkers'),
    appName: 'Bonkers',
    packageName: 'com.nexus.bonkers',
    mainActivityCode: mainActivity
  });
  console.log('BONKERS APK BUILD SUCCESSFUL:', res);
} catch (err) {
  console.error('BONKERS APK BUILD FAILED:', err.message);
  if (err.stdout) console.log('STDOUT:', err.stdout.toString());
  if (err.stderr) console.log('STDERR:', err.stderr.toString());
}
