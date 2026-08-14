// ==========================================
// Atrium OS V1.0 — Electron 主进程
// 负责：启动 Python 后端、创建窗口、生命周期管理
// ==========================================

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

// ---- 配置 ----
const BACKEND_PORT = 8000;
const DEV_SERVER_URL = 'http://localhost:5173';

let mainWindow = null;
let backendProcess = null;
let isDev = false;

// ---- 后端路径探测 ----
function detectBackendPaths() {
  // 尝试多个候选路径
  const candidates = [
    // 1. 开发模式：从 electron/ 向上一级到 UI/，再向上一级到项目根
    path.join(__dirname, '..', '..', 'start_server.py'),
    // 2. 打包模式：resources/backend/
    path.join(process.resourcesPath, 'backend', 'start_server.py'),
  ];

  for (const scriptPath of candidates) {
    if (fs.existsSync(scriptPath)) {
      const rootDir = path.dirname(scriptPath);
      isDev = rootDir.includes('Atrium_OS_V1.0') && !rootDir.includes('resources');

      // 查找 Python：优先使用 venv 中的 Python
      let python = 'python'; // 默认走系统 PATH
      const venvPython = path.join(rootDir, 'venv', 'Scripts', 'python.exe');
      if (fs.existsSync(venvPython)) {
        python = venvPython;
      }

      console.log(`[Backend] 检测到项目根目录: ${rootDir}`);
      console.log(`[Backend] 模式: ${isDev ? '开发' : '发布'}`);
      console.log(`[Backend] Python: ${python}`);

      return { rootDir, python, script: scriptPath };
    }
  }

  throw new Error('找不到后端项目文件 (start_server.py)');
}

// ---- 后端管理 ----
function startBackend() {
  return new Promise((resolve, reject) => {
    let paths;
    try {
      paths = detectBackendPaths();
    } catch (err) {
      reject(err);
      return;
    }

    const { rootDir, python, script: backendScript } = paths;

    console.log(`[Backend] 启动: ${python} ${backendScript}`);

    try {
      backendProcess = spawn(python, [backendScript], {
        cwd: rootDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
        },
      });

      backendProcess.stdout.on('data', (data) => {
        console.log(`[Backend] ${data.toString().trim()}`);
      });

      backendProcess.stderr.on('data', (data) => {
        console.log(`[Backend] ${data.toString().trim()}`);
      });

      backendProcess.on('error', (err) => {
        console.error(`[Backend] 启动失败:`, err);
        reject(err);
      });

      backendProcess.on('exit', (code) => {
        console.log(`[Backend] 进程退出 (code=${code})`);
        backendProcess = null;
      });

      // 轮询等待后端就绪
      waitForBackend().then(resolve).catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

function waitForBackend(retries = 30, interval = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const req = http.get(`http://localhost:${BACKEND_PORT}/api/health`, (res) => {
        if (res.statusCode === 200) {
          console.log(`[Backend] 就绪 (尝试 ${attempts} 次)`);
          resolve();
        } else {
          retry();
        }
      });
      req.on('error', () => retry());
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (attempts >= retries) {
        reject(new Error('后端启动超时'));
      } else {
        setTimeout(check, interval);
      }
    };
    check();
  });
}

function stopBackend() {
  if (backendProcess) {
    console.log('[Backend] 正在关闭...');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', backendProcess.pid.toString(), '/f', '/t']);
    } else {
      backendProcess.kill('SIGTERM');
    }
    backendProcess = null;
  }
}

// ---- 窗口管理 ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Atrium OS',
    icon: path.join(__dirname, '..', 'public', 'favicon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
    backgroundColor: '#ffffff',
  });

  // 就绪后再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 加载页面
  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- 应用生命周期 ----
app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (err) {
    dialog.showErrorBox('启动失败', `后端服务启动失败:\n${err.message}\n\n请确保 Python 3.10+ 已安装并配置到 PATH。`);
    app.quit();
    return;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});