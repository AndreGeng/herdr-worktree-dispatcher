export function trimTrailingWhitespace(value: string): string {
  return value.replace(/[\s]+$/g, '');
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return (slug || 'task').slice(0, 48);
}

export function labelFromTask(value: string): string {
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'to',
    'in',
    'of',
    'and',
    'or',
    'for',
    'with',
    'from',
    'this',
    'that',
    'please',
    'can',
    'you',
    'my',
    'current',
    'project',
    'repo',
    'code',
    'file',
    'line',
    'lines',
    'worktree',
    'dispatcher',
    'dispatch',
    'leader',
    'agent',
    'team',
    'shared',
    'role',
    'worker',
    'merge',
    'token',
    'profile',
  ]);
  const cleanedValue = value
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/[`"']/g, ' ');
  const tokens: string[] = [];
  for (const rawToken of cleanedValue.split(/\s+/)) {
    let token = rawToken.split('/').pop() ?? rawToken;
    token = token.split(':')[0] ?? token;
    token = token.split('#')[0] ?? token;
    token = token.replace(/\.(md|txt|tsx?|jsx?|sh|py|go|rs|json|toml|ya?ml|s?css|html)$/i, '');
    const normalized = token.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
    if (!normalized || /^\d+$/.test(normalized) || stopWords.has(normalized)) {
      continue;
    }
    tokens.push(normalized);
    if (tokens.length >= 5) {
      break;
    }
  }
  return (tokens.join('-') || slugify(value)).slice(0, 48);
}

export function branchSuffix(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function timestamp(): string {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}
