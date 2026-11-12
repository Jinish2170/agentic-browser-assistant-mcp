export const toolsets = {
  core: [
    'browser_capabilities',
    'browser_tabs',
    'browser_open',
    'browser_navigate',
    'browser_tab',
    'browser_snapshot',
    'browser_screenshot',
    'browser_extract',
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_press',
    'browser_scroll',
    'browser_wait',
    'browser_step',
    'browser_fill_form',
    'browser_batch',
  ],
  inspect: [
    'browser_accessibility',
    'browser_diagnostics',
    'browser_response',
    'browser_metrics',
    'browser_emulate',
  ],
  files: ['browser_downloads', 'browser_download', 'browser_upload'],
  workspace: [
    'browser_window',
    'browser_tab_manage',
    'browser_groups',
    'browser_group_tabs',
    'browser_group_update',
  ],
  interactions: ['browser_hover', 'browser_drag', 'browser_dialog'],
  advanced: ['browser_evaluate'],
};
export const toolsetNames = [...Object.keys(toolsets), 'all'];

export function initialToolsets(goal) {
  const categories = ['core'];
  if (/\b(debug|console|network|performance|accessibility|responsive)\b/i.test(goal))
    categories.push('inspect');
  if (/\b(download|upload|file|pdf|attachment|csv)\b/i.test(goal)) categories.push('files');
  if (/\b(group|window|pin|mute|tabs)\b/i.test(goal)) categories.push('workspace');
  if (/\b(drag|hover|dialog|alert|confirm|javascript)\b/i.test(goal))
    categories.push('interactions');
  return categories;
}

export function selectedToolNames(categories) {
  if (!categories || categories.includes('all')) return null;
  return new Set(categories.flatMap((category) => toolsets[category] || []));
}
