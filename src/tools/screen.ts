import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function captureDesktopScreen(outputPath: string): Promise<{ success: boolean; width: number; height: number; path: string; dataUrl?: string; error?: string }> {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${outputPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
Write-Output "$($bounds.Width)x$($bounds.Height)"
`;

  try {
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execAsync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`);
    const parts = (stdout || '').trim().split('x');
    const width = parseInt(parts[0]) || 1920;
    const height = parseInt(parts[1]) || 1080;

    let dataUrl: string | undefined;
    if (fs.existsSync(outputPath)) {
      const buf = fs.readFileSync(outputPath);
      dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    }

    return { success: true, width, height, path: outputPath, dataUrl };
  } catch (err: unknown) {
    return { success: false, width: 0, height: 0, path: outputPath, error: (err as Error).message };
  }
}
