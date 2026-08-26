import { buildApk } from '../dist/tools/registry.js';
import path from 'path';

const mainActivity = `package com.nexus.discogame;

import android.app.Activity;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
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
    private DiscoView discoView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        discoView = new DiscoView(this);
        setContentView(discoView);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (discoView != null) discoView.resume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (discoView != null) discoView.pause();
    }

    static class Spark {
        float x, y, vx, vy, size;
        int color;
        int life;
    }

    static class DiscoView extends SurfaceView implements Runnable {
        private Thread gameThread;
        private volatile boolean isRunning;
        private SurfaceHolder holder;
        private Paint paint;
        private Random random;
        private ToneGenerator toneGen;

        private float rotationAngle = 0;
        private float discoEnergy = 100;
        private int score = 0;
        private int combo = 1;
        private ArrayList<Spark> sparks = new ArrayList<>();
        private int[] discoColors = {
            Color.rgb(255, 0, 128),  // Neon Pink
            Color.rgb(0, 255, 255),  // Electric Cyan
            Color.rgb(255, 255, 0),  // Bright Yellow
            Color.rgb(138, 43, 226), // Purple
            Color.rgb(0, 255, 128),  // Neon Green
            Color.rgb(255, 105, 180) // Hot Pink
        };
        private int[] discoTones = {
            ToneGenerator.TONE_DTMF_1, ToneGenerator.TONE_DTMF_3,
            ToneGenerator.TONE_DTMF_5, ToneGenerator.TONE_DTMF_7,
            ToneGenerator.TONE_DTMF_9, ToneGenerator.TONE_DTMF_A
        };

        public DiscoView(Context context) {
            super(context);
            holder = getHolder();
            paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            random = new Random();
            try {
                toneGen = new ToneGenerator(AudioManager.STREAM_MUSIC, 95);
            } catch (Exception e) {}
        }

        @Override
        public void run() {
            long lastTime = System.nanoTime();
            final double nsPerFrame = 1000000000.0 / 60.0;

            while (isRunning) {
                long now = System.nanoTime();
                if (now - lastTime >= nsPerFrame) {
                    lastTime = now;
                    updateState();
                    renderFrame();
                }
            }
        }

        private void updateState() {
            rotationAngle += 2.5f;
            if (rotationAngle >= 360) rotationAngle = 0;

            // Decay energy slightly over time
            discoEnergy = Math.max(10, discoEnergy - 0.05f);

            // Update spark particles
            for (int i = sparks.size() - 1; i >= 0; i--) {
                Spark s = sparks.get(i);
                s.x += s.vx;
                s.y += s.vy;
                s.life--;
                if (s.life <= 0) {
                    sparks.remove(i);
                }
            }
        }

        private void renderFrame() {
            if (!holder.getSurface().isValid()) return;
            Canvas canvas = holder.lockCanvas();
            if (canvas == null) return;

            int w = getWidth();
            int h = getHeight();

            // 1. Dark Club Background with Dynamic Ambient Light
            canvas.drawColor(Color.rgb(10, 5, 20));

            // 2. Animated Checkerboard Disco Floor
            int cols = 6;
            int rows = 5;
            float tileW = (float) w / cols;
            float floorY = h * 0.65f;
            float tileH = (h - floorY) / rows;

            for (int r = 0; r < rows; r++) {
                for (int c = 0; c < cols; c++) {
                    int colIndex = (c + r + (int)(rotationAngle / 30)) % discoColors.length;
                    paint.setColor(discoColors[colIndex]);
                    paint.setAlpha(60 + (int)(Math.sin((rotationAngle + c * 40) * Math.PI / 180) * 40));
                    canvas.drawRect(c * tileW, floorY + r * tileH, (c + 1) * tileW - 2, floorY + (r + 1) * tileH - 2, paint);
                }
            }

            // 3. Disco Light Beams from Ceiling
            float ballX = w / 2.0f;
            float ballY = 160.0f;
            float ballRadius = 65.0f;

            for (int beam = 0; beam < 8; beam++) {
                float beamAngle = rotationAngle + beam * 45;
                float rad = (float) Math.toRadians(beamAngle);
                float endX = ballX + (float) Math.cos(rad) * w * 1.2f;
                float endY = ballY + (float) Math.sin(rad) * h;

                paint.setColor(discoColors[beam % discoColors.length]);
                paint.setAlpha(45);
                paint.setStrokeWidth(18.0f);
                canvas.drawLine(ballX, ballY, endX, endY, paint);
            }

            // 4. Rotating Disco Mirror Ball
            // Chain hanger
            paint.setColor(Color.rgb(200, 200, 210));
            paint.setStrokeWidth(4.0f);
            canvas.drawLine(ballX, 0, ballX, ballY - ballRadius, paint);

            // Ball base sphere
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(Color.rgb(180, 185, 200));
            canvas.drawCircle(ballX, ballY, ballRadius, paint);

            // Mirrored Facets
            int facetRows = 7;
            int facetCols = 10;
            for (int fr = 0; fr < facetRows; fr++) {
                float fy = ballY - ballRadius + (fr + 0.5f) * (2 * ballRadius / facetRows);
                float rowDist = Math.abs(fy - ballY);
                float rowWidth = (float) Math.sqrt(Math.max(0, ballRadius * ballRadius - rowDist * rowDist)) * 1.8f;

                for (int fc = 0; fc < facetCols; fc++) {
                    float fxOffset = (float) Math.sin(Math.toRadians(rotationAngle * 1.5f + fc * (360.0f / facetCols))) * (rowWidth / 2);
                    float fx = ballX + fxOffset;
                    int shine = (int)(Math.abs(Math.cos(Math.toRadians(rotationAngle * 2 + fc * 30 + fr * 20))) * 255);
                    paint.setColor(Color.rgb(shine, shine, Math.min(255, shine + 40)));
                    canvas.drawRect(fx - 4, fy - 4, fx + 4, fy + 4, paint);
                }
            }

            // 5. Render Spark Particles
            for (Spark s : sparks) {
                paint.setColor(s.color);
                paint.setAlpha(Math.min(255, s.life * 10));
                canvas.drawCircle(s.x, s.y, s.size, paint);
            }

            // 6. HUD - Retro Disco Banner & Score
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(Color.argb(180, 15, 10, 30));
            canvas.drawRect(0, 0, w, 90, paint);

            paint.setColor(Color.rgb(255, 0, 128));
            paint.setTextSize(32);
            paint.setFakeBoldText(true);
            canvas.drawText("🪩 DISCO FEVER (60 FPS)", 24, 48, paint);

            paint.setColor(Color.rgb(0, 255, 255));
            paint.setTextSize(22);
            paint.setFakeBoldText(false);
            canvas.drawText("TAP THE FLOOR TO DANCE!", 24, 78, paint);

            paint.setColor(Color.rgb(255, 255, 0));
            paint.setTextSize(28);
            paint.setFakeBoldText(true);
            canvas.drawText("SCORE: " + score, w - 180, 56, paint);

            holder.unlockCanvasAndPost(canvas);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            if (event.getAction() == MotionEvent.ACTION_DOWN || event.getAction() == MotionEvent.ACTION_MOVE) {
                float tx = event.getX();
                float ty = event.getY();

                score += 10 * combo;
                discoEnergy = Math.min(100, discoEnergy + 5);

                // Play synth tone
                int toneIdx = random.nextInt(discoTones.length);
                if (toneGen != null) {
                    toneGen.startTone(discoTones[toneIdx], 80);
                }

                // Spawn burst of sparks
                for (int i = 0; i < 14; i++) {
                    Spark s = new Spark();
                    s.x = tx;
                    s.y = ty;
                    float angle = (float) (random.nextFloat() * Math.PI * 2);
                    float speed = 4.0f + random.nextFloat() * 8.0f;
                    s.vx = (float) Math.cos(angle) * speed;
                    s.vy = (float) Math.sin(angle) * speed;
                    s.size = 6.0f + random.nextFloat() * 8.0f;
                    s.color = discoColors[random.nextInt(discoColors.length)];
                    s.life = 20 + random.nextInt(15);
                    sparks.add(s);
                }
            }
            return true;
        }

        public void resume() {
            isRunning = true;
            gameThread = new Thread(this);
            gameThread.start();
        }

        public void pause() {
            isRunning = false;
            try {
                if (gameThread != null) gameThread.join();
            } catch (InterruptedException e) {}
        }
    }
}
`;

try {
  const result = buildApk({
    projectDir: path.resolve('workspace/android/DiscoGame'),
    appName: 'DiscoGame',
    packageName: 'com.nexus.discogame',
    mainActivityCode: mainActivity
  });
  console.log('DISCO GAME BUILD SUCCESSFUL:', result);
} catch (err) {
  console.error('DISCO GAME BUILD FAILED:', err.message);
  if (err.stdout) console.log('STDOUT:', err.stdout.toString());
  if (err.stderr) console.log('STDERR:', err.stderr.toString());
}
