const $ = (id) => document.getElementById(id);

export function showView(name) {
  for (const button of document.querySelectorAll('[data-view]')) {
    const selected = button.dataset.view === name;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const view of document.querySelectorAll('[data-panel-view]'))
    view.hidden = view.dataset.panelView !== name;
  document.querySelector('main').scrollTop = 0;
  document.dispatchEvent(new CustomEvent('workspace-view', { detail: name }));
}

export async function initializeWorkspace(paired) {
  const { appearance = 'system' } = await chrome.storage.local.get('appearance');
  const prefersDark = matchMedia('(prefers-color-scheme: dark)');
  const applyAppearance = (value) => {
    document.documentElement.dataset.theme =
      value === 'system' ? (prefersDark.matches ? 'dark' : 'light') : value;
    $('theme-toggle').setAttribute(
      'aria-label',
      `Switch to ${document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'} appearance`,
    );
  };
  applyAppearance(appearance);
  $('theme-toggle').addEventListener('click', async () => {
    const value = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyAppearance(value);
    await chrome.storage.local.set({ appearance: value });
  });
  const buttons = [...document.querySelectorAll('[data-view]')];
  for (const button of buttons) {
    button.addEventListener('click', () => showView(button.dataset.view));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(button);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
      showView(buttons[next].dataset.view);
    });
  }
  for (const starter of document.querySelectorAll('[data-prompt]'))
    starter.addEventListener('click', () => {
      $('goal').value = starter.dataset.prompt;
      $('goal').focus();
    });
  $('show-activity').addEventListener('click', () => showView('activity'));
  $('setup-model').addEventListener('click', () => {
    showView('settings');
    $('settings').open = true;
    $('provider-model').focus();
  });
  $('goal').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!$('run').disabled) $('run').click();
    }
  });
  showView(paired ? 'chat' : 'settings');
}
