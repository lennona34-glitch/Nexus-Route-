import { buildApk } from '../dist/tools/registry.js';
import path from 'path';

// 1. Build a test app with multiple missing drawables and custom references
const mainActivity = `package com.nexus.robusttest;

import android.app.Activity;
import android.os.Bundle;
import android.widget.ImageView;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        
        ImageView iv = findViewById(R.id.heroImage);
        if (iv != null) {
            iv.setImageResource(R.drawable.player_sprite);
        }
    }
}`;

const layoutXml = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:gravity="center"
    android:background="@drawable/custom_stage_background">
    <ImageView
        android:id="@+id/heroImage"
        android:layout_width="120dp"
        android:layout_height="120dp"
        android:src="@drawable/bonus_coin" />
    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Robust Self-Healing Test"
        android:textColor="#38bdf8"
        android:textSize="20sp" />
</LinearLayout>`;

try {
  const res = buildApk({
    projectDir: path.resolve('workspace/android/RobustTestApp'),
    appName: 'RobustTestApp',
    packageName: 'com.nexus.robusttest',
    mainActivityCode: mainActivity,
    layoutXml: layoutXml
  });
  console.log('ROBUST BUILD TEST PASSED:', res);
} catch (e) {
  console.error('ROBUST BUILD TEST FAILED:', e.message);
}
