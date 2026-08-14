import { useEffect } from 'react';
import { Stack, useRouter, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppState, BackHandler } from 'react-native';
import { triggerFishboneExtract } from '../local/statistics';
import { refreshConfig } from '../core/modelService';
import { InsightProvider } from '../context/InsightContext';

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();

  // App 启动时主动加载本地模型配置（含恢复持久化的 Ollama 地址），
  // 避免每次重进都要先去设置页保存一次才能连上模型。
  useEffect(() => {
    refreshConfig().catch(() => {});
  }, []);

  // App 进入后台时触发鱼骨事件增量提取（fire-and-forget）
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        triggerFishboneExtract();
      }
    });
    return () => sub.remove();
  }, []);

  // 拦截 Android 系统返回键：非主页时正常返回，避免直接退出应用
  useEffect(() => {
    const backAction = () => {
      // 如果在主页（/(main) 即 /(main)/index），允许默认行为（退出应用）
      if (pathname === '/(main)' || pathname === '/(main)/index') {
        return false; // 不拦截，执行默认行为
      }
      // 其他页面：如果能返回就返回，不能返回则回到主页
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/(main)');
      }
      return true; // 拦截默认行为
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [router, pathname]);

  return (
    <SafeAreaProvider>
      <InsightProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(main)" />
        </Stack>
      </InsightProvider>
    </SafeAreaProvider>
  );
}