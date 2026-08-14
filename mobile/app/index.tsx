import { Redirect } from 'expo-router';

export default function Index() {
  // 单本地用户、无登录模式：直接进入主应用（(main) 分组，即日历首页）
  return <Redirect href="/(main)" />;
}