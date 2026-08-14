import { Slot } from 'expo-router';

export default function MainLayout() {
  // 使用 Slot 而非嵌套 Stack，避免双层 Stack 导致返回键直接退出应用的问题
  // 所有 (main) 组内的路由统一由根 Stack 管理
  return <Slot />;
}
