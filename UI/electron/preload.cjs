// ==========================================
// Atrium OS V1.0 — Electron Preload 脚本
// 安全地在渲染进程和主进程之间桥接 API
// ==========================================

const { contextBridge } = require('electron');

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
});