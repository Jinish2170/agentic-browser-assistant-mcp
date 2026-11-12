// Only the current user's explicit opening instruction is eligible. Never page data or memory.
export function startupTarget(goal) {
  const opening = String(goal)
    .trim()
    .match(/^(?:(?:please|now)\s+)*(?:open|visit|navigate\s+to|go\s+to)\s+(?:the\s+)?(.+)$/i);
  if (!opening) return null;
  const target = opening[1];
  const literal = target.match(/^(https?:\/\/[^\s<>"`]+)(?:\s|$)/i);
  if (literal) {
    try {
      const url = new URL(literal[1]);
      if (url.username || url.password) return null;
      return { url: url.href, label: url.hostname, onlyOpen: target === literal[1] };
    } catch {
      return null;
    }
  }
  if (/^nvidia\s+(?:nim\s+)?dashboard(?=\s|[,.]|$)/i.test(target))
    return {
      url: 'https://build.nvidia.com/settings/api-keys',
      label: 'NVIDIA NIM',
      onlyOpen: false,
    };
  return null;
}
