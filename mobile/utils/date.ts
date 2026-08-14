export function getToday(): { year: number; month: string; date: string; day: string; dateStr: string } {
  const now = new Date();
  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const dayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return {
    year: now.getFullYear(),
    month: monthNames[now.getMonth()],
    date: `${now.getDate()}日`,
    day: dayNames[now.getDay()],
    dateStr: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
  };
}

export function formatDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}