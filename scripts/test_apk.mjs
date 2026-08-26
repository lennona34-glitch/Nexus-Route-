import { buildApk } from '../dist/tools/registry.js';
import path from 'path';

const mainActivity = `package com.nexus.orbitsynth;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;
import android.media.ToneGenerator;
import android.media.AudioManager;

public class MainActivity extends Activity {
    private ToneGenerator toneGen;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        toneGen = new ToneGenerator(AudioManager.STREAM_MUSIC, 100);
        Button playBtn = (Button) findViewById(R.id.playBtn);
        if (playBtn != null) {
            playBtn.setOnClickListener(v -> {
                toneGen.startTone(ToneGenerator.TONE_CDMA_PIP, 200);
                Toast.makeText(MainActivity.this, "OrbitSynth Tone Played!", Toast.LENGTH_SHORT).show();
            });
        }
    }
}`;

const layoutXml = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:gravity="center"
    android:background="#0f172a"
    android:padding="24dp">
    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="OrbitSynth Audio Synthesizer"
        android:textColor="#38bdf8"
        android:textSize="22sp"
        android:textStyle="bold"
        android:layout_marginBottom="20dp" />
    <Button
        android:id="@+id/playBtn"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="PLAY SYNTH TONE"
        android:textSize="16sp"
        android:textColor="#ffffff" />
</LinearLayout>`;

try {
  const result = buildApk({
    projectDir: path.resolve('workspace/android/OrbitSynth'),
    appName: 'OrbitSynth',
    packageName: 'com.nexus.orbitsynth',
    mainActivityCode: mainActivity,
    layoutXml: layoutXml
  });
  console.log('BUILD SUCCESSFUL:', result);
} catch (err) {
  console.error('BUILD FAILED:', err.message);
  if (err.stdout) console.log('STDOUT:', err.stdout.toString());
  if (err.stderr) console.log('STDERR:', err.stderr.toString());
}
