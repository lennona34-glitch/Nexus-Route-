import { buildApk } from '../dist/tools/registry.js';
import path from 'path';

const mainActivity = `package com.nexus.tappiano;

import android.app.Activity;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private ToneGenerator toneGen;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        try {
            toneGen = new ToneGenerator(AudioManager.STREAM_MUSIC, 100);
        } catch (Exception e) {}

        int[] tones = {ToneGenerator.TONE_DTMF_1, ToneGenerator.TONE_DTMF_2, ToneGenerator.TONE_DTMF_3, ToneGenerator.TONE_DTMF_4, ToneGenerator.TONE_DTMF_5};
        String[] notes = {"C", "D", "E", "F", "G"};
        int[] btnIds = {R.id.btn1, R.id.btn2, R.id.btn3, R.id.btn4, R.id.btn5};

        for (int i = 0; i < btnIds.length; i++) {
            final int idx = i;
            Button btn = findViewById(btnIds[i]);
            if (btn != null) {
                btn.setOnClickListener(v -> {
                    if (toneGen != null) toneGen.startTone(tones[idx], 150);
                    Toast.makeText(MainActivity.this, "Played Note " + notes[idx], Toast.LENGTH_SHORT).show();
                });
            }
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
    android:padding="20dp">
    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="🎹 TapPiano Mobile Synth"
        android:textColor="#38bdf8"
        android:textSize="22sp"
        android:textStyle="bold"
        android:layout_marginBottom="24dp" />
    <Button android:id="@+id/btn1" android:layout_width="200dp" android:layout_height="50dp" android:text="KEY C" android:layout_marginBottom="10dp" />
    <Button android:id="@+id/btn2" android:layout_width="200dp" android:layout_height="50dp" android:text="KEY D" android:layout_marginBottom="10dp" />
    <Button android:id="@+id/btn3" android:layout_width="200dp" android:layout_height="50dp" android:text="KEY E" android:layout_marginBottom="10dp" />
    <Button android:id="@+id/btn4" android:layout_width="200dp" android:layout_height="50dp" android:text="KEY F" android:layout_marginBottom="10dp" />
    <Button android:id="@+id/btn5" android:layout_width="200dp" android:layout_height="50dp" android:text="KEY G" />
</LinearLayout>`;

try {
  const result = buildApk({
    projectDir: path.resolve('workspace/android/TapPiano'),
    appName: 'TapPiano',
    packageName: 'com.nexus.tappiano',
    mainActivityCode: mainActivity,
    layoutXml: layoutXml
  });
  console.log('TAP PIANO BUILD SUCCESS:', result);
} catch (err) {
  console.error('TAP PIANO BUILD ERROR:', err.message);
}
