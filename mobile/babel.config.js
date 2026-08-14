module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          // 显式禁用 reanimated / worklets 的 babel 插件，
          // 避免 babel-preset-expo 因检测到包已安装而自动注入，
          // 导致 Expo Go 运行时加载原生模块不匹配而闪退。
          reanimated: false,
          worklets: false,
        },
      ],
    ],
  };
};
