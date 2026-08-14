const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// 共享模块在 ./shared 目录下（项目内），Metro 自动解析，无需额外 watchFolders
// 注意：shared/ 目录已复制到 mobile 项目内，以支持 EAS 云端构建

module.exports = config;
