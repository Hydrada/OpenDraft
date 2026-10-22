/**
 * Dynamic stamp text: {date}, {time}, {datetime}, {author} and {page} are replaced when the stamp
 * is placed (like Revu/Acrobat dynamic stamps), so the stored markup keeps the resolved, auditable text.
 */
export function resolveStampText(text: string, context: { author: string; page: number; now?: Date }): string {
  const now = context.now ?? new Date(), pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return text.replace(/\{(date|time|datetime|author|page)\}/gi, (_, token: string) => {
    switch (token.toLowerCase()) {
      case 'date': return date;
      case 'time': return time;
      case 'datetime': return `${date} ${time}`;
      case 'author': return context.author.trim() || 'Unknown';
      default: return String(context.page);
    }
  });
}
