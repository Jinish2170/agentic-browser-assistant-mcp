// Runs in Chrome's isolated world. It must be self-contained for executeScript.
export function pageOperation(operation, args) {
  const stateKey = '__jevBrowserDOM_v1';
  const styleCache = new WeakMap();
  const computedStyle = (el) => {
    if (!styleCache.has(el)) styleCache.set(el, getComputedStyle(el));
    return styleCache.get(el);
  };
  let rootCache;
  function roots() {
    if (rootCache) return rootCache;
    const result = [document];
    for (let i = 0; i < result.length; i++)
      for (const el of result[i].querySelectorAll('*'))
        if (el.shadowRoot) result.push(el.shadowRoot);
    return (rootCache = result);
  }
  function descendantOf(el, ancestor) {
    for (let node = el; node; node = node.parentElement || node.getRootNode()?.host)
      if (node === ancestor) return true;
    return false;
  }
  function scopedElements(scope, query) {
    const scopedRoots = [
      scope,
      ...roots().filter((root) => root !== document && descendantOf(root.host, scope)),
    ];
    return [
      ...new Set([
        ...(scope.matches(query) ? [scope] : []),
        ...scopedRoots.flatMap((root) => [...root.querySelectorAll(query)]),
      ]),
    ];
  }
  function renderedText(node) {
    return node && visible(node) ? node.innerText || '' : '';
  }
  function textWithin(scope) {
    return [
      renderedText(scope),
      ...roots()
        .filter((root) => root !== document && descendantOf(root.host, scope))
        .flatMap((root) => [...root.children].map(renderedText)),
    ]
      .filter(Boolean)
      .join('\n');
  }
  function find(selector) {
    const matches = roots().flatMap((root) => [...root.querySelectorAll(selector)]);
    if (matches.length !== 1)
      throw new Error(
        `SELECTOR_AMBIGUOUS: Expected one element, found ${matches.length}. Refresh snapshot or use a unique selector.`,
      );
    return matches[0];
  }
  function visible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node = el; node; node = node.parentElement || node.getRootNode()?.host) {
      const style = computedStyle(node);
      if (
        style.visibility === 'hidden' ||
        style.display === 'none' ||
        style.opacity === '0' ||
        node.hasAttribute('inert') ||
        node.getAttribute('aria-hidden') === 'true'
      )
        return false;
    }
    return true;
  }
  function element(input = args) {
    for (const condition of input.preconditions || []) element(condition);
    let el;
    if (input.ref) {
      const state = globalThis[stateKey];
      el = state?.elements.get(input.ref);
      if (!el?.isConnected || state.url !== location.href)
        throw new Error('STALE_REF: Refresh browser_snapshot before acting.');
    } else if (input.selector) el = find(input.selector);
    else throw new Error('A ref or unique selector is required');
    if (!visible(el)) throw new Error('ELEMENT_HIDDEN: Element is not visible');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true')
      throw new Error('ELEMENT_DISABLED');
    if (input.expected) {
      const guard = input.expected;
      if (
        label(el) !== guard.name ||
        (guard.contextText !== undefined && localContext(el).text !== guard.contextText) ||
        (guard.value !== undefined && el.value !== guard.value) ||
        (guard.checked !== undefined && el.checked !== guard.checked)
      )
        throw new Error('TARGET_CHANGED: Observed target context changed before input.');
    }
    return el;
  }
  function localContext(el) {
    const region =
      el.closest('tr,[role="row"],section,fieldset,article,form,[role="dialog"],main') ||
      el.parentElement ||
      el.getRootNode()?.host;
    return {
      heading:
        region?.querySelector('h1,h2,h3,h4,legend,[role="heading"]')?.innerText?.slice(0, 160) ||
        '',
      text: textWithin(region).slice(0, 360),
    };
  }
  function semanticRole(el) {
    const explicit = el.getAttribute('role')?.split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'INPUT')
      return (
        {
          checkbox: 'checkbox',
          radio: 'radio',
          range: 'slider',
          number: 'spinbutton',
          search: 'searchbox',
          submit: 'button',
          button: 'button',
          reset: 'button',
        }[el.type] || 'textbox'
      );
    return null;
  }
  function labelText(node) {
    // A select nested inside its label contributes option text to innerText;
    // those options are not part of the control's accessible name.
    const clone = node.cloneNode(true);
    for (const control of clone.querySelectorAll('input,select,textarea,button,script,style'))
      control.remove();
    return clone.textContent || '';
  }
  function label(el) {
    return (
      el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .map(
          (id) =>
            el.getRootNode().getElementById?.(id)?.innerText ||
            document.getElementById(id)?.innerText ||
            '',
        )
        .join(' ')
        .trim() ||
      (el.labels?.[0] ? labelText(el.labels[0]) : '') ||
      el.getAttribute('placeholder') ||
      el.innerText ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('name') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
  }
  try {
    if (operation === 'snapshot') {
      const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      const elements = new Map();
      const output = [];
      const interactive =
        'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="combobox"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
      const seen = new Set();
      const allRoots = roots();
      const scope = args.scopeSelector ? find(args.scopeSelector) : null;
      const inScope = (el) => !scope || descendantOf(el, scope);
      function inViewport(el) {
        let r = el.getBoundingClientRect();
        let left = Math.max(0, r.left),
          top = Math.max(0, r.top);
        let right = Math.min(innerWidth, r.right),
          bottom = Math.min(innerHeight, r.bottom);
        for (
          let parent = el.parentElement || el.getRootNode()?.host;
          parent;
          parent = parent.parentElement || parent.getRootNode()?.host
        ) {
          const style = computedStyle(parent);
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            r = parent.getBoundingClientRect();
            left = Math.max(left, r.left);
            right = Math.min(right, r.right);
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            r = parent.getBoundingClientRect();
            top = Math.max(top, r.top);
            bottom = Math.min(bottom, r.bottom);
          }
          if (right <= left || bottom <= top) return false;
        }
        return right > left && bottom > top;
      }
      const candidates = [];
      const controls = scope
        ? scopedElements(scope, interactive)
        : allRoots.flatMap((root) => [...root.querySelectorAll(interactive)]);
      for (const el of controls) {
        if (seen.has(el)) continue;
        if (args.role && semanticRole(el) !== args.role) continue;
        if (args.nameContains && !label(el).toLowerCase().includes(args.nameContains.toLowerCase()))
          continue;
        if (!visible(el)) continue;
        seen.add(el);
        if (!inScope(el)) continue;
        const onScreen = inViewport(el);
        if (args.viewportOnly && !onScreen) continue;
        candidates.push({ el, onScreen });
      }
      // Apply the cap after viewport prioritization, so a large navigation list
      // cannot consume every ref before the agent reaches the main form.
      candidates.sort((a, b) => Number(b.onScreen) - Number(a.onScreen));
      for (const { el, onScreen } of candidates.slice(0, args.maxElements ?? 150)) {
        const ref = `${nonce}:${output.length + 1}`;
        elements.set(ref, el);
        const r = el.getBoundingClientRect();
        const secret = el.type === 'password' || /^(cc-|one-time-code)/.test(el.autocomplete ?? '');
        const item = {
          ref,
          tag: el.tagName.toLowerCase(),
          role: semanticRole(el),
          name: label(el),
          type: el.type,
          value: secret
            ? '[REDACTED]'
            : typeof el.value === 'string'
              ? el.value.slice(0, 500)
              : undefined,
          checked:
            el.getAttribute('aria-checked') !== null
              ? el.getAttribute('aria-checked') === 'true'
              : el.checked,
          disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
          href: el.href,
          options:
            el.tagName === 'SELECT'
              ? [...el.options].slice(0, 100).map((o) => ({
                  value: o.value,
                  label: o.label,
                  selected: o.selected,
                  ...(o.disabled || o.parentElement.disabled ? { disabled: true } : {}),
                }))
              : undefined,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          inViewport: onScreen,
        };
        if (el.readOnly) item.readOnly = true;
        if (args.includeContext) {
          item.context = localContext(el);
        }
        if (args.compact !== false) {
          delete item.rect;
          if (!item.role) delete item.role;
          if (!item.type || item.type === 'submit' || item.type === 'button') delete item.type;
          if (item.value === '') delete item.value;
          if (item.disabled === false) delete item.disabled;
          if (item.inViewport === true) delete item.inViewport;
        }
        output.push(item);
      }
      globalThis[stateKey] = { elements, url: location.href };
      const main = scope || document.querySelector('main,[role="main"]');
      const mainText = main ? textWithin(main) : '';
      const bodyText = allRoots
        .map((root) =>
          root === document
            ? document.body?.innerText || ''
            : [...root.children]
                .filter(visible)
                .map((el) => el.innerText || '')
                .join('\n'),
        )
        .join('\n');
      const allText = scope
        ? mainText
        : mainText
          ? `${mainText}\n\n${bodyText.replace(mainText, '')}`
          : bodyText;
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
        text: allText.slice(0, args.maxText),
        truncated: allText.length > args.maxText,
        elements: output,
        elementLimitReached: candidates.length > (args.maxElements ?? 150),
        totalElements: candidates.length,
        observation: {
          compact: args.compact !== false,
          scope: args.scopeSelector || 'page',
          viewportOnly: !!args.viewportOnly,
          ...(args.role || args.nameContains
            ? { query: { role: args.role, nameContains: args.nameContains } }
            : {}),
        },
        trust: 'UNTRUSTED_WEBPAGE_DATA',
      };
    }
    if (operation === 'extract') {
      const scope = find(args.scopeSelector || 'body');
      const base = {
        url: location.href,
        title: document.title,
        kind: args.kind,
        trust: 'UNTRUSTED_WEBPAGE_DATA',
      };
      if (args.kind === 'text') {
        const text = textWithin(scope);
        return {
          ...base,
          text: text.slice(0, args.maxText),
          truncated: text.length > args.maxText,
        };
      }
      const query =
        args.kind === 'links'
          ? 'a[href]'
          : args.kind === 'images'
            ? 'img'
            : 'table,[role="table"],[role="grid"]';
      const nodes = scopedElements(scope, query).filter(visible);
      if (args.kind === 'links')
        return {
          ...base,
          items: nodes.slice(0, args.maxItems).map((el) => ({
            text: label(el),
            url: /^https?:/.test(el.href) ? el.href : '[non-HTTP link]',
          })),
          truncated: nodes.length > args.maxItems,
        };
      if (args.kind === 'images')
        return {
          ...base,
          items: nodes.slice(0, args.maxItems).map((el) => ({
            alt: el.alt.slice(0, 500),
            url: /^https?:/.test(el.currentSrc || el.src)
              ? el.currentSrc || el.src
              : '[inline or non-HTTP image]',
            loaded: el.complete && el.naturalWidth > 0,
            width: el.naturalWidth,
            height: el.naturalHeight,
          })),
          truncated: nodes.length > args.maxItems,
        };
      let remaining = args.maxItems,
        remainingText = args.maxText,
        truncated = nodes.length > 10;
      const tables = nodes.slice(0, 10).map((table) => {
        const allRows = [...table.querySelectorAll('tr,[role="row"]')].filter(
          (row) => visible(row) && row.closest('table,[role="table"],[role="grid"]') === table,
        );
        const rows = allRows.slice(0, remaining).map((row) => {
          const cells = row.cells
            ? [...row.cells]
            : [
                ...row.querySelectorAll(
                  ':scope > [role="cell"],:scope > [role="gridcell"],:scope > [role="columnheader"],:scope > [role="rowheader"]',
                ),
              ];
          if (cells.length > 30) truncated = true;
          return cells.slice(0, 30).map((cell) => {
            const text = renderedText(cell);
            const value = text.slice(0, Math.min(1000, remainingText));
            if (value.length < text.length) truncated = true;
            remainingText -= value.length;
            return value;
          });
        });
        if (allRows.length > rows.length) truncated = true;
        remaining -= rows.length;
        return {
          caption:
            table.caption?.innerText?.slice(0, 240) || table.getAttribute('aria-label') || '',
          rows,
        };
      });
      return { ...base, tables, truncated };
    }
    function validateField(field) {
      const el = element(field);
      if (field.kind === 'text') {
        if (
          !/^(INPUT|TEXTAREA)$/.test(el.tagName) ||
          (el.tagName === 'INPUT' &&
            !['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(el.type)) ||
          el.readOnly
        )
          throw new Error('FORM_FIELD_TYPE: Text field must be a writable text input or textarea.');
      } else if (field.kind === 'select') {
        if (
          el.tagName !== 'SELECT' ||
          el.multiple ||
          ![...el.options].some(
            (o) => o.value === field.value && !o.disabled && !o.parentElement.disabled,
          )
        )
          throw new Error('FORM_FIELD_OPTION: Native single select option is unavailable.');
      } else if (el.tagName !== 'INPUT' || el.type !== 'checkbox')
        throw new Error('FORM_FIELD_TYPE: Check field must be a native checkbox.');
      return el;
    }
    if (operation === 'form_preflight') {
      const nodes = args.fields.map(validateField);
      if (new Set(nodes).size !== nodes.length)
        throw new Error('FORM_DUPLICATE: Multiple fields target the same element.');
      const state = (globalThis[stateKey] ||= { elements: new Map(), url: location.href });
      // Plan refs preserve actual nodes, so a framework replacement cannot silently retarget input.
      const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      return {
        targets: nodes.map((el, index) => {
          const ref = `${nonce}:form:${index}`;
          state.elements.set(ref, el);
          return { ref };
        }),
      };
    }
    if (operation === 'form_validate' || operation === 'form_verify') {
      const el = validateField(args);
      const matches =
        args.kind === 'check'
          ? el.checked === args.value
          : el.value === args.value.replace(/\r\n/g, '\n');
      return operation === 'form_verify'
        ? { matches }
        : { checked: args.kind === 'check' ? el.checked : undefined, matches };
    }
    if (operation === 'wait') {
      const scope = args.scopeSelector ? find(args.scopeSelector) : document.body;
      let ready = true;
      if (args.selector) {
        const matches = scope ? scopedElements(scope, args.selector) : [];
        if (matches.length > 1)
          throw new Error(
            'SELECTOR_AMBIGUOUS: Wait selector must match one element. Narrow its scope.',
          );
        const el = matches[0];
        ready =
          args.condition === 'attached'
            ? !!el
            : args.condition === 'detached'
              ? !el
              : args.condition === 'hidden'
                ? !el || !visible(el)
                : !!el && visible(el);
      }
      if (args.text) ready &&= !!scope && textWithin(scope).includes(args.text);
      if (args.selector || args.text) return { ready };
      return {
        ready:
          args.state === 'domcontentloaded'
            ? document.readyState !== 'loading'
            : document.readyState === 'complete',
      };
    }
    if (operation === 'select') {
      const el = element();
      if (el.tagName !== 'SELECT')
        throw new Error('Use browser_click/type for custom select widgets');
      if (
        ![...el.options].some(
          (o) => o.value === args.value && !o.disabled && !o.parentElement.disabled,
        )
      )
        throw new Error('Option not found or disabled');
      el.value = args.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: el.value };
    }
    if (operation === 'scroll') {
      element().scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return { scrolled: true };
    }
    const el = element();
    if (operation === 'focus' && !(el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName)))
      throw new Error('ELEMENT_NOT_EDITABLE');
    if (operation === 'focus' && (el.readOnly || el.type === 'file'))
      throw new Error('ELEMENT_NOT_EDITABLE');
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    function checkedPoint() {
      const rect = el.getBoundingClientRect();
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
      const y = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
      const hit = el.getRootNode().elementFromPoint(x, y);
      if (hit && hit !== el && !el.contains(hit))
        throw new Error(
          'ELEMENT_OCCLUDED: Another element covers this target. Refresh screenshot.',
        );
      return { x, y };
    }
    let { x, y } = checkedPoint();
    if (operation === 'focus') {
      el.focus();
      if (!el.isConnected || (!el.isContentEditable && el.getRootNode().activeElement !== el))
        throw new Error(
          'ELEMENT_FOCUS_CHANGED: Focus handler replaced or redirected the target. Inspect before typing.',
        );
      ({ x, y } = checkedPoint());
    }
    return {
      x,
      y,
      name: label(el),
      tag: el.tagName.toLowerCase(),
      ...(operation === 'focus' ? { empty: typeof el.value === 'string' && el.value === '' } : {}),
    };
  } catch (error) {
    return { error: error.message };
  }
}
