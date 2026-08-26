import { buildApk } from '../dist/tools/registry.js';
import fs from 'fs';
import path from 'path';

const projectDir = path.resolve('workspace/android/BananaBoy');
const mainActivityPath = path.join(projectDir, 'src/com/nexus/bananaboy/MainActivity.java');
const layoutPath = path.join(projectDir, 'res/layout/activity_main.xml');

const mainCode = fs.readFileSync(mainActivityPath, 'utf8');
const layoutXml = fs.existsSync(layoutPath) ? fs.readFileSync(layoutPath, 'utf8') : undefined;

console.log('Building BananaBoy APK right now...');
const result = buildApk({
  projectDir,
  appName: 'BananaBoy',
  packageName: 'com.nexus.bananaboy',
  mainActivityCode: mainCode,
  layoutXml
});

console.log('BUILD RESULT:', result);
const stat = fs.statSync(result.apkPath);
console.log('NEW APK TIMESTAMP:', stat.mtime.toISOString(), 'SIZE:', stat.size);
